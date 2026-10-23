"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { pipeline } = require("node:stream/promises");
const { Readable, Writable } = require("node:stream");
const routing = require("../src/lib/proxy/extensions/routing");
const state = require("../src/lib/proxy/managed-upstream");
const base = { enabled: true, mode: "rules", models: ["one", "two"], rules: [], apiKey: "synthetic-key", quota: false, intent: false };
test("rules match image/tools/size/text in order, unknown quota never pretends to be available", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "Review" }, { type: "image_url", image_url: { url: "data:image/png;base64,test" } }] }], tools: [{}] };
  assert.equal(routing.choose({ ...base, rules: [{ when: "image", model: "two" }, { when: "tools", model: "one" }] }, body).model, "two");
  assert.equal(routing.choose({ ...base, rules: [{ when: "contains", value: "review", model: "two" }] }, body).reason, "contains");
  assert.equal(routing.choose({ ...base, quota: true }, body, null, { one: 0.9, two: 0.2 }).model, "two");
  assert.equal(routing.choose({ ...base, quota: true }, body, null, { two: 0.2 }).model, "one");
  assert.throws(() => routing.validate({ ...base, rules: [{ when: "intent", value: "review", model: "two" }] }), /Enable intent/);
  assert.throws(() => routing.validate({ ...base, models: [routing.ID] }), /concrete/);
});
test("model alias edits into the routing adapter are rejected on request revalidation", async () => {
  await assert.rejects(routing.checkModels(["two"], { request: async () => ({ ok: true, data: [{ name: "another", "base-url": "http://127.0.0.1:9999/routing/v1", models: [{ name: "two" }] }] }) }), /points back/);
  await assert.rejects(routing.checkModels(["two"], { request: async () => ({ ok: false }) }), /Read native/);
});
for (const streaming of [false, true]) test(`outer dispatch removes only usage and preserves response (${streaming})`, async () => {
  const body = { model: "served", choices: [{ delta: { content: "你好" } }], usage: { prompt_tokens: 100, completion_tokens: 10 } };
  const input = streaming ? `data: ${JSON.stringify(body)}\r\n\r\ndata: [DONE]\n\n` : JSON.stringify(body);
  let output = "";
  const bytes = Buffer.from(input);
  await pipeline(Readable.from([...bytes].map(byte => Buffer.from([byte]))), routing.stripDispatchUsage(streaming), new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }));
  assert.doesNotMatch(output, /prompt_tokens|completion_tokens|"usage"/); assert.match(output, /你好/); assert.match(output, /served/);
  if (streaming) assert.match(output, /\[DONE\]/);
});
test("classifier is opt-in, uses core accounting and route events contain no task text", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-routing-")); t.after(() => fs.rm(root, { force: true, recursive: true }));
  const options = { root, corePort: 19989, request: async () => ({ ok: true, data: [] }) }; let classifyCalls = 0;
  await state.saveSettings(value => ({ ...value, routing: { ...base, intent: true, classifier: "small", rules: [{ when: "intent", value: "review", model: "two" }] } }), options);
  options.json = async (url, config) => {
    classifyCalls++; assert.equal(url, "http://127.0.0.1:19989/v1/chat/completions"); assert.equal(config.headers["user-agent"], "AiTool-Classifier/1");
    assert.equal(JSON.parse(config.body).model, "small"); return { choices: [{ message: { content: "review" } }] };
  };
  const upstream = http.createServer((req, res) => {
    let raw = ""; req.on("data", chunk => { raw += chunk; }); req.on("end", () => {
      assert.equal(JSON.parse(raw).model, "two"); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "synthetic reply" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  options.streamRequest = (_url, config, callback) => http.request(`http://127.0.0.1:${upstream.address().port}`, config, callback);
  const server = http.createServer((req, res) => routing.forward({ req, res, body: { model: routing.ID, messages: [{ role: "user", content: "synthetic private task" }] }, signal: new AbortController().signal, options, pipeline }).catch(() => { res.destroy(); }));
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.close(); server.closeAllConnections(); });
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}`)).json(); assert.equal(body.usage, undefined);
  for (let i = 0; i < 20 && !(await routing.status(options)).events.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const result = await routing.status(options); assert.equal(result.events[0].extraCall, true); assert.equal(result.events[0].selected, "two"); assert.equal(classifyCalls, 1);
  assert.doesNotMatch(await fs.readFile(path.join(root, "routing-events.json"), "utf8"), /private task|synthetic reply/);
});
test("Magpie trace importer allows only AiTool routes and allowlists metadata", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-magpie-trace-")); t.after(() => fs.rm(root, { force: true, recursive: true }));
  const magpieDir = path.join(root, "magpie"); await fs.mkdir(magpieDir); await fs.writeFile(path.join(magpieDir, "settings.json"), '{"port":19987}'); await fs.writeFile(path.join(magpieDir, "providers.json"), '{"providers":[]}');
  const options = { root, magpieDir, corePort: 19985 };
  const audit = await require("../src/lib/proxy/extensions/magpie").audit(options);
  await state.saveSettings(value => ({ ...value, magpie: { revision: audit.revision, port: audit.port } }), options);
  options.json = async () => ({ object: "trace", routes: [{ agent: "other", model: "private" }, { agent: "aitool", id: 1, model: "group/daily", served: "model", prompt: "private body", error: "echo body", usage: [{ provider: "test", model: "test", in: 10, out: 5, cache_read: 2 }] }] });
  const events = await routing.magpieEvents(options); assert.equal(events.length, 1); assert.equal(events[0].usage[0].cacheRead, 2);
  assert.doesNotMatch(JSON.stringify(events), /private|echo body|prompt/);
});
