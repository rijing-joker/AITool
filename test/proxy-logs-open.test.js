"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const paths = require("../src/lib/proxy/paths");
const {
  handleProxyApiRequest,
  openPathInFileManager,
  setLogsDirOpenerForTests,
} = require("../src/lib/proxy/api");

// POST /api/proxy/logs/open reveals the proxy log directory (cc-switch's
// settings.advanced.logConfig.openLog). The opener is a process spawn on the
// server host, so every test here pins the seam — no test may open a real
// Finder/Explorer window.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-logs-open-test-"));
  const previous = paths.logsDir;
  paths.logsDir = path.join(root, "logs");
  t.after(() => {
    paths.logsDir = previous;
    setLogsDirOpenerForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function post(url, ctx) {
  let status;
  let payload;
  return handleProxyApiRequest({ method: "POST" }, {
    writeHead(s) { status = s; },
    end(body) { payload = JSON.parse(body); },
  }, new URL(url), ctx).then(() => ({ status, payload }));
}

const authorized = { isAuthorizedLocalMutation: () => true };

test("logs/open spawns the opener for the proxy log directory", async (t) => {
  fixture(t);
  let opened = 0;
  setLogsDirOpenerForTests(async () => { opened += 1; });
  const { status, payload } = await post("http://localhost/api/proxy/logs/open", authorized);
  assert.equal(status, 200);
  assert.deepEqual(payload, { ok: true });
  assert.equal(opened, 1);
});

test("logs/open requires local mutation auth", async (t) => {
  const root = fixture(t);
  const { status, payload } = await post("http://localhost/api/proxy/logs/open", {});
  assert.equal(status, 401);
  assert.equal(payload.ok, false);
  assert.equal(fs.existsSync(path.join(root, "logs")), false);
});

test("logs/open reports opener failures as a structured 500", async (t) => {
  fixture(t);
  setLogsDirOpenerForTests(async () => { throw new Error("no opener"); });
  const { status, payload } = await post("http://localhost/api/proxy/logs/open", authorized);
  assert.equal(status, 500);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "no opener");
});

test("openPathInFileManager creates the log directory before opening", async (t) => {
  const root = fixture(t);
  // Spawning this Node binary with the directory as its script argument is a
  // harmless stand-in for a file manager: the spawn event fires, the child
  // exits immediately, and no GUI is involved.
  await openPathInFileManager(process.execPath);
  assert.equal(fs.existsSync(paths.logsDir), true);
  assert.equal(path.dirname(paths.logsDir), root);
});

test("openPathInFileManager rejects when the opener binary is missing", async (t) => {
  fixture(t);
  await assert.rejects(
    () => openPathInFileManager("aitool-missing-opener-binary"),
    (error) => /ENOENT/.test(String(error?.message || "")),
  );
});
