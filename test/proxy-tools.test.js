"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { once } = require("node:events");
const tools = require("../src/lib/proxy/extensions/tools");
const state = require("../src/lib/proxy/managed-upstream");
const { createServer } = require("../src/lib/proxy/extensions/server");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-tools-")); t.after(() => fs.rm(root, { force: true, recursive: true }));
  const options = { root, corePort: 19995, env: { TAVILY_API_KEY: "synthetic-search-key" }, runtime: { start: async () => 19991 } };
  await tools.configure({ enabled: true, mode: "local", roots: [root], apiKey: "synthetic-key", model: "vision", searchKeyEnv: "TAVILY_API_KEY" }, options);
  return options;
}
test("image paths enforce roots, formats, regular files and symlink escape", async t => {
  const options = await fixture(t), root = path.join(options.root, "images"); await fs.mkdir(root);
  const png = Buffer.from([137,80,78,71,13,10,26,10]);
  const file = path.join(root, "synthetic.png"), outside = path.join(options.root, "outside.png"); await fs.writeFile(file, png); await fs.writeFile(outside, png);
  assert.equal(await tools.imageSource(file, [root]), `data:image/png;base64,${png.toString("base64")}`);
  await fs.symlink(outside, path.join(root, "escape.png"));
  await assert.rejects(tools.imageSource(path.join(root, "escape.png"), [root]), /outside/);
  await assert.rejects(tools.imageSource("https://example.com/img.png", [root]), /absolute/);
  await assert.rejects(tools.imageSource(root, [root]));
  await fs.writeFile(file, "not an image"); await assert.rejects(tools.imageSource(file, [root]), /format/);
  await assert.rejects(tools.imageSource("data:image/png;base64,????", [root]), /Invalid/);
});
test("vision inference uses core endpoint, counts only metadata and supports cancellation", async t => {
  const options = await fixture(t), signal = new AbortController().signal;
  options.json = async (url, config) => {
    assert.equal(url, "http://127.0.0.1:19995/v1/chat/completions"); assert.equal(config.signal, signal);
    assert.equal(config.headers.authorization, "Bearer synthetic-key");
    assert.equal(JSON.parse(config.body).messages[0].content[1].type, "image_url");
    return { choices: [{ message: { content: "synthetic-description" } }] };
  };
  const result = await tools.invoke("analyze_image", { image: "data:image/png;base64,iVBORw0KGgo=" }, signal, options);
  assert.equal(result.content[0].text, "synthetic-description");
  const counts = await fs.readFile(path.join(options.root, "tool-counts.json"), "utf8"); assert.doesNotMatch(counts, /synthetic-description|base64|prompt/);
  options.json = async () => { throw new DOMException("Canceled", "AbortError"); };
  await assert.rejects(tools.invoke("analyze_image", { image: "data:image/png;base64,iVBORw0KGgo=" }, signal, options));
  assert.deepEqual((await tools.status(options)).counts.analyze_image, { calls: 2, succeeded: 1, failed: 1 });
});
test("search calls are separately counted and only opt-in summaries cause inference", async t => {
  const options = await fixture(t); const urls = [];
  options.json = async (url, config) => {
    urls.push(url);
    if (url.includes("tavily")) { assert.equal(config.headers.authorization, "Bearer synthetic-search-key"); return { results: [{ title: "synthetic-title", url: "https://example.com", content: "synthetic-result" }] }; }
    return { choices: [{ message: { content: "summary" } }] };
  };
  await tools.invoke("web_search", { query: "synthetic-query" }, new AbortController().signal, options); assert.equal(urls.length, 1);
  await state.saveSettings(value => ({ ...value, tools: { ...value.tools, summarize: true } }), options);
  await tools.invoke("web_search", { query: "synthetic-query" }, new AbortController().signal, options); assert.equal(urls.length, 3);
  assert.doesNotMatch(await fs.readFile(path.join(options.root, "tool-counts.json"), "utf8"), /synthetic-query|synthetic-result/);
});
test("MCP endpoint rejects browser origins, unauthenticated calls and disabled tools", async t => {
  const options = await fixture(t), config = await state.settings(options), server = createServer(options);
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}/mcp/tools`;
  const send = (method, headers = {}) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${config.tools.token}`, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method, params: { protocolVersion: "2025-03-26" } }) });
  assert.equal((await send("tools/list", { authorization: "Bearer bad" })).status, 401);
  assert.equal((await send("tools/list", { origin: "http://localhost" })).status, 401);
  assert.equal((await (await send("initialize")).json()).result.protocolVersion, "2025-03-26");
  assert.deepEqual((await (await send("tools/list")).json()).result.tools.map(row => row.name), ["web_search", "analyze_image"]);
  await tools.configure({ enabled: false }, options); assert.equal((await send("tools/list")).status, 401);
});
