const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createCoreInstallService } = require("../src/lib/proxy/core-install");

// The stop-and-update orchestration around the downloader, with fake
// manager/bridge/downloader: stop the running core before replacing the
// binary, restart it after (also on failure/cancel), one task at a time,
// phases/percent flowing into the snapshot the dashboard polls.

const ABORT = () => Object.assign(new Error("download canceled"), { name: "AbortError" });

function makeFakes({ running = false, installed = "8.0.8", failDownload = false } = {}) {
  const log = [];
  const state = { running, installed };
  const fetchCoreModule = {
    installedVersion: () => state.installed,
    resolveRelease: async ({ signal } = {}) => {
      log.push("resolve");
      if (signal?.aborted) throw ABORT();
      return { version: "8.0.9", source: "gitcode" };
    },
    downloadAndInstall: async (_release, { onProgress, signal } = {}) => {
      log.push("download-start");
      onProgress?.({ phase: "downloading", source: "GitCode", downloaded: 0, total: 100 });
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (signal?.aborted) throw ABORT();
      if (failDownload) throw new Error("HTTP 404");
      onProgress?.({ phase: "downloading", source: "GitCode", downloaded: 100, total: 100 });
      onProgress?.({ phase: "extracting", source: "GitCode" });
      log.push("download-done");
      return { skipped: false, version: "8.0.9", path: "/bin/cli-proxy-api", source: "GitCode" };
    },
  };
  const manager = {
    readPid: () => 4242,
    pidAlive: () => state.running,
    stop: async () => {
      log.push("stop");
      state.running = false;
      return { stopped: true };
    },
    start: async () => {
      log.push("start");
      state.running = true;
      return { started: true };
    },
    binaryExists: () => true,
  };
  const bridge = {
    stopBridge: () => log.push("bridge-stop"),
    startBridge: () => log.push("bridge-start"),
  };
  return { log, state, fetchCoreModule, manager, bridge };
}

async function waitFor(predicate, { timeout = 2000, step = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return predicate();
}

test("a fresh install stops the running core first and restarts it after", async () => {
  const fakes = makeFakes({ running: true });
  const service = createCoreInstallService(fakes);
  const started = service.startInstall();
  assert.equal(started.running, true);
  assert.equal(started.phase, "checking");

  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  const task = service.snapshot();
  assert.equal(task.phase, "complete");
  assert.equal(task.percent, 100);
  assert.equal(task.result.version, "8.0.9");
  assert.deepEqual(fakes.log, [
    "resolve",
    "bridge-stop",
    "stop",
    "download-start",
    "download-done",
    "start",
    "bridge-start",
  ]);
});

test("a stopped core is not stopped again and not restarted", async () => {
  const fakes = makeFakes({ running: false });
  const service = createCoreInstallService(fakes);
  service.startInstall();
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  assert.equal(service.snapshot().phase, "complete");
  assert.ok(!fakes.log.includes("stop"));
  assert.ok(!fakes.log.includes("start"));
});

test("the install is skipped without touching the core when already current", async () => {
  const fakes = makeFakes({ running: true, installed: "8.0.9" });
  const service = createCoreInstallService(fakes);
  service.startInstall();
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  const task = service.snapshot();
  assert.equal(task.phase, "complete");
  assert.equal(task.result.skipped, true);
  assert.deepEqual(fakes.log, ["resolve"], "no stop/download/restart for a no-op");
});

test("a failed download marks the task failed and brings the core back up", async () => {
  const fakes = makeFakes({ running: true, failDownload: true });
  const service = createCoreInstallService(fakes);
  service.startInstall();
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  const task = service.snapshot();
  assert.equal(task.phase, "failed");
  assert.match(task.error, /HTTP 404/);
  assert.deepEqual(fakes.log, [
    "resolve",
    "bridge-stop",
    "stop",
    "download-start",
    "start",
    "bridge-start",
  ]);
});

test("cancel mid-download lands the task in canceled and restarts the core", async () => {
  const fakes = makeFakes({ running: true });
  const service = createCoreInstallService(fakes);
  service.startInstall();
  assert.ok(await waitFor(() => fakes.log.includes("download-start")));
  const canceled = service.cancelInstall();
  assert.equal(canceled.running, true, "still running until the abort is observed");
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  const task = service.snapshot();
  assert.equal(task.phase, "canceled");
  assert.ok(!fakes.log.includes("download-done"), "download did not finish");
  assert.deepEqual(fakes.log.slice(-2), ["start", "bridge-start"], "core restarted after cancel");
});

test("only one install task may run at a time", async () => {
  const fakes = makeFakes({ running: false });
  const service = createCoreInstallService(fakes);
  service.startInstall();
  assert.throws(() => service.startInstall(), /already performing another operation/);
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  // After completion a new task can start.
  const second = service.startInstall();
  assert.equal(second.running, true);
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
});

test("progress events flow into the polled snapshot", async () => {
  const fakes = makeFakes({ running: false });
  const service = createCoreInstallService(fakes);
  service.startInstall();
  // Mid-download the snapshot must expose the byte counters.
  assert.ok(await waitFor(() => service.snapshot()?.phase === "downloading"));
  const mid = service.snapshot();
  assert.equal(mid.source, "GitCode");
  assert.equal(mid.total, 100);
  assert.ok(mid.downloaded >= 0);
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  assert.equal(service.snapshot().percent, 100);
});

test("a stale version marker does not skip installation when the binary is missing", async () => {
  const fakes = makeFakes({ installed: "8.0.9" });
  fakes.manager.binaryExists = () => false;
  const service = createCoreInstallService(fakes);
  service.startInstall();
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  assert.equal(service.snapshot().result.skipped, false);
  assert.ok(fakes.log.includes("download-done"));
});

test("stop failure prevents installation and restores the usage bridge", async () => {
  const fakes = makeFakes({ running: true });
  fakes.manager.stop = async () => { throw new Error("stop denied"); };
  const service = createCoreInstallService(fakes);
  service.startInstall();
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  assert.equal(service.snapshot().phase, "failed");
  assert.match(service.snapshot().error, /stop denied/);
  assert.ok(!fakes.log.includes("download-start"));
  assert.ok(fakes.log.includes("bridge-start"));
});

test("a core that survives stop is not overwritten", async () => {
  const fakes = makeFakes({ running: true });
  fakes.manager.stop = async () => ({ stopped: false });
  const service = createCoreInstallService(fakes);
  service.startInstall();
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  assert.equal(service.snapshot().phase, "failed");
  assert.ok(!fakes.log.includes("download-start"));
});

test("restart failure is a failed task instead of a completed update", async () => {
  const fakes = makeFakes({ running: true });
  fakes.manager.start = async () => { throw new Error("port in use"); };
  const service = createCoreInstallService(fakes);
  service.startInstall();
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  assert.equal(service.snapshot().phase, "failed");
  assert.match(service.snapshot().error, /restart failed.*port in use/);
});

test("a status failure settles the task and allows retry", async () => {
  const fakes = makeFakes();
  fakes.manager.readPid = () => { throw new Error("unreadable pid file"); };
  const service = createCoreInstallService(fakes);
  service.startInstall();
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  assert.equal(service.snapshot().phase, "failed");
  assert.match(service.snapshot().error, /unreadable pid/);
  fakes.manager.readPid = () => null;
  service.startInstall();
  assert.ok(await waitFor(() => service.snapshot()?.running === false));
  assert.equal(service.snapshot().phase, "complete");
});
