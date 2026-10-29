"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
async function invoke(handler, route, method = "GET", body = {}, authorized = true) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = { "content-type": "application/json" };
  let status, payload;
  const res = { writeHead: code => { status = code; }, setHeader() {}, end: data => { payload = JSON.parse(data); } };
  assert.equal(await handler(req, res, new URL(route, "http://localhost"), { isAuthorizedLocalMutation: () => authorized }), true);
  return { status, body: payload };
}
test("new account, Hub and native config mutations reject unauthenticated requests before side effects", async t => {
  const accounts = require("../src/lib/provider-switch/claude-accounts");
  t.mock.method(accounts, "manager", () => { throw new Error("must not discover accounts"); });
  const handler = require("../src/lib/provider-switch/api").handleProviderSwitchApiRequest;
  for (const [route, method] of [["claude/accounts", "GET"], ["claude/accounts/login", "POST"], ["mcp/hub", "GET"], ["mcp/hub", "POST"], ["codex/subagents", "PUT"]]) {
    assert.equal((await invoke(handler, `/api/provider-switch/${route}`, method, {}, false)).status, 401);
  }
  const management = require("../src/lib/proxy/management");
  t.mock.method(management, "request", () => { throw new Error("must not refresh"); });
  assert.equal((await invoke(require("../src/lib/proxy/api").handleProxyApiRequest, "/api/proxy/models/refresh", "POST", {}, false)).status, 401);
});
test("native subagent API round-trips a revision and reports an outside edit as a conflict", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-native-api-")), old = process.env.HOME, oldCodex = process.env.CODEX_HOME;
  process.env.HOME = home; process.env.CODEX_HOME = path.join(home, ".codex");
  t.after(async () => { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex; await fs.rm(home, { recursive: true, force: true }); });
  const handler = require("../src/lib/provider-switch/api").handleProviderSwitchApiRequest, route = "/api/provider-switch/codex/subagents";
  const initial = await invoke(handler, route);
  assert.equal(initial.status, 200);
  const next = await invoke(handler, route, "PUT", { config: { ...initial.body.config, maxConcurrentThreadsPerSession: 4 }, revision: initial.body.revision });
  assert.equal(next.status, 200); assert.equal(next.body.config.maxConcurrentThreadsPerSession, 4);
  const file = path.join(home, ".codex", "config.toml"); await fs.appendFile(file, "# outside\n");
  const conflict = await invoke(handler, route, "PUT", { config: next.body.config, revision: next.body.revision });
  assert.equal(conflict.status, 409); assert.ok((await fs.readFile(file, "utf8")).endsWith("# outside\n"));
});
test("authenticated Claude account API uses only the selected account for quota and launch", async t => {
  const calls = [], accounts = require("../src/lib/provider-switch/claude-accounts");
  t.mock.method(accounts, "manager", () => ({ status: async () => ({ accounts: [{ id: "fixture:org" }] }), quota: async id => { calls.push(id); return { tiers: [] }; }, launch: async id => { calls.push(id); return { launched: true }; } }));
  const handler = require("../src/lib/provider-switch/api").handleProviderSwitchApiRequest;
  assert.equal((await invoke(handler, "/api/provider-switch/claude/accounts")).body.accounts[0].id, "fixture:org");
  assert.equal((await invoke(handler, "/api/provider-switch/claude/accounts/quota?id=fixture%3Aorg")).status, 200);
  assert.equal((await invoke(handler, "/api/provider-switch/claude/accounts/launch", "POST", { id: "fixture:org" })).body.launched, true);
  assert.deepEqual(calls, ["fixture:org", "fixture:org"]);
});
test("manual model refresh reports partial success and older-core support independently", async t => {
  const management = require("../src/lib/proxy/management"), calls = [];
  t.mock.method(management, "request", async (method, route, options) => { calls.push({ method, route, options }); return route.includes("routing") ? { ok: false, status: 404, data: { error: "old core" } } : { ok: true, status: 200, data: { refreshed: 3 } }; });
  const result = await invoke(require("../src/lib/proxy/api").handleProxyApiRequest, "/api/proxy/models/refresh", "POST");
  assert.equal(result.status, 200); assert.equal(result.body.results[0].ok, true); assert.equal(result.body.results[1].unsupported, true);
  assert.equal(calls.length, 2); assert.ok(calls.every(row => row.method === "POST" && row.options.timeoutMs === 60000));
});
