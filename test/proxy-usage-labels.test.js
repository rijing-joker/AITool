const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUsageLabeler, usageFilterOptions } = require("../src/lib/proxy/usage-labels");
const { sha256Hex, normalizeRecord } = require("../src/lib/proxy/usage-record");
const paths = require("../src/lib/proxy/paths");
const config = require("../src/lib/proxy/config");
const management = require("../src/lib/proxy/management");
const pricing = require("../src/lib/proxy/pricing");
const { handleProxyApiRequest } = require("../src/lib/proxy/api");

test("client labels refresh independently of upstream notes and never expose source keys", () => {
  const row = { api_key_hash: sha256Hex("client"), api_key_remark: "Old client", source: "sk-secret", auth_index: "AuthA", provider: "codex" };
  const options = {
    keys: ["client"], remarks: { client: "New client" },
    providerRemarks: [
      { section: "codex-api-key", keyHash: sha256Hex("sk-secret"), remark: "Codex API" },
      { section: "xai-api-key", keyHash: sha256Hex("sk-secret"), remark: "Grok API" },
    ],
    credentials: [{ auth_index: "AuthA", note: "Saved account" }],
  };
  const first = createUsageLabeler(options)(row);
  assert.equal(first.api_key_remark, "New client");
  assert.equal(first.source_display, "codex · Saved account · AuthA");
  assert.equal(row.api_key_remark, "Old client");
  assert.equal(createUsageLabeler({ ...options, remarks: {} })(row).api_key_remark, "");
  assert.equal(createUsageLabeler({ ...options, keys: [] })(row).api_key_remark, "Old client");
  const withoutAccount = createUsageLabeler({ ...options, credentials: [] })(row);
  assert.equal(withoutAccount.source_display, "codex · Codex API · AuthA");
  const sanitized = createUsageLabeler({ ...options, credentials: [] })(normalizeRecord(row));
  assert.equal(sanitized.source_display, withoutAccount.source_display);
  assert.equal(JSON.stringify(sanitized).includes("sk-secret"), false);
  assert.equal(createUsageLabeler(options)({ ...row, provider: "grok", auth_index: "AuthB" }).source_display, "grok · Grok API · AuthB");
  const conflicting = createUsageLabeler({ credentials: [{ auth_index: "AuthA", note: "A" }, { auth_index: "AuthA", note: "B" }] })(row);
  assert.equal(conflicting.source_display, "codex · AuthA");
  assert.equal(JSON.stringify(usageFilterOptions([first, withoutAccount, conflicting])).includes("sk-secret"), false);
});

test("records API filters exact upstream identities, keeps range options and works offline", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-usage-labels-"));
  const previous = { usageDir: paths.usageDir, apiKeyRemarksPath: paths.apiKeyRemarksPath, remarksPath: paths.remarksPath };
  Object.assign(paths, { usageDir: root, apiKeyRemarksPath: path.join(root, "keys.json"), remarksPath: path.join(root, "remarks.json") });
  t.after(() => { Object.assign(paths, previous); fs.rmSync(root, { force: true, recursive: true }); });
  let clientConfig = { "api-keys": ["client"] };
  t.mock.method(config, "readConfig", () => clientConfig);
  t.mock.method(pricing, "getPricingSnapshot", async () => ({ models: null }));
  let offline = false;
  t.mock.method(management, "request", async (method, route, options) => {
    assert.equal(route, "/v8/management/credentials");
    assert.equal(options.timeoutMs, 3000);
    if (offline) throw new Error("offline");
    return { ok: true, data: { files: [{ auth_index: "AccountA", note: "Work" }] } };
  });
  const file = path.join(root, "records-2026-10-12.jsonl");
  const raw = [["AccountA", "codex"], ["accounta", "codex"], ["", "claude"], ["", "gemini"]].map(([auth_index, provider], i) => JSON.stringify({ id: String(i), timestamp: "2026-10-12T00:00:00Z", auth_index, provider, api_key: "client", source: "sk-shared-secret", model: "gpt-test" })).join("\n") + "\n";
  fs.writeFileSync(file, raw);
  async function read(query) {
    let body;
    await handleProxyApiRequest({ method: "GET" }, { writeHead: (status) => assert.equal(status, 200), end: (text) => { body = JSON.parse(text); } }, new URL(`http://localhost/api/proxy/usage/records?includeStats=1&${query}`), {});
    return body;
  }
  const all = await read("");
  assert.equal(JSON.stringify(all).includes("sk-shared-secret"), false);
  assert.equal(all.filterOptions.upstreams.length, 4);
  for (const option of all.filterOptions.upstreams) {
    const result = await read(`upstream=${encodeURIComponent(option.key)}`);
    assert.equal(result.total, 1);
    assert.equal(result.stats.total_requests, 1);
    assert.equal(result.records[0].source_display, option.label);
    assert.equal(result.filterOptions.upstreams.length, 4);
    assert.equal(option.key.includes("secret") || option.label.includes("secret"), false);
  }
  fs.writeFileSync(paths.apiKeyRemarksPath, JSON.stringify({ client: "Renamed" }));
  const renamed = await read(`api_key_hash=${sha256Hex("client")}`);
  assert.equal(renamed.total, 4);
  assert.equal(renamed.filterOptions.keys[0].label, "Renamed");
  const upstreams = { codex: [{ keys: [{ "api-key": "upstream-fixture" }] }] };
  clientConfig = { access: { "api-keys": ["client"] }, "api-keys": upstreams };
  const native = await read(`api_key_hash=${sha256Hex("client")}`);
  assert.equal(native.filterOptions.keys[0].label, "Renamed");
  assert.ok(native.records.every((row) => row.api_key_remark === "Renamed"));
  clientConfig = { "api-keys": upstreams };
  const withoutClientKeys = await read("");
  assert.equal(withoutClientKeys.total, 4);
  assert.equal(JSON.stringify(withoutClientKeys).includes("upstream-fixture"), false);
  offline = true;
  assert.equal((await read("upstream=auth:AccountA")).total, 1);
  assert.equal((await read("upstream=auth:unknown")).total, 0);
  assert.equal(fs.readFileSync(file, "utf8"), raw);
});
