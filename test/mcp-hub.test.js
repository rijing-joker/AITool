"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { createHub } = require("../src/lib/provider-switch/mcp-hub");
test("Hub shares on-demand upstreams, namespaces and enforces fresh tool filters, then stops idle/disabled connections", async t => {
  let on = true, starts = 0, stops = 0; const calls = [];
  const rows = [{ id: "echo", apps: { codex: true }, server: { command: "fixture" }, disabledTools: { codex: ["secret"] } }];
  const hub = createHub({ listServers: async () => rows, enabled: async () => on, idleMs: 100, connect: async () => {
    starts++; return { send: async message => { calls.push(message); if (message.id === undefined) return; return { jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} } } : message.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object" } }, { name: "secret", inputSchema: {} }] } : { content: [{ type: "text", text: message.params.arguments.value }] } }; }, close: async () => { stops++; } };
  } }); t.after(() => hub.close());
  await hub.request("codex", { method: "initialize" }); assert.equal(starts, 0);
  assert.deepEqual((await hub.request("codex", { method: "tools/list" })).tools.map(tool => tool.name), ["echo__echo"]);
  for (let i = 0; i < 2; i++) assert.equal((await hub.request("codex", { method: "tools/call", params: { name: "echo__echo", arguments: { value: "private-body" } } })).content[0].text, "private-body");
  assert.equal(starts, 1); assert.equal(calls.filter(message => message.method === "tools/call").length, 2);
  rows[0].disabledTools.codex.push("echo");
  await assert.rejects(hub.request("codex", { method: "tools/call", params: { name: "echo__echo" } }), /disabled/);
  assert.equal(calls.filter(message => message.method === "tools/call").length, 2);
  on = false; await hub.prune(); assert.equal(hub.activeConnections(), 0); assert.ok(stops > 0);
});
test("Hub native projection restores entries and retains outside edits as recoverable conflicts", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-hub-")), old = process.env.HOME; process.env.HOME = home;
  t.after(async () => { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; await fs.rm(home, { recursive: true, force: true }); });
  const mcp = require("../src/lib/provider-switch/mcp"), config = require("../src/lib/provider-switch/mcp-hub-config");
  const file = mcp.mcpLiveFiles().claude.path;
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify({ mcpServers: { own: { command: "keep" } }, theme: "light" }));
  await mcp.upsertServer({ id: "echo", server: { command: "fixture" }, apps: { claude: true } });
  let result = await config.setEnabled(true, 12345); assert.deepEqual(result.failures, []);
  let live = JSON.parse(await fs.readFile(file)); assert.ok(live.mcpServers["aitool-hub"]); assert.equal(live.mcpServers.echo, undefined); assert.ok(live.mcpServers.own);
  await mcp.upsertServer({ id: "extra", server: { command: "extra" }, apps: { claude: true } });
  live = JSON.parse(await fs.readFile(file)); assert.equal(live.mcpServers.extra, undefined);
  result = await config.setEnabled(false, 12345); assert.deepEqual(result.failures, []);
  live = JSON.parse(await fs.readFile(file)); assert.ok(live.mcpServers.echo); assert.ok(live.mcpServers.extra); assert.equal(live.mcpServers["aitool-hub"], undefined);
  await config.setEnabled(true, 12345); live = JSON.parse(await fs.readFile(file)); live.theme = "custom"; await fs.writeFile(file, JSON.stringify(live));
  result = await config.setEnabled(false, 12345); assert.equal(result.recoveryRequired, true); assert.match(result.failures[0], /outside/); assert.equal(JSON.parse(await fs.readFile(file)).theme, "custom");
});
test("Hub HTTP requires its bearer key, rejects a foreign origin and accepts Streamable HTTP initialization", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-hub-http-")), old = process.env.HOME; process.env.HOME = home;
  const config = require("../src/lib/provider-switch/mcp-hub-config");
  const server = http.createServer((req, res) => { void require("../src/lib/provider-switch/mcp-hub-http").handle(req, res, new URL(req.url, "http://localhost")); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (old === undefined) delete process.env.HOME; else process.env.HOME = old; await fs.rm(home, { recursive: true, force: true }); });
  await config.setEnabled(true, server.address().port); const state = await config.read(), url = `http://127.0.0.1:${server.address().port}/api/mcp/hub/all`;
  const headers = { Authorization: `Bearer ${state.token}`, "content-type": "application/json" };
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal((await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://foreign.example" } })).status, 403);
  const result = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
  assert.equal((await result.json()).result.serverInfo.name, "aitool-hub");
});

test("Hub real stdio reuses one process, supports concurrent calls, cancels and expires idle children", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-hub-stdio-")), script = path.join(dir, "server.cjs"), starts = path.join(dir, "starts");
  await fs.writeFile(script, `const fs=require('node:fs'); const readline=require('node:readline'); fs.appendFileSync(process.argv[2],String(process.pid)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{ const m=JSON.parse(line); if(m.id===undefined)return;
const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:m.params.arguments.value||'ok'}]};
setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'),m.params?.arguments?.delay||0); });`);
  const hub = createHub({ listServers: async () => [{ id: "fixture", apps: { codex: true }, server: { command: process.execPath, args: [script, starts] } }], enabled: async () => true, idleMs: 150, timeoutMs: 3000 });
  t.after(async () => { await hub.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await hub.request("codex", { method: "tools/list" });
  const [a, b] = await Promise.all(["a", "b"].map(value => hub.request("codex", { method: "tools/call", params: { name: "fixture__echo", arguments: { value, delay: 30 } } })));
  assert.equal(a.content[0].text, "a"); assert.equal(b.content[0].text, "b");
  assert.equal((await fs.readFile(starts, "utf8")).trim().split("\n").length, 1);
  const cancel = new AbortController(), pending = hub.request("codex", { method: "tools/call", params: { name: "fixture__echo", arguments: { delay: 10000 } } }, cancel.signal);
  setTimeout(() => cancel.abort(), 50);
  await assert.rejects(pending);
  await hub.request("codex", { method: "tools/list" });
  for (let i = 0; i < 30 && hub.activeConnections(); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(hub.activeConnections(), 0);
  const pids = (await fs.readFile(starts, "utf8")).trim().split("\n").map(Number); assert.equal(pids.length, 2);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("Hub real HTTP negotiates a session, handles SSE tool responses and deletes the session on close", async t => {
  const messages = []; let deleted = false;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "DELETE") { deleted = req.headers["mcp-session-id"] === "fixture-session"; res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const message = JSON.parse(Buffer.concat(chunks)); messages.push({ message, headers: req.headers });
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    if (message.method === "initialize") { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: {} }] } : { content: [{ type: "text", text: "fixture" }] } })}\n\n`);
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const hub = createHub({ listServers: async () => [{ id: "http", apps: { codex: true }, server: { type: "http", url: `http://127.0.0.1:${upstream.address().port}/mcp` } }], enabled: async () => true });
  t.after(async () => { await hub.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  assert.equal((await hub.request("codex", { method: "tools/call", params: { name: "http__echo" } })).content[0].text, "fixture");
  assert.ok(messages.filter(row => row.message.method !== "initialize").every(row => row.headers["mcp-session-id"] === "fixture-session"));
  await hub.close(); assert.equal(deleted, true);
});

test("Hub disabling restores latest Codex filters and keeps user rules", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-hub-codex-")), old = process.env.HOME; process.env.HOME = home;
  t.after(async () => { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; await fs.rm(home, { recursive: true, force: true }); });
  const mcp = require("../src/lib/provider-switch/mcp"), config = require("../src/lib/provider-switch/mcp-hub-config"), file = mcp.mcpLiveFiles().codex.path;
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '# own\n[mcp_servers.echo]\ncommand="fixture"\ndisabled_tools=["user-rule"]\n');
  await mcp.upsertServer({ id: "echo", server: { command: "fixture" }, apps: { codex: true } });
  const storeFile = path.join(home, ".aitool", "provider-switch", "mcp-servers.json"), store = JSON.parse(await fs.readFile(storeFile));
  store.servers[0].disabledTools = { codex: ["first"] }; await fs.writeFile(storeFile, JSON.stringify(store));
  await mcp.syncServers(["codex"]);
  assert.deepEqual((await config.setEnabled(true, 12345)).failures, []);
  store.servers[0].disabledTools = { codex: ["second"] }; store.servers[0].server.command = "changed";
  await fs.writeFile(storeFile, JSON.stringify(store)); await config.syncApp("codex");
  assert.deepEqual((await config.setEnabled(false, 12345)).failures, []);
  const live = require("smol-toml").parse(await fs.readFile(file, "utf8"));
  assert.equal(live.mcp_servers.echo.command, "changed");
  assert.deepEqual(live.mcp_servers.echo.disabled_tools, ["user-rule", "second"]);
  assert.equal(live.mcp_servers["aitool-hub"], undefined);
});

test("Hub converts and restores DSH native YAML without changing provider or foreign plugin settings", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-hub-dsh-"));
  const oldHome = process.env.HOME, oldDsh = process.env.DSH_HOME;
  process.env.HOME = home; process.env.DSH_HOME = path.join(home, ".dsh");
  t.after(async () => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldDsh;
    await fs.rm(home, { recursive: true, force: true });
  });
  const mcp = require("../src/lib/provider-switch/mcp"), config = require("../src/lib/provider-switch/mcp-hub-config");
  const dsh = require("../src/lib/provider-switch/dsh"), YAML = require("yaml"), file = mcp.mcpLiveFiles().dsh.path;
  const original = '# native profile\n- id: llm-pi-ai\n  config:\n    providers: {relay: {apiKeyEnv: OWNER_KEY}}\n- id: foreign\n  config: {timeout: 30} # keep\n';
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, original);
  await mcp.upsertServer({ id: "echo", server: { command: "fixture" }, apps: { dsh: true } });
  const before = await fs.readFile(file, "utf8");
  assert.deepEqual((await config.setEnabled(true, 12345)).failures, []);
  const converted = await fs.readFile(file, "utf8");
  assert.ok(converted.startsWith(original));
  const [entry] = dsh.mcpEntries(converted);
  assert.equal(entry.config.serverName, "aitool-hub");
  assert.equal(entry.config.transport, "streamable-http");
  assert.equal(entry.config.url, "http://127.0.0.1:12345/api/mcp/hub/dsh");
  assert.equal(entry.config.headers.Authorization, `Bearer ${(await config.read()).token}`);
  assert.deepEqual(YAML.parse(converted).slice(0, 2), YAML.parse(original));
  assert.deepEqual((await config.setEnabled(false, 12345)).failures, []);
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual(dsh.mcpEntries(before).map(row => row.config.serverName), ["echo"]);
});
