"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const YAML = require("yaml");
const config = require("../src/lib/proxy/config");
const { handleProxyApiRequest } = require("../src/lib/proxy/api");

async function fixture(t, initialDocument = 'server:\n  port: 8318\nrouting:\n  strategy: round-robin\naccess:\n  api-keys: [fixture-key]\n') {
  let document = initialDocument;
  let race = false;
  const calls = [];
  const etag = () => `"${crypto.createHash("sha256").update(document).digest("hex")}"`;
  const core = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    calls.push({ path: req.url, method: req.method, body, headers: req.headers });
    assert.equal(req.headers.authorization, "Bearer management-fixture");
    if (race && req.method !== "GET") { document += "debug: true\n"; race = false; }
    if (req.method !== "GET" && req.headers["if-match"] !== etag()) {
      res.writeHead(412, { ETag: etag(), "Content-Type": "application/json" });
      res.end('{"error":"precondition_failed"}'); return;
    }
    const yaml = req.url === "/v8/management/config.yaml";
    if (req.method !== "GET") {
      if (yaml) {
        assert.equal(req.headers["content-type"], "application/yaml");
        assert.equal(typeof YAML.parse(body), "object");
        document = body;
      } else {
        const doc = YAML.parse(document);
        doc.access = { ...doc.access, "api-keys": JSON.parse(body) };
        document = YAML.stringify(doc);
      }
    }
    const doc = YAML.parse(document);
    const data = req.url === "/v8/management/config" ? doc : doc.access?.["api-keys"];
    if (req.method === "GET" && !yaml && data == null) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"not_found"}'); return;
    }
    res.writeHead(200, { ETag: etag(), "Content-Type": yaml && req.method === "GET" ? "application/yaml" : "application/json" });
    res.end(req.method !== "GET" ? '{"status":"ok"}' : yaml ? document : JSON.stringify(data));
  });
  await new Promise(resolve => core.listen(0, "127.0.0.1", resolve));
  const original = { getServerPort: config.getServerPort, getManagementKey: config.getManagementKey };
  config.getServerPort = () => core.address().port;
  config.getManagementKey = () => "management-fixture";
  const api = http.createServer((req, res) => handleProxyApiRequest(req, res, new URL(req.url, "http://localhost"), {
    isAuthorizedLocalMutation: () => req.headers["x-fixture"] === "yes",
  }));
  await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    Object.assign(config, original);
    await Promise.all([api, core].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  });
  const request = async (path, method = "GET", body, authorized = true) => {
    const res = await fetch(`http://127.0.0.1:${api.address().port}/api/proxy/${path}`, {
      method, headers: { "content-type": "application/json", ...(authorized ? { "x-fixture": "yes" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  return { request, calls, etag, document: () => YAML.parse(document), race: () => { race = true; } };
}

test("YAML writes require authorization and a revision, preserve raw YAML and reject a concurrent writer", async t => {
  const f = await fixture(t);
  const loaded = (await f.request("config.yaml")).data;
  assert.equal(loaded.etag, f.etag());
  assert.equal((await f.request("config.yaml", "PUT", { yaml: loaded.yaml }, false)).status, 401);
  assert.equal((await f.request("config.yaml", "PUT", { yaml: loaded.yaml })).status, 428);
  assert.equal((await f.request("config.yaml", "PUT", { yaml: loaded.yaml, etag: "*" })).status, 428);
  const saved = await f.request("config.yaml", "PUT", { yaml: loaded.yaml.replace("8318", "8320"), etag: loaded.etag });
  assert.equal(saved.status, 200);
  assert.notEqual(saved.data.etag, loaded.etag);
  assert.equal(f.document().server.port, 8320);
  f.race();
  const conflict = await f.request("config.yaml", "PUT", { yaml: loaded.yaml, etag: saved.data.etag });
  assert.equal(conflict.status, 412);
  assert.equal(conflict.data.error, "PROXY_CONFIG_CONFLICT");
  assert.equal(f.document().debug, true);
  assert.equal(f.document().server.port, 8320);
});

test("structured saves use conditional core writes and retain unrelated configuration", async t => {
  const f = await fixture(t);
  const loaded = (await f.request("config-fields")).data;
  const saved = await f.request("config-fields", "PATCH", { fields: { "server.port": 8330 }, etag: loaded.etag });
  assert.equal(saved.status, 200);
  assert.equal(f.document().routing.strategy, "round-robin");
  assert.equal(saved.data.fields["server.port"], 8330);
  assert.equal((await f.request("config-fields", "PATCH", { fields: { "server.port": 8340 }, etag: loaded.etag })).status, 412);
  assert.equal((await f.request("config-fields", "PATCH", { fields: { "constructor.prototype.polluted": true }, etag: saved.data.etag })).status, 400);
  f.race();
  assert.equal((await f.request("config-fields", "PATCH", { fields: { "server.port": 8340 }, etag: saved.data.etag })).status, 412);
  assert.equal(f.document().server.port, 8330);
});

test("client keys and management transport forward revisions and expose conflicts", async t => {
  const f = await fixture(t);
  const loaded = (await f.request("keys")).data;
  assert.deepEqual(loaded.keys, ["fixture-key"]);
  const saved = await f.request("keys", "PUT", { keys: ["changed"], etag: loaded.etag });
  assert.equal(saved.status, 200);
  assert.deepEqual(f.document().access["api-keys"], ["changed"]);
  const conflict = await f.request("management-request", "POST", { request: {
    method: "PUT", path: "/config/access/api-keys", body: ["old"], ifMatch: loaded.etag,
  } });
  assert.equal(conflict.status, 412);
  assert.deepEqual(f.document().access["api-keys"], ["changed"]);
  assert.equal(f.calls.at(-1).headers["if-match"], loaded.etag);
});

test("empty client keys retain a revision for first creation and recreation", async t => {
  for (const access of [undefined, {}, { "api-keys": null }, { "api-keys": [] }]) {
    await t.test(JSON.stringify(access) || "missing access", async t => {
      const initial = {
        server: { port: 8318 },
        "api-keys": { "openai-compatibility": [{ name: "upstream", keys: [{ "api-key": "upstream-fixture" }] }] },
        ...(access === undefined ? {} : { access }),
      };
      const f = await fixture(t, YAML.stringify(initial));
      const loaded = await f.request("keys");
      assert.equal(loaded.status, 200);
      assert.deepEqual(loaded.data.keys, []);
      assert.equal(loaded.data.etag, f.etag());
      assert.deepEqual(f.document(), initial, "reading must not initialize the configuration");
      assert.equal((await f.request("keys", "PUT", { keys: ["client-fixture"] })).status, 428);
      assert.equal((await f.request("keys", "PUT", { keys: ["client-fixture"], etag: loaded.data.etag }, false)).status, 401);

      const created = await f.request("keys", "PUT", { keys: ["client-fixture"], etag: loaded.data.etag });
      assert.equal(created.status, 200);
      assert.deepEqual((await f.request("keys")).data.keys, ["client-fixture"]);
      assert.deepEqual(f.document()["api-keys"], initial["api-keys"], "client keys must not replace upstream credentials");
      const stale = await f.request("keys", "PUT", { keys: ["stale-client"], etag: loaded.data.etag });
      assert.equal(stale.status, 412);
      assert.deepEqual(f.document().access["api-keys"], ["client-fixture"]);

      const removed = await f.request("keys", "PUT", { keys: [], etag: created.data.etag });
      assert.equal(removed.status, 200);
      const empty = (await f.request("keys")).data;
      assert.deepEqual(empty.keys, []);
      assert.equal(empty.etag, f.etag());
      const recreated = await f.request("keys", "PUT", { keys: ["new-client"], etag: empty.etag });
      assert.equal(recreated.status, 200);
      assert.deepEqual(f.document().access["api-keys"], ["new-client"]);
    });
  }
});

test("failed config reads are not reported as an empty client key list", async t => {
  const f = await fixture(t);
  t.mock.method(require("../src/lib/proxy/management"), "request", async () => ({
    ok: false, status: 503, data: { error: "core_unavailable" },
  }));
  const result = await f.request("keys");
  assert.equal(result.status, 502);
  assert.deepEqual(result.data, { ok: false, error: "core_unavailable" });
});

test("Copilot connects native v8 client keys and uses a server-fetched catalog", async t => {
  const f = await fixture(t);
  const copilot = require("../src/lib/proxy/copilot");
  t.mock.method(config, "readConfig", () => ({ access: { "api-keys": ["client-fixture"] }, "api-keys": { codex: [] } }));
  t.mock.method(copilot, "modelCatalog", async () => [{ id: "real-model", contextWindow: 32000 }]);
  t.mock.method(copilot, "connect", async (client, values) => {
    assert.equal(client, "vscode");
    assert.deepEqual(values.models, [{ id: "real-model", contextWindow: 32000 }]);
    return { configured: true };
  });
  const result = await f.request("copilot/connect", "POST", { client: "vscode", apiKey: "client-fixture", model: "real-model", models: [{ id: "untrusted" }] });
  assert.equal(result.status, 200);
  assert.equal(result.data.configured, true);
});
