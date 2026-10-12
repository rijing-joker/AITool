const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const paths = require("../src/lib/proxy/paths");
const { handleProxyApiRequest } = require("../src/lib/proxy/api");

async function post(route, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST";
  let payload;
  await handleProxyApiRequest(req, {
    writeHead(status) { assert.equal(status, 200); },
    end(value) { payload = JSON.parse(value); },
  }, new URL(`http://localhost/api/proxy/provider-remarks${route}`), { isAuthorizedLocalMutation: () => true });
  return payload;
}

test("all provider sections can save, resolve and remove their own remarks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-remarks-test-"));
  const previous = paths.remarksPath;
  paths.remarksPath = path.join(root, "remarks.json");
  t.after(() => {
    paths.remarksPath = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sections = ["gemini-api-key", "interactions-api-key", "vertex-api-key", "codex-api-key",
    "claude-api-key", "xai-api-key", "meta-api-key", "openai-compatibility"];
  const locator = { providerName: "Shared name", apiKeys: ["test-key"], baseUrl: "https://example.test" };
  const queries = sections.map((providerSection) => ({ ...locator, providerSection }));
  for (const providerSection of sections) {
    assert.deepEqual(await post("", { update: {
      providerSection, previousRecords: [], records: [locator], allRecords: [locator], remark: providerSection,
    } }), { ok: true });
  }
  assert.deepEqual(await post("/resolve", { queries }), { ok: true, remarks: sections });
  assert.equal(fs.readFileSync(paths.remarksPath, "utf8").includes("test-key"), false);
  assert.deepEqual(await post("", { update: {
    providerSection: "meta-api-key", previousRecords: [locator], records: [], allRecords: [], remark: "",
  } }), { ok: true });
  assert.deepEqual((await post("/resolve", { queries })).remarks, sections.map((section) => section === "meta-api-key" ? "" : section));
  assert.deepEqual(await post("", { update: { providerSection: "unknown" } }), { ok: false, error: "Invalid API access type" });
});
