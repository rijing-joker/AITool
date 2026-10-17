const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const paths = require("../src/lib/proxy/paths");
const { handleProxyApiRequest } = require("../src/lib/proxy/api");

// The settings-page update check endpoint: GitCode → GitHub latest resolution
// (stubbed fetch) compared against the installed version marker.

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-core-update-test-"));
  const previous = paths.coreVersionPath;
  paths.coreVersionPath = path.join(root, "core-version.txt");
  t.after(() => {
    paths.coreVersionPath = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function getUpdate() {
  let payload;
  await handleProxyApiRequest({ method: "GET" }, {
    writeHead(status) { assert.equal(status, 200); },
    end(body) { payload = JSON.parse(body); },
  }, new URL("http://localhost/api/proxy/core-update"), {});
  return payload;
}

test("core-update reports installed, latest and hasUpdate", async (t) => {
  fixture(t);
  fs.writeFileSync(paths.coreVersionPath, "v8.0.9\n");
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("api.gitcode.com")) return { ok: false, status: 502, headers: new Headers(), body: null };
    if (String(url).includes("api.github.com")) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ tag_name: "v8.0.32" }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  const payload = await getUpdate();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.update, { installed: "8.0.9", latest: "8.0.32", source: "github", hasUpdate: true });
});

test("core-update falls back to the repo pin and reports no update without an install marker", async (t) => {
  fixture(t);
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 503, headers: new Headers(), body: null }));
  const payload = await getUpdate();
  assert.equal(payload.ok, true);
  assert.equal(payload.update.source, "pinned");
  assert.equal(payload.update.installed, null);
  assert.equal(payload.update.hasUpdate, false);
});
