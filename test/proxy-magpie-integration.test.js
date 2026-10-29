"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { once } = require("node:events");
const { pipeline } = require("node:stream/promises");
const state = require("../src/lib/proxy/managed-upstream");
const magpie = require("../src/lib/proxy/extensions/magpie");
const buddy = require("../src/lib/proxy/extensions/workbuddy");
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-magpie-integration-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const options = { home, env: {}, root: path.join(home, "extensions"), magpieDir: path.join(home, ".config/magpie"), corePort: 19996 };
  await fs.mkdir(options.magpieDir, { recursive: true });
  await fs.writeFile(path.join(options.magpieDir, "providers.json"), JSON.stringify({ providers: [{ chat: "https://provider.invalid/v1" }] }));
  let groups = [{ name: "user", keys: [{ "api-key": "user-key" }] }], etag = '"r1"';
  options.request = async (method, route, values) => {
    if (route.startsWith("https:")) throw new Error("Unexpected network");
    if (method === "GET") return { ok: true, data: groups, etag };
    assert.equal(values.ifMatch, etag); groups = values.body; etag = '"r2"'; return { ok: true, etag };
  };
  options.runtime = { start: async () => { await state.saveSettings(value => ({ ...value, port: 19994 }), options); return 19994; } };
  return { options, groups: () => groups, change: value => { groups = value; } };
}
test("managed native groups require strong revisions and preserve neighbors and user drift", async t => {
  const fixtureData = await fixture(t), { options } = fixtureData;
  await state.configure("aitool-magpie", { keys: [{ "api-key": "internal" }], models: [{ name: "provider/model", alias: "provider/model" }] }, options);
  assert.equal(fixtureData.groups()[0].keys[0]["api-key"], "user-key");
  fixtureData.change(fixtureData.groups().map(row => row.name === "aitool-magpie" ? { ...row, priority: 10 } : row));
  await assert.rejects(state.configure("aitool-magpie", null, options), /changed outside/);
  options.request = async () => ({ ok: true, data: [], etag: "*" });
  await assert.rejects(state.configure("aitool-magpie", {}, options), /REVISION_REQUIRED/);
});
test("runtime credential indices and JSON key ordering do not block managed removal", async t => {
  const fixtureData = await fixture(t), { options } = fixtureData;
  await state.configure("aitool-magpie", { "base-url": "http://127.0.0.1:9999/v1", keys: [{ "api-key": "synthetic" }], models: [] }, options);
  fixtureData.change(fixtureData.groups().map(row => row.name === "aitool-magpie" ? { name: row.name, models: row.models, keys: row.keys.map(key => ({ auth_index: "core-runtime-index", ...key })), "base-url": row["base-url"] } : row));
  await state.configure("aitool-magpie", null, options); assert.equal(fixtureData.groups().length, 1);
});
test("Magpie discovery verifies identity, keeps group IDs and audits cycles before inference", async t => {
  const { options, groups } = await fixture(t);
  let inference = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/hello") return res.end(JSON.stringify({ name: "magpie", version: "fixture" }));
    assert.equal(req.headers.authorization, "Bearer magpie-aitool");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "group/daily" }, { id: "vendor/model" }, { id: "group/daily" }] }));
    inference++; req.resume();
    res.end(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 60 } }, choices: [{ message: { content: "synthetic" } }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  await fs.writeFile(path.join(options.magpieDir, "settings.json"), JSON.stringify({ port: server.address().port }));
  const found = await magpie.discover(options); assert.deepEqual(found.models.map(row => row.id), ["group/daily", "vendor/model"]);
  await magpie.configure({ enabled: true, models: ["group/daily"], revision: found.revision }, options);
  assert.deepEqual(groups()[1].models, [{ name: "group/daily", alias: "group/daily" }]);
  assert.equal(groups()[1].keys[0]["proxy-url"], "direct");
  const proxy = http.createServer((req, res) => magpie.forward({ req, res, body: { model: "group/daily", messages: [{ role: "user", content: "synthetic" }] }, signal: new AbortController().signal, options, pipeline }).catch(() => { res.writeHead(502); res.end(); }));
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening"); t.after(() => { proxy.close(); proxy.closeAllConnections(); });
  const result = await fetch(`http://127.0.0.1:${proxy.address().port}`); assert.equal((await result.json()).usage.prompt_tokens_details.cached_tokens, 60);
  await fs.writeFile(path.join(options.magpieDir, "providers.json"), JSON.stringify({ providers: [{ chat: "http://127.0.0.1:19996/v1" }] }));
  await assert.rejects(magpie.discover(options), /loop/);
  assert.equal((await fetch(`http://127.0.0.1:${proxy.address().port}`)).status, 502); assert.equal(inference, 1);
  await magpie.configure({ enabled: false }, options); assert.equal(groups().length, 1);
});
test("WorkBuddy browser login handles pending enterprise flow without exposing credentials", async t => {
  const { options } = await fixture(t); let pending = true;
  options.request = async (url, request) => {
    let data, code = 0;
    if (url.includes("auth/state")) data = { state: "synthetic-state", authUrl: "https://www.workbuddy.ai/login" };
    else if (url.includes("auth/token?")) { code = pending ? 11217 : 0; data = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresIn: 3600 }; }
    else if (url.includes("login/account")) data = { uid: "u1", type: "enterprise" };
    else if (url.includes("/accounts")) data = { accounts: [{ uid: "u1", type: "enterprise", enterpriseId: "e1" }] };
    else throw new Error(url);
    assert.equal(request.method === "GET" ? request.body : "{}", request.body);
    return { status: 200, body: Buffer.from(JSON.stringify({ code, data })) };
  };
  const login = await buddy.begin("workbuddy-ai", options);
  assert.match(login.url, /^https:\/\/www.workbuddy.ai/);
  assert.deepEqual(await buddy.poll("workbuddy-ai", login.id, options), { pending: true });
  pending = false;
  assert.deepEqual(await buddy.poll("workbuddy-ai", login.id, options), { pending: false, source: "browser" });
  const account = await buddy.current("workbuddy-ai", options); assert.equal(account.enterpriseId, "e1");
  assert.equal(buddy.headers("workbuddy-ai", account)["x-tenant-id"], "e1");
  assert.doesNotMatch(JSON.stringify(await buddy.status("workbuddy-ai", options)), /synthetic-access|synthetic-refresh/);
  assert.equal((await fs.stat(path.join(options.root, "workbuddy-ai-account.json"))).mode & 0o777, 0o600);
});
test("rotating refresh is serialized and live catalog/quota preserve native semantics", async t => {
  const { options } = await fixture(t); let refreshes = 0;
  await state.write(path.join(options.root, "workbuddy-account.json"), { access: "old", refresh: "rotating", expires: 1, uid: "u" });
  options.request = async url => {
    let data;
    if (url.includes("refresh")) { refreshes++; data = { accessToken: "new", refreshToken: "rotated", expiresIn: 3600 }; }
    else if (url.includes("config")) data = { agents: [{ name: "cli", models: ["native"] }], models: [{ id: "native", supportsImages: true, supportsReasoning: true, maxInputTokens: 100000 }] };
    else data = { Packages: [{ CycleTotalCapacity: "200", CycleUsedCapacity: "75.5" }] };
    return { status: 200, body: Buffer.from(JSON.stringify({ data })) };
  };
  const accounts = await Promise.all(Array.from({ length: 4 }, () => buddy.current("workbuddy", options))); assert.equal(refreshes, 1); assert.equal(accounts[3].refresh, "rotated");
  assert.equal((await buddy.catalog("workbuddy", options))[0].contextWindow, 100000);
  assert.deepEqual(await buddy.quota("workbuddy", options), { used: 75.5, total: 200, unit: "credits" });
});
test("a mid-call 401 renews once and resends (workbuddy 0.1.31 semantics)", async t => {
  const { options } = await fixture(t);
  // Fresh-looking token so current() does not pre-refresh; the upstream
  // still rejects it once, then accepts the renewed one.
  await state.write(path.join(options.root, "workbuddy-account.json"), { access: "stale-but-unexpired", refresh: "rotating", expires: Date.now() + 3600000, uid: "u" });
  let refreshes = 0, quotaCalls = 0, rejectedOnce = false;
  options.request = async (url, request) => {
    if (url.includes("refresh")) {
      refreshes += 1;
      return { status: 200, body: Buffer.from(JSON.stringify({ data: { accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 } })) };
    }
    quotaCalls += 1;
    if (!rejectedOnce && request.headers?.authorization === "Bearer stale-but-unexpired") {
      rejectedOnce = true;
      return { status: 401, body: Buffer.from(JSON.stringify({ code: 401, data: null })) };
    }
    assert.equal(request.headers?.authorization, "Bearer renewed");
    return { status: 200, body: Buffer.from(JSON.stringify({ data: { Packages: [{ CycleTotalCapacity: "100", CycleUsedCapacity: "10" }] } })) };
  };
  assert.deepEqual(await buddy.quota("workbuddy", options), { used: 10, total: 100, unit: "credits" });
  assert.equal(refreshes, 1, "exactly one renewal");
  assert.equal(quotaCalls, 2, "the request is sent again after renewing");
  // The renewed account persists and the next call needs no refresh.
  assert.deepEqual(await buddy.quota("workbuddy", options), { used: 10, total: 100, unit: "credits" });
  assert.equal(refreshes, 1);
});
test("desktop tokens stay in the user's file and encrypted/expiring logins fail clearly", async t => {
  const { options } = await fixture(t), target = buddy.desktopFile("workbuddy", options);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const raw = JSON.stringify({ auth: { accessToken: "desktop-access", refreshToken: "desktop-refresh", expiresAt: Date.now() + 3600000 }, account: { uid: "u" } });
  await fs.writeFile(target, raw); await buddy.useDesktop("workbuddy", options);
  assert.equal((await buddy.current("workbuddy", options)).refresh, ""); assert.equal(await fs.readFile(target, "utf8"), raw);
  assert.doesNotMatch(await fs.readFile(path.join(options.root, "workbuddy-account.json"), "utf8"), /desktop-access|desktop-refresh/);
  await fs.writeFile(target, JSON.stringify({ auth: { accessToken: { $wbEncrypted: 1 } } }));
  await assert.rejects(buddy.desktop("workbuddy", options), /encrypted/);
});
test("WorkBuddy inference preserves system/developer content, streaming cache/reasoning and rejects redirects", async t => {
  const { options } = await fixture(t);
  await state.write(path.join(options.root, "workbuddy-account.json"), { access: "synthetic-access", expires: Date.now() + 3600000, uid: "u" });
  await state.saveSettings(value => ({ ...value, workbuddy: { models: ["native"] } }), options);
  const body = { model: "native", stream: true, messages: [{ role: "system", content: "Claude Code synthetic" }, { role: "developer", content: "Codex synthetic" }, { role: "user", content: "Synthetic" }] };
  const upstream = http.createServer((req, res) => {
    let raw = ""; req.on("data", chunk => { raw += chunk; }); req.on("end", () => {
      assert.deepEqual(JSON.parse(raw), { ...body, stream_options: { include_usage: true } }); assert.equal(req.headers.authorization, "Bearer synthetic-access");
      assert.ok(req.headers["x-conversation-request-id"]);
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":60},"completion_tokens_details":{"reasoning_tokens":5}}}\n\ndata: [DONE]\n\n');
    });
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  options.streamRequest = (_url, config, callback) => http.request(`http://127.0.0.1:${upstream.address().port}`, config, callback);
  const proxy = http.createServer((req, res) => buddy.forward({ kind: "workbuddy", req, res, body, signal: new AbortController().signal, options, pipeline }));
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening"); t.after(() => { proxy.close(); proxy.closeAllConnections(); });
  const raw = await (await fetch(`http://127.0.0.1:${proxy.address().port}`)).text(); assert.match(raw, /cached_tokens/); assert.match(raw, /reasoning_tokens/); assert.match(raw, /\[DONE\]/);
});

test("WorkBuddy Claude models use Messages with effort, fall back to chat, and WorkBuddy AI stays on chat", async t => {
  const { options } = await fixture(t);
  await state.write(path.join(options.root, "workbuddy-account.json"), { access: "synthetic-access", expires: Date.now() + 3600000, uid: "u" });
  await state.write(path.join(options.root, "workbuddy-ai-account.json"), { access: "synthetic-access", expires: Date.now() + 3600000, uid: "u" });
  await state.saveSettings(value => ({ ...value, enabled: { workbuddy: true, "workbuddy-ai": true }, workbuddy: { models: ["claude-opus-5.5"] }, "workbuddy-ai": { models: ["claude-opus-5.5"] } }), options);
  assert.equal(buddy.isMessagesModel("workbuddy", "claude-opus-5.5"), true);
  assert.equal(buddy.isMessagesModel("workbuddy", "glm-5.3"), false);
  assert.equal(buddy.isMessagesModel("workbuddy-ai", "claude-opus-5.5"), false);
  const converted = buddy.chatToMessages({ model: "claude-opus-5.5", max_completion_tokens: 32, reasoning_effort: "max",
    messages: [{ role: "system", content: "System A" }, { role: "developer", content: "Dev B" }, { role: "user", content: "Synthetic" }],
    tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }] });
  assert.equal(converted.system, "System A\n\nDev B");
  assert.equal(converted.max_tokens, 32);
  assert.deepEqual(converted.output_config, { effort: "max" });
  assert.deepEqual(converted.thinking, { type: "adaptive" });
  assert.deepEqual(converted.tools, [{ name: "echo", description: "", input_schema: { type: "object" } }]);

  const anthropic = [
    { type: "message_start", message: { id: "msg_fixture", model: "claude-opus-5.5", usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "echo", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"x":1}' } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
  const seen = [];
  let fallback = false;
  let overloaded = false;
  let protocolFailure = false;
  let requested = "";
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    seen.push({ url: requested, body: JSON.parse(raw) });
    if (requested === "/v1/messages" && fallback) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
    if (requested === "/v1/messages" && overloaded) { res.writeHead(429, { "content-type": "application/json" }); res.end("{}"); return; }
    if (requested === "/v1/messages" && protocolFailure) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
    if (requested === "/v1/messages") {
      assert.equal(req.headers["anthropic-version"], "2023-06-01");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(anthropic.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""));
      return;
    }
    assert.equal(requested, "/v2/chat/completions");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"fallback"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n');
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  options.streamRequest = (url, config, callback) => {
    requested = new URL(url).pathname;
    return http.request(`http://127.0.0.1:${upstream.address().port}`, config, callback);
  };
  const runForward = (kind, requestBody) => new Promise((resolve, reject) => {
    const req = { headers: {} };
    const res = new http.ServerResponse({ method: "POST" });
    const chunks = [];
    res.writeHead = (status, headers) => {
      res.statusCode = status;
      Object.entries(headers || {}).forEach(([key, value]) => res.setHeader?.(key, value));
      return res;
    };
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() });
      return res;
    };
    buddy.forward({ kind, req, res, body: requestBody, signal: new AbortController().signal, options, pipeline }).catch(reject);
  });
  const body = { model: "claude-opus-5.5", stream: true, reasoning_effort: "max", max_completion_tokens: 32,
    messages: [{ role: "system", content: "System A" }, { role: "user", content: "Synthetic" }] };
  for (const [stream, expectJson] of [[true, false], [false, true]]) {
    const response = await runForward("workbuddy", { ...body, stream });
    assert.equal(response.status, 200);
    if (expectJson) {
      const completion = JSON.parse(response.text);
      assert.equal(completion.choices[0].message.content, "Hello");
      assert.equal(completion.choices[0].message.tool_calls[0].function.name, "echo");
      assert.equal(completion.choices[0].finish_reason, "tool_calls");
      assert.equal(completion.usage.prompt_tokens, 125);
      assert.equal(completion.usage.prompt_tokens_details.cached_tokens, 20);
    } else {
      assert.match(response.text, /Hello/);
      assert.match(response.text, /toolu_1/);
      assert.match(response.text, /"finish_reason":"tool_calls"/);
      assert.match(response.text, /\[DONE\]/);
    }
  }
  const messagesCall = seen.find(row => row.url === "/v1/messages");
  assert.equal(messagesCall.body.output_config.effort, "max");
  assert.equal(messagesCall.body.messages[0].role, "user");

  fallback = true;
  const response = await runForward("workbuddy", body);
  assert.equal(response.status, 200);
  assert.match(response.text, /fallback/);
  assert.equal(seen.filter(row => row.url === "/v2/chat/completions").length, 1);

  // Quota/rate-limit failures surface as-is instead of spending a chat request.
  fallback = false;
  overloaded = true;
  const chatBefore = seen.filter(row => row.url === "/v2/chat/completions").length;
  const limited = await runForward("workbuddy", body);
  assert.equal(limited.status, 429);
  assert.match(limited.text, /workbuddy_http_429/);
  assert.equal(seen.filter(row => row.url === "/v2/chat/completions").length, chatBefore);
  overloaded = false;

  // A 200 that is not SSE fails before headers and still falls back to chat.
  protocolFailure = true;
  const broken = await runForward("workbuddy", body);
  assert.equal(broken.status, 200);
  assert.match(broken.text, /fallback/);
  assert.equal(seen.filter(row => row.url === "/v2/chat/completions").length, chatBefore + 1);
  protocolFailure = false;
  // WorkBuddy AI has no Messages route: a Claude model stays on chat.
  const aiBefore = seen.length;
  await runForward("workbuddy-ai", body);
  assert.equal(seen[aiBefore].url, "/v2/chat/completions");
});
test("WorkBuddy aggregates SSE into non-streaming JSON with tools, reasoning and exact usage", async t => {
  const { options } = await fixture(t);
  for (const kind of ["workbuddy", "workbuddy-ai"]) {
    await state.write(path.join(options.root, `${kind}-account.json`), { access: "synthetic-access", expires: Date.now() + 3600000, uid: "u" });
  }
  await state.saveSettings(value => ({ ...value, enabled: { workbuddy: true, "workbuddy-ai": true }, workbuddy: { models: ["native"] }, "workbuddy-ai": { models: ["native"] } }), options);
  const messages = [{ role: "system", content: "System stays" }, { role: "developer", content: "Developer stays" }, { role: "user", content: "Synthetic" }];
  const usage = { prompt_tokens: 120, completion_tokens: 25, total_tokens: 145,
    prompt_tokens_details: { cached_tokens: 80, cache_creation_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 5 } };
  const chunks = [
    { id: "chatcmpl-fixture", created: 123, model: "actual-model", choices: [{ index: 0, delta: { role: "assistant", content: "回答", reasoning_content: "Think " } }] },
    { choices: [{ index: 0, delta: { content: "完成", reasoning_content: "done", tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: "echo", arguments: '{"marker":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage },
  ];
  const wire = Buffer.from(": keepalive\r\n\r\n" + chunks.map(chunk => `event: message\r\ndata: ${JSON.stringify(chunk)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const sent = JSON.parse(raw); seen.push(sent);
    assert.equal(sent.stream, true); assert.deepEqual(sent.stream_options, { include_usage: true });
    assert.deepEqual(sent.messages, messages); assert.equal(sent.max_tokens, 32);
    assert.deepEqual(sent.tools, [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }]);
    assert.equal(req.headers.accept, "text/event-stream");
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Split inside UTF-8 and JSON tokens, as actual network chunks can do.
    for (let index = 0; index < wire.length; index += 7) {
      res.write(wire.subarray(index, index + 7)); await new Promise(resolve => setImmediate(resolve));
    }
    res.end();
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  options.streamRequest = (_url, config, callback) => http.request(`http://127.0.0.1:${upstream.address().port}`, config, callback);
  const proxy = require("../src/lib/proxy/extensions/server").createServer(options);
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening"); t.after(() => proxy.stop());
  const config = await state.settings(options);
  for (const [kind, stream] of [["workbuddy", false], ["workbuddy-ai", false], ["workbuddy", undefined]]) {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/${kind}/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ model: "native", stream, messages, max_tokens: 32, tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }] }),
    });
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /application\/json/);
    const result = await response.json();
    assert.equal(result.object, "chat.completion"); assert.equal(result.id, "chatcmpl-fixture");
    assert.equal(result.created, 123); assert.equal(result.model, "actual-model");
    assert.deepEqual(result.usage, usage);
    assert.deepEqual(result.choices, [{ index: 0, message: { role: "assistant", content: "回答完成", reasoning_content: "Think done",
      tool_calls: [{ id: "call-fixture", type: "function", function: { name: "echo", arguments: '{"marker":"fixture"}' } }] }, finish_reason: "tool_calls" }]);
  }
  assert.equal(seen.length, 3);
});

test("WorkBuddy non-streaming responses reject failed or incomplete SSE without exposing text", async t => {
  const { options } = await fixture(t);
  await state.write(path.join(options.root, "workbuddy-account.json"), { access: "synthetic-access", expires: Date.now() + 3600000, uid: "u" });
  await state.saveSettings(value => ({ ...value, enabled: { workbuddy: true }, workbuddy: { models: ["native"] } }), options);
  let wire;
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200, { "content-type": "text/event-stream" }); res.end(wire); });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  options.streamRequest = (_url, config, callback) => http.request(`http://127.0.0.1:${upstream.address().port}`, config, callback);
  const proxy = require("../src/lib/proxy/extensions/server").createServer(options);
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening"); t.after(() => proxy.stop());
  const config = await state.settings(options);
  async function request() {
    return fetch(`http://127.0.0.1:${proxy.address().port}/workbuddy/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ model: "native", stream: false, messages: [{ role: "user", content: "Synthetic" }] }) });
  }
  for (const failed of [
    'data: {"choices":[{"index":0,"delta":{"content":"private-upstream-text"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"error":{"message":"private-upstream-text"}}\n\ndata: [DONE]\n\n',
    'data: malformed-private-upstream-text\n\ndata: [DONE]\n\n',
  ]) {
    wire = failed;
    const response = await request(); assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: { code: "extension_failed" } });
  }
  wire = 'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const response = await request(); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.choices[0].message.content, "OK"); assert.equal(result.usage, undefined);
});

test("a chat 401 renews once and resends before any bytes reach the client", async t => {
  const { options } = await fixture(t);
  await state.write(path.join(options.root, "workbuddy-account.json"), { access: "stale-but-unexpired", refresh: "rotating", expires: Date.now() + 3600000, uid: "u" });
  await state.saveSettings(value => ({ ...value, enabled: { workbuddy: true }, workbuddy: { models: ["native"] } }), options);
  let refreshes = 0, chats = 0, rejectedOnce = false;
  const body = { model: "native", stream: true, messages: [{ role: "user", content: "Synthetic" }] };
  const upstream = http.createServer((req, res) => {
    req.resume(); chats += 1;
    if (!rejectedOnce && req.headers.authorization === "Bearer stale-but-unexpired") {
      rejectedOnce = true;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 401 }));
      return;
    }
    assert.equal(req.headers.authorization, "Bearer renewed");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  options.request = async url => {
    if (url.includes("refresh")) {
      refreshes += 1;
      return { status: 200, body: Buffer.from(JSON.stringify({ data: { accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 } })) };
    }
    throw new Error(url);
  };
  options.streamRequest = (_url, config, callback) => http.request(`http://127.0.0.1:${upstream.address().port}`, config, callback);
  const proxy = http.createServer((req, res) => buddy.forward({ kind: "workbuddy", req, res, body, signal: new AbortController().signal, options, pipeline }).catch(() => { res.writeHead(502); res.end(); }));
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening"); t.after(() => { proxy.close(); proxy.closeAllConnections(); });
  const raw = await (await fetch(`http://127.0.0.1:${proxy.address().port}`)).text();
  assert.match(raw, /\[DONE\]/);
  assert.equal(refreshes, 1, "exactly one renewal");
  assert.equal(chats, 2, "the chat request is sent again after renewing");
});

test("a chat 401 that survives renewal maps to the client without a second refresh", async t => {
  const { options } = await fixture(t);
  await state.write(path.join(options.root, "workbuddy-account.json"), { access: "stale-but-unexpired", refresh: "rotating", expires: Date.now() + 3600000, uid: "u" });
  await state.saveSettings(value => ({ ...value, enabled: { workbuddy: true }, workbuddy: { models: ["native"] } }), options);
  let refreshes = 0, chats = 0;
  const body = { model: "native", stream: true, messages: [{ role: "user", content: "Synthetic" }] };
  const upstream = http.createServer((req, res) => {
    req.resume(); chats += 1;
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 401 }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  options.request = async url => {
    if (url.includes("refresh")) {
      refreshes += 1;
      return { status: 200, body: Buffer.from(JSON.stringify({ data: { accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 } })) };
    }
    throw new Error(url);
  };
  options.streamRequest = (_url, config, callback) => http.request(`http://127.0.0.1:${upstream.address().port}`, config, callback);
  const proxy = http.createServer((req, res) => buddy.forward({ kind: "workbuddy", req, res, body, signal: new AbortController().signal, options, pipeline }).catch(() => { res.writeHead(502); res.end(); }));
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening"); t.after(() => { proxy.close(); proxy.closeAllConnections(); });
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}`);
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error.code, "workbuddy_http_401");
  assert.doesNotMatch(JSON.stringify(payload), /stale-but-unexpired/);
  assert.equal(refreshes, 1, "the retry is not renewed again");
  assert.equal(chats, 2);
});

test("concurrent chat 401s share one renewal and both resend with the renewed token", async t => {
  const { options } = await fixture(t);
  await state.write(path.join(options.root, "workbuddy-account.json"), { access: "stale-but-unexpired", refresh: "rotating", expires: Date.now() + 3600000, uid: "u" });
  await state.saveSettings(value => ({ ...value, enabled: { workbuddy: true }, workbuddy: { models: ["native"] } }), options);
  let refreshes = 0, staleRejects = 0, renewedChats = 0;
  const body = { model: "native", stream: true, messages: [{ role: "user", content: "Synthetic" }] };
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    if (req.headers.authorization === "Bearer stale-but-unexpired") {
      // Hold both 401s briefly so both chats are in flight before either
      // renewal starts — that is the concurrent-reuse path.
      staleRejects += 1;
      await new Promise(resolve => setTimeout(resolve, 50));
      res.writeHead(401); res.end("{}"); return;
    }
    assert.equal(req.headers.authorization, "Bearer renewed");
    renewedChats += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  options.request = async url => {
    if (url.includes("refresh")) {
      refreshes += 1;
      await new Promise(resolve => setTimeout(resolve, 50));
      return { status: 200, body: Buffer.from(JSON.stringify({ data: { accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 } })) };
    }
    throw new Error(url);
  };
  options.streamRequest = (_url, config, callback) => http.request(`http://127.0.0.1:${upstream.address().port}`, config, callback);
  const proxy = http.createServer((req, res) => buddy.forward({ kind: "workbuddy", req, res, body, signal: new AbortController().signal, options, pipeline }).catch(() => { res.writeHead(502); res.end(); }));
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening"); t.after(() => { proxy.close(); proxy.closeAllConnections(); });
  const [first, second] = await Promise.all([
    fetch(`http://127.0.0.1:${proxy.address().port}`, { method: "POST", body: "x" }),
    fetch(`http://127.0.0.1:${proxy.address().port}`, { method: "POST", body: "x" }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(refreshes, 1, "the second caller reuses the renewed account");
  assert.equal(staleRejects, 2);
  assert.equal(renewedChats, 2);
});
