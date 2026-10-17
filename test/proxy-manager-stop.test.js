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
  t.mock.method(require("../src/lib/proxy/opencode-free"), "stop", async () => {});
  const previous = { pidPath: paths.pidPath, configPath: paths.configPath, binPath: paths.binPath };
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

test("stop kills the managed core identified by its executable and config argument", { skip: process.platform !== "linux" }, async (t) => {
  fixture(t);
  paths.binPath = process.execPath;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", "--", "-config", paths.configPath], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
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

test("invalid process IDs cannot become process-group probes", async () => {
  for (const pid of [-1, 0, 1.5, NaN]) {
    assert.equal(manager.pidAlive(pid), false);
    assert.equal(await manager.managedCoreAlive(pid), false);
  }
});

test("stop ignores a foreign executable even when it references our config", async (t) => {
  fixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", "--", "-config", paths.configPath], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await waitAlive(child.pid);
  fs.writeFileSync(paths.pidPath, String(child.pid));
  assert.deepEqual(await manager.stop(), { stopped: false, running: false });
  assert.ok(manager.pidAlive(child.pid));
});

test("config path prefixes do not identify a managed core", async (t) => {
  fixture(t);
  paths.binPath = process.execPath;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", "--", "-config", `${paths.configPath}.other`], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await waitAlive(child.pid);
  fs.writeFileSync(paths.pidPath, String(child.pid));
  assert.deepEqual(await manager.stop(), { stopped: false, running: false });
  assert.ok(manager.pidAlive(child.pid));
});

test("unavailable process inspection fails without treating an unknown process as the core", async () => {
  await assert.rejects(manager.managedCoreAlive(process.pid, {
    platform: "darwin",
    execFileImpl(command, args, options, callback) {
      callback(Object.assign(new Error("ps unavailable"), { code: "ENOENT" }));
    },
  }), /Cannot verify core process/);
  assert.equal(await manager.managedCoreAlive(process.pid, {
    platform: "darwin",
    execFileImpl(command, args, options, callback) { callback({ code: 1 }); },
  }), false);
});

test("Windows verifies executable and quoted config paths through CIM", async (t) => {
  fixture(t);
  paths.binPath = "C:\\Ai Tool\\cli-proxy-api.exe";
  paths.configPath = "C:\\Ai Tool\\config.yaml";
  let info = { ExecutablePath: paths.binPath, CommandLine: `"${paths.binPath}" -config "${paths.configPath}"` };
  const options = {
    platform: "win32",
    execFileImpl(command, args, options, callback) {
      assert.equal(command, "powershell.exe");
      assert.ok(args.at(-1).includes(`ProcessId = ${process.pid}`));
      callback(null, JSON.stringify(info));
    },
  };
  assert.equal(await manager.managedCoreAlive(process.pid, options), true);
  info = { ...info, ExecutablePath: "C:\\editor.exe" };
  assert.equal(await manager.managedCoreAlive(process.pid, options), false);
  info = { ExecutablePath: null, CommandLine: null };
  await assert.rejects(manager.managedCoreAlive(process.pid, options), /Cannot verify core process/);
});
