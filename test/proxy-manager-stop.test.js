const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const paths = require("../src/lib/proxy/paths");
const manager = require("../src/lib/proxy/manager");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-manager-test-"));
  const previous = { pidPath: paths.pidPath, configPath: paths.configPath };
  paths.pidPath = path.join(root, "core.pid");
  paths.configPath = path.join(root, "config.yaml");
  t.after(() => {
    Object.assign(paths, previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const sleeper = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });

async function waitAlive(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !manager.pidAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(manager.pidAlive(pid), "child process became visible");
}

async function waitGone(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && manager.pidAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!manager.pidAlive(pid), "process exited");
}

test("stop refuses to signal a recycled PID whose command line is not our core", async (t) => {
  fixture(t);
  const child = sleeper();
  t.after(() => child.kill("SIGKILL"));
  await waitAlive(child.pid);
  fs.writeFileSync(paths.pidPath, String(child.pid));
  const result = await manager.stop();
  assert.deepEqual(result, { stopped: false, running: false });
  assert.ok(manager.pidAlive(child.pid), "the foreign process survived stop()");
  assert.equal(fs.existsSync(paths.pidPath), false, "the stale pid file was dropped");
});

test("stop kills the managed core identified by its command line", async (t) => {
  fixture(t);
  // The managed core always runs as `<bin> -config <configPath>`; a child
  // carrying the config path in its command line stands in for it here.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", paths.configPath], { stdio: "ignore" });
  await waitAlive(child.pid);
  fs.writeFileSync(paths.pidPath, String(child.pid));
  const result = await manager.stop();
  assert.deepEqual(result, { stopped: true, running: false });
  await waitGone(child.pid);
  assert.equal(fs.existsSync(paths.pidPath), false);
});

test("stop clears a stale pid file without signaling anyone", async (t) => {
  fixture(t);
  fs.writeFileSync(paths.pidPath, "999999999");
  const result = await manager.stop();
  assert.deepEqual(result, { stopped: false, running: false });
  assert.equal(fs.existsSync(paths.pidPath), false);
});
