"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");
const store = require("../src/lib/provider-switch/store");
const diagnostics = require("../src/lib/provider-switch/diagnostics");
const { switchProvider, handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
let dir, home, profile;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-diagnostic-")); home = process.env.HOME; profile = process.env.USERPROFILE; process.env.HOME = dir; process.env.USERPROFILE = dir; });
afterEach(async () => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; if (profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = profile; await fs.rm(dir, { recursive: true, force: true }); });
async function create() {
  return store.createProvider("claude", { name: "Fixture", category: "custom", settingsConfig: { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:19000", ANTHROPIC_AUTH_TOKEN: "private-test-secret", ANTHROPIC_MODEL: "fixture-model" } } });
}
async function call(endpoint, payload, authorized = true) {
  const req = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []); req.method = payload ? "POST" : "GET"; req.headers = {};
  let status, data;
  const res = { writeHead(code) { status = code; }, end(raw) { data = JSON.parse(raw); } };
  await handleProviderSwitchApiRequest(req, res, new URL(endpoint, "http://localhost"), { isAuthorizedLocalMutation: () => authorized });
  return { status, data };
}
test("receipts track projected fields and ignore user fields without duplicating credentials", async () => {
  const provider = await create();
  assert.equal((await diagnostics.inspect("claude")).status, "unwired");
  await store.setCurrentProvider("claude", provider.id);
  assert.equal((await diagnostics.inspect("claude")).status, "unverified");
  await switchProvider({ app: "claude", id: provider.id });
  assert.equal((await diagnostics.inspect("claude")).status, "applied");
  const file = path.join(dir, ".claude/settings.json");
  const live = JSON.parse(await fs.readFile(file)); live.permissions = { allow: ["Read"] }; await fs.writeFile(file, JSON.stringify(live));
  assert.equal((await diagnostics.inspect("claude")).status, "applied");
  live.env.ANTHROPIC_MODEL = "user-model"; await fs.writeFile(file, JSON.stringify(live));
  const changed = await diagnostics.inspect("claude");
  assert.equal(changed.status, "replaced"); assert.equal(changed.differences[0].field, "env.ANTHROPIC_MODEL");
  const raw = await fs.readFile(path.join(dir, ".aitool/provider-switch/projection-receipts.json"), "utf8");
  assert.ok(!raw.includes("private-test-secret"));
  assert.ok(!JSON.stringify(changed).includes("private-test-secret"));
});
test("repair previews the real projection, rejects stale revisions, then preserves user fields", async () => {
  const provider = await create(); await switchProvider({ app: "claude", id: provider.id });
  const file = path.join(dir, ".claude/settings.json");
  const live = JSON.parse(await fs.readFile(file)); live.env.ANTHROPIC_MODEL = "other"; live.permissions = { allow: ["Read"] }; await fs.writeFile(file, JSON.stringify(live));
  const preview = await call("/api/provider-switch/diagnostics/preview", { app: "claude" });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(JSON.parse(preview.data.files[0].after).env.ANTHROPIC_MODEL, "fixture-model");
  live.permissions.allow.push("Edit"); await fs.writeFile(file, JSON.stringify(live));
  const stale = await call("/api/provider-switch/diagnostics/repair", { app: "claude", revision: preview.data.revision });
  assert.equal(stale.status, 409); assert.equal(JSON.parse(await fs.readFile(file)).env.ANTHROPIC_MODEL, "other");
  const fresh = await call("/api/provider-switch/diagnostics/preview", { app: "claude" });
  const repaired = await call("/api/provider-switch/diagnostics/repair", { app: "claude", revision: fresh.data.revision });
  assert.equal(repaired.status, 200); assert.equal((await diagnostics.inspect("claude")).status, "applied");
  assert.deepEqual(JSON.parse(await fs.readFile(file)).permissions.allow, ["Read", "Edit"]);
});
test("a broken live file is diagnosed and never overwritten by repair", async () => {
  const provider = await create(); await switchProvider({ app: "claude", id: provider.id });
  const file = path.join(dir, ".claude/settings.json"); await fs.writeFile(file, "{broken");
  assert.equal((await diagnostics.inspect("claude")).status, "invalid");
  assert.equal((await call("/api/provider-switch/diagnostics/preview", { app: "claude" })).status, 400);
  assert.equal(await fs.readFile(file, "utf8"), "{broken");
});
test("endpoint probes send no credentials and distinguish reachability from successful auth", async () => {
  const provider = await create(); await switchProvider({ app: "claude", id: provider.id });
  let seen;
  const probe = await diagnostics.probeEndpoint("claude", { fetchImpl: async (url, options) => { seen = { url: String(url), ...options }; return new Response(null, { status: 401 }); } });
  assert.equal(probe.status, "reachable"); assert.equal(probe.httpStatus, 401); assert.equal(seen.method, "HEAD"); assert.equal(seen.headers, undefined);
});
test("probe, preview and repair require local mutation authorization", async () => {
  for (const endpoint of ["probe", "preview", "repair"]) {
    const result = await call(`/api/provider-switch/diagnostics/${endpoint}`, { app: "claude" }, false); assert.equal(result.status, 401);
  }
});
