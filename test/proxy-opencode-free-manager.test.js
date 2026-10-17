const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const paths = require("../src/lib/proxy/paths");
const config = require("../src/lib/proxy/config");
const management = require("../src/lib/proxy/management");
const free = require("../src/lib/proxy/opencode-free");
const bridge = require("../src/lib/proxy/usage-bridge");
const { handleProxyApiRequest } = require("../src/lib/proxy/api");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-free-manager-"));
  const previous = { binPath: paths.binPath, pidPath: paths.pidPath, logsDir: paths.logsDir };
  Object.assign(paths, { binPath: process.execPath, pidPath: path.join(root, "missing.pid"), logsDir: root });
  t.after(() => {
    Object.assign(paths, previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));
  t.mock.method(config, "ensureConfig", () => {});
  t.mock.method(config, "getServerPort", () => 8318);
  // A healthy, authenticated core already listening can be adopted without
  // spawning a real binary or accessing the user's proxy configuration.
  t.mock.method(management, "ping", async () => ({ reachable: true }));
  t.mock.method(free, "startEnabled", async () => {});
  t.mock.method(free, "status", async () => ({ enabled: true }));
  t.mock.method(free, "syncGroup", async () => {});
  t.mock.method(free, "stop", async () => {});
  t.mock.method(bridge, "startBridge", () => {});
  t.mock.method(bridge, "stopBridge", () => {});
  t.mock.method(bridge, "bridgeStatus", () => ({ running: true }));
  return { root, warnings };
}

async function lifecycle(action) {
  const response = {};
  await handleProxyApiRequest({ method: "POST" }, {
    writeHead(status) { response.status = status; },
    end(body) { response.body = JSON.parse(body); },
  }, new URL(`http://localhost/api/proxy/${action}`), { isAuthorizedLocalMutation: () => true });
  return response;
}

for (const [method, error] of [
  ["startEnabled", "opencode_free_start_failed"],
  ["status", "opencode_free_state_unreadable"],
  ["syncGroup", "opencode_free_group_save_failed"],
]) {
  test(`proxy start and usage bridge survive adapter ${method} failure`, async (t) => {
    const { root, warnings } = fixture(t);
    free[method].mock.mockImplementation(async () => { throw new Error(error); });
    const response = await lifecycle("start");
    assert.equal(response.status, 200);
    assert.equal(response.body.result.alreadyRunning, true);
    assert.equal(management.ping.mock.callCount(), 1);
    assert.equal(bridge.startBridge.mock.callCount(), 1);
    assert.deepEqual(warnings, [`OpenCode free upstream start warning: ${error}`]);
    assert.ok(fs.readFileSync(path.join(root, "dashboard.log"), "utf8").includes(error));
    if (method !== "syncGroup") assert.equal(free.syncGroup.mock.callCount(), 0);
  });
}

test("successful core startup restores the enabled adapter and its group", async (t) => {
  const { warnings } = fixture(t);
  free.startEnabled.mock.mockImplementation(async () => {
    assert.equal(management.ping.mock.callCount(), 1, "core is healthy before restoring the adapter");
  });
  assert.equal((await lifecycle("start")).status, 200);
  assert.equal(free.syncGroup.mock.callCount(), 1);
  assert.equal(bridge.startBridge.mock.callCount(), 1);
  assert.deepEqual(warnings, []);
});

test("core startup errors remain failures and do not launch the adapter", async (t) => {
  const { warnings } = fixture(t);
  config.ensureConfig.mock.mockImplementation(() => { throw new Error("core config unavailable"); });
  const response = await lifecycle("start");
  assert.equal(response.status, 500);
  assert.equal(response.body.error, "core config unavailable");
  assert.equal(free.startEnabled.mock.callCount(), 0);
  assert.equal(bridge.startBridge.mock.callCount(), 0);
  assert.deepEqual(warnings, []);
});

test("adapter shutdown errors do not prevent a core restart", async (t) => {
  const { warnings } = fixture(t);
  free.stop.mock.mockImplementation(async () => { throw new Error("opencode_free_stop_failed"); });
  assert.equal((await lifecycle("restart")).status, 200);
  assert.equal(free.startEnabled.mock.callCount(), 1);
  assert.equal(free.syncGroup.mock.callCount(), 1);
  assert.equal(bridge.startBridge.mock.callCount(), 1);
  assert.deepEqual(warnings, ["OpenCode free upstream stop warning: opencode_free_stop_failed"]);
});
