"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test, beforeEach, afterEach } = require("node:test");
const checker = require("../src/lib/provider-switch/mcp-check");
const mcp = require("../src/lib/provider-switch/mcp");
const refs = require("../src/lib/provider-switch/mcp-envrefs");
const { parse } = require("smol-toml");
const YAML = require("yaml");
let dir, oldHome, oldProfile;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-mcp-check-"));
  oldHome = process.env.HOME; oldProfile = process.env.USERPROFILE;
  process.env.HOME = dir; process.env.USERPROFILE = dir;
});
afterEach(async () => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  await fs.rm(dir, { recursive: true, force: true });
});
const init = { protocolVersion: "2025-03-26", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } };
const reply = (message, result) => ({ jsonrpc: "2.0", id: message.id, result });
function tools(message) {
  return message.params?.cursor ? { tools: [{ name: "second", description: "Second tool" }] }
    : { tools: [{ name: "first", description: "First tool" }], nextCursor: "page-2" };
}
async function serve(t, handler) {
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function body(req) { let text = ""; for await (const chunk of req) text += chunk; return JSON.parse(text); }
async function stdioRow(id, source) {
  const file = path.join(dir, `${id}.cjs`); await fs.writeFile(file, source);
  return { id, server: { command: process.execPath, args: [file] } };
}

test("stdio completes initialize, notification and paginated tools; closes its process", async () => {
  const row = await stdioRow("stdio", `
    const readline = require('node:readline');
    let initialized = false;
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method === 'notifications/initialized') { initialized = true; return; }
      const result = msg.method === 'initialize' ? ${JSON.stringify(init)} : initialized
        ? (msg.params.cursor ? { tools: [{ name: 'second' }] } : { tools: [{ name: 'first' }], nextCursor: 'next' }) : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    });
  `);
  const result = await checker.checkServer(row, { timeoutMs: 1000 });
  assert.equal(result.status, "healthy");
  assert.deepEqual(result.tools.map(tool => tool.name), ["first", "second"]);
  assert.equal(checker.snapshot(row).status, "healthy");
  assert.equal(checker.snapshot({ ...row, server: { ...row.server, env: { VERSION: "changed" } } }).status, "stale");
});

test("stdio cancellation and per-stage timeout terminate stalled servers", async () => {
  const row = await stdioRow("stall", "setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const checking = checker.checkServer(row, { signal: controller.signal, timeoutMs: 1000, onStage(stage) { if (stage === "initialize") controller.abort(); } });
  assert.equal((await checking).status, "cancelled");
  const timed = await checker.checkServer(row, { timeoutMs: 80 });
  assert.equal(timed.status, "failed"); assert.equal(timed.reason, "timeout"); assert.equal(timed.stage, "initialize");
});

test("streamable HTTP sends session and negotiated version, paginates and deletes session", async t => {
  const seen = [];
  const url = await serve(t, async (req, res) => {
    seen.push({ method: req.method, session: req.headers["mcp-session-id"], version: req.headers["mcp-protocol-version"] });
    if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
    const message = await body(req);
    if (!message.id) { res.writeHead(202); res.end(); return; }
    res.setHeader("Mcp-Session-Id", "test-session");
    if (message.method === "initialize") {
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reply(message, { ...init, protocolVersion: "2024-11-05" })));
    } else {
      res.setHeader("content-type", "text/event-stream");
      res.write(`event: message\r\ndata: ${JSON.stringify(reply(message, tools(message)))}\r\n\r\n`);
    }
  });
  const result = await checker.checkServer({ id: "http", server: { url } }, { timeoutMs: 1000 });
  assert.equal(result.status, "healthy"); assert.equal(result.tools.length, 2);
  assert.ok(seen.slice(1).every(item => item.session === "test-session" && item.version === "2024-11-05"));
  assert.equal(seen.at(-1).method, "DELETE");
});

test("legacy SSE accepts same-origin endpoint and closes stream", async t => {
  let stream;
  const url = await serve(t, async (req, res) => {
    if (req.method === "GET") {
      stream = res; res.setHeader("content-type", "text/event-stream"); res.write("event: endpoint\ndata: /messages?session=fixture\n\n"); return;
    }
    const message = await body(req);
    res.writeHead(202); res.end();
    if (message.id) stream.write(`event: message\ndata: ${JSON.stringify(reply(message, message.method === "initialize" ? init : tools(message)))}\n\n`);
  });
  const result = await checker.checkServer({ id: "sse", server: { type: "sse", url } }, { timeoutMs: 1000 });
  assert.equal(result.status, "healthy"); assert.equal(result.tools.length, 2);
});

test("SSE refuses cross-origin credential forwarding and missing endpoints", async t => {
  let posts = 0;
  const url = await serve(t, async (req, res) => {
    if (req.method === "POST") posts++;
    res.setHeader("content-type", "text/event-stream");
    res.end(req.url === "/empty" ? "" : "event: endpoint\ndata: http://example.invalid/messages\n\n");
  });
  const result = await checker.checkServer({ id: "unsafe", server: { type: "sse", url } }, { timeoutMs: 200 });
  assert.equal(result.reason, "endpoint");
  const empty = await checker.checkServer({ id: "empty", server: { type: "sse", url: url + "/empty" } }, { timeoutMs: 200 });
  assert.equal(empty.reason, "exited"); assert.equal(posts, 0);
});

test("HTTP errors are classified without exposing server text or secrets", async t => {
  const url = await serve(t, async (_req, res) => { res.writeHead(401); res.end("secret-key leaked by server"); });
  const result = await checker.checkServer({ id: "denied", server: { url, headers: { Authorization: "Bearer secret-key" } } }, { timeoutMs: 200 });
  assert.equal(result.reason, "authorization"); assert.ok(!JSON.stringify(result).includes("secret-key"));
});

test("repeated cursors fail; missing env refs never reach the network", async t => {
  let calls = 0;
  const url = await serve(t, async (req, res) => {
    calls++; const message = await body(req);
    if (!message.id) { res.writeHead(202); res.end(); return; }
    res.end(JSON.stringify(reply(message, message.method === "initialize" ? init : { tools: [], nextCursor: "same" })));
  });
  const result = await checker.checkServer({ id: "pages", server: { url } }, { timeoutMs: 200 });
  assert.equal(result.reason, "pagination");
  const before = calls;
  const missing = await checker.checkServer({ id: "env", server: { url, headers: { Authorization: "Bearer ${TEST_MISSING}" } } }, { env: {} });
  assert.equal(missing.reason, "environment"); assert.equal(calls, before);
});

test("environment references project and round-trip without expanding credentials", async () => {
  const spec = { url: "https://example.test", headers: { Authorization: "Bearer ${TOKEN}", "x-api": "${KEY}" } };
  const codex = refs.projectReferences("codex", spec);
  assert.equal(codex.bearer_token_env_var, "TOKEN"); assert.deepEqual(codex.env_http_headers, { "x-api": "KEY" });
  assert.deepEqual(refs.importReferences("codex", codex).headers, spec.headers);
  const opencode = refs.projectReferences("opencode", spec);
  assert.equal(opencode.headers.Authorization, "Bearer {env:TOKEN}"); assert.deepEqual(refs.importReferences("opencode", opencode), spec);
  assert.throws(() => refs.projectReferences("agy", spec), /cannot safely/);
  assert.throws(() => refs.projectReferences("codex", { command: "node", env: { RENAMED: "${TOKEN}" } }), /own name/);
  assert.throws(() => refs.projectReferences("codex", { url: "https://example.test/${HOST}" }), /cannot interpolate/);
});

test("native tool rules preserve user denies across disable, enable and sync", async t => {
  for (const subdir of [".claude", ".codex", ".gemini", ".config/opencode", ".hermes"]) await fs.mkdir(path.join(dir, subdir), { recursive: true });
  const files = mcp.mcpLiveFiles();
  await fs.writeFile(path.join(dir, ".claude/settings.json"), JSON.stringify({ permissions: { deny: ["mcp__rules__first", "Bash(rm *)"] } }));
  await fs.writeFile(files.codex.path, '[mcp_servers.rules]\ncommand = "node"\ndisabled_tools = ["first", "user_tool"]\n');
  await fs.writeFile(files.gemini.path, JSON.stringify({ mcpServers: { rules: { command: "node", excludeTools: ["first", "user_tool"] } } }));
  await fs.writeFile(files.opencode.path, JSON.stringify({ tools: { rules_first: false, user_tool: false } }));
  await fs.writeFile(files.hermes.path, YAML.stringify({ mcp_servers: { rules: { command: "node", tools: { exclude: ["first", "user_tool"], include: ["first", "second"] } } } }));
  const url = await serve(t, async (req, res) => {
    const message = await body(req);
    if (!message.id) { res.writeHead(202); res.end(); return; }
    res.end(JSON.stringify(reply(message, message.method === "initialize" ? init : { tools: [{ name: "first" }, { name: "second" }] })));
  });
  await mcp.upsertServer({ id: "rules", server: { url }, apps: { claude: true, codex: true, gemini: true, opencode: true, hermes: true } });
  const row = (await mcp.listServers())[0]; const check = await checker.checkServer(row, { timeoutMs: 1000 });
  for (const app of ["claude", "codex", "gemini", "opencode", "hermes"]) {
    assert.deepEqual((await mcp.toggleServerTool("rules", app, "second", false, check.revision)).failures, []);
    assert.deepEqual((await mcp.toggleServerTool("rules", app, "first", false, check.revision)).failures, []);
  }
  assert.deepEqual((await mcp.syncServers()).failures, []);
  assert.deepEqual(YAML.parse(await fs.readFile(files.hermes.path, "utf8")).mcp_servers.rules.tools, {
    exclude: ["first", "user_tool", "second"], include: ["first", "second"],
  });
  for (const app of ["claude", "codex", "gemini", "opencode", "hermes"]) {
    await mcp.toggleServerTool("rules", app, "second", true, check.revision);
    await mcp.toggleServerTool("rules", app, "first", true, check.revision);
  }
  const claude = JSON.parse(await fs.readFile(path.join(dir, ".claude/settings.json")));
  assert.deepEqual(claude.permissions.deny, ["mcp__rules__first", "Bash(rm *)"]);
  assert.deepEqual(parse(await fs.readFile(files.codex.path, "utf8")).mcp_servers.rules.disabled_tools, ["first", "user_tool"]);
  assert.deepEqual(JSON.parse(await fs.readFile(files.gemini.path)).mcpServers.rules.excludeTools, ["first", "user_tool"]);
  assert.deepEqual(JSON.parse(await fs.readFile(files.opencode.path)).tools, { rules_first: false, user_tool: false });
  assert.deepEqual(YAML.parse(await fs.readFile(files.hermes.path, "utf8")).mcp_servers.rules.tools, { exclude: ["first", "user_tool"], include: ["first", "second"] });
  await assert.rejects(mcp.toggleServerTool("rules", "codex", "second", false, "old"), /check the server/);
  await assert.rejects(mcp.toggleServerTool("rules", "pi", "second", false, check.revision), /not supported/);
});

test("Hermes projects a new tool exclusion and clears its final owned rule", async t => {
  await fs.mkdir(path.join(dir, ".hermes"));
  const url = await serve(t, async (req, res) => {
    const message = await body(req);
    if (!message.id) { res.writeHead(202); res.end(); return; }
    res.end(JSON.stringify(reply(message, message.method === "initialize" ? init : { tools: [{ name: "first" }] })));
  });
  await mcp.upsertServer({ id: "fresh", server: { url }, apps: { hermes: true } });
  const checked = await checker.checkServer((await mcp.listServers())[0], { timeoutMs: 1000 });
  const readTools = async () => YAML.parse(await fs.readFile(mcp.mcpLiveFiles().hermes.path, "utf8")).mcp_servers.fresh.tools;
  assert.deepEqual((await mcp.toggleServerTool("fresh", "hermes", "first", false, checked.revision)).failures, []);
  assert.deepEqual(await readTools(), { exclude: ["first"] });
  assert.deepEqual((await mcp.syncServers()).failures, []);
  assert.deepEqual(await readTools(), { exclude: ["first"] });
  assert.deepEqual((await mcp.toggleServerTool("fresh", "hermes", "first", true, checked.revision)).failures, []);
  assert.equal(await readTools(), undefined);
  assert.deepEqual((await mcp.syncServers()).failures, []);
  assert.equal(await readTools(), undefined);
});
