// Background "获取 / 更新" task for the CLIProxyAPI core binary — the HTTP
// port of EasyCLIProxyAPI's VersionManagementPage install flow (its Rust
// install_core_version + CoreInstallTask). One task at a time; the snapshot is
// polled by the dashboard at GET /api/proxy/install while the progress dialog
// is open. Flow mirrors the GUI: resolve the latest release (GitCode mirror
// first), stop the running core ("停止并更新"), download with progress,
// extract + install, then restart the core if it was running before.

const paths = require("./paths");

function isAbort(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function createCoreInstallService({ manager, bridge, fetchCoreModule }) {
  let task = null;
  let controller = null;

  const snapshot = () => (task ? { ...task, result: task.result ? { ...task.result } : null } : null);

  function applyProgress(event = {}) {
    if (!task) return;
    if (event.phase !== undefined) task.phase = event.phase;
    if (event.source !== undefined) task.source = event.source;
    if (event.message !== undefined) task.message = event.message;
    if (event.downloaded !== undefined) task.downloaded = event.downloaded;
    if (event.total !== undefined) task.total = event.total;
    if (task.phase === "complete") task.percent = 100;
    else if (task.total) task.percent = Math.min(100, (task.downloaded / task.total) * 100);
    else task.percent = null;
  }

  async function coreRunning() {
    const pid = manager.readPid();
    return manager.pidAlive(pid);
  }

  // The task stays active until the proxy is usable again. A restart failure
  // must leave the dialog open with an error, rather than a success toast.
  async function restartCoreAfterInstall(terminalPhase) {
    applyProgress({ phase: "restarting" });
    try {
      await manager.start();
      bridge.startBridge();
      applyProgress({ phase: terminalPhase });
    } catch (error) {
      const message = `automatic core restart failed: ${error?.message || error}`;
      task.error = task.error ? `${task.error}; ${message}` : message;
      applyProgress({ phase: "failed" });
    }
  }

  async function run(signal, force) {
    let stoppedForInstall = false;
    try {
      const wasRunning = await coreRunning();
      const release = await fetchCoreModule.resolveRelease({ signal });
      signal.throwIfAborted();
      if (!force && manager.binaryExists() && fetchCoreModule.installedVersion() === release.version) {
        task.result = { skipped: true, version: release.version, path: paths.binPath, source: "already-installed" };
        applyProgress({ phase: "complete" });
      } else {
        if (wasRunning) {
          applyProgress({ phase: "stopping" });
          // Restore the bridge even if stopping the core fails after the
          // bridge has stopped. Never replace a binary while stop failed.
          stoppedForInstall = true;
          bridge.stopBridge();
          await manager.stop();
          if (await coreRunning()) throw new Error("failed to stop the running core");
        }
        const result = await fetchCoreModule.downloadAndInstall(release, { signal, onProgress: applyProgress });
        task.result = result;
        applyProgress({ phase: "complete" });
        if (stoppedForInstall) await restartCoreAfterInstall("complete");
      }
    } catch (error) {
      const terminalPhase = isAbort(error) ? "canceled" : "failed";
      if (isAbort(error)) {
        applyProgress({ phase: "canceled", message: "download canceled" });
      } else {
        applyProgress({ phase: "failed" });
        task.error = error?.message || String(error);
      }
      // The core was stopped to make way for the install — bring it back
      // whatever the outcome (install failure, cancel), or the proxy dies
      // silently.
      if (stoppedForInstall) await restartCoreAfterInstall(terminalPhase);
    } finally {
      task.running = false;
      task.cancellable = false;
      task.finishedAt = new Date().toISOString();
      controller = null;
    }
  }

  return {
    snapshot,

    // Starts the install task and returns immediately with its snapshot.
    startInstall({ force = false } = {}) {
      if (task?.running) {
        const error = new Error("the core is already performing another operation");
        error.statusCode = 409;
        throw error;
      }
      controller = new AbortController();
      const signal = controller.signal;
      task = {
        running: true,
        cancellable: true,
        phase: "checking",
        source: null,
        downloaded: 0,
        total: null,
        percent: null,
        message: null,
        error: null,
        result: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      void run(signal, force).catch(() => {}); // run() handles its own failures
      return snapshot();
    },

    cancelInstall() {
      if (task?.running && controller) controller.abort();
      return snapshot();
    },
  };
}

let defaultInstance = null;

// The api.js-mounted singleton; built lazily so requiring this module never
// pulls the fetch-core script (or its network calls) at load time.
function getInstance() {
  if (!defaultInstance) {
    defaultInstance = createCoreInstallService({
      manager: require("./manager"),
      bridge: require("./usage-bridge"),
      fetchCoreModule: require("../../../scripts/fetch-core.cjs"),
    });
  }
  return defaultInstance;
}

module.exports = { createCoreInstallService, getInstance };
