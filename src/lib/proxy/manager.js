const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const paths = require("./paths");
const config = require("./config");
const management = require("./management");

// Lifecycle manager for the CLIProxyAPI core binary. The core is an external
// process (like EasyCLIProxyAPI treats it): AiTool never links it, it spawns
// `cli-proxy-api -config <config.yaml>` detached and talks to it over
// HTTP (Management API) and the RESP usage socket on the same port.

function binaryExists() {
  return fs.existsSync(paths.binPath);
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(paths.pidPath, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pid) {
  fs.mkdirSync(paths.proxyRoot, { recursive: true });
  fs.writeFileSync(paths.pidPath, String(pid), { mode: 0o600 });
}

function clearPid() {
  try {
    fs.unlinkSync(paths.pidPath);
  } catch {}
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    // signal 0 → existence probe; EPERM still means "alive".
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readBinaryVersion() {
  if (!binaryExists()) return null;
  return new Promise((resolve) => {
    // The core prints a "CLIProxyAPI Version: x.y.z" banner before flag
    // parsing, so even a rejected flag yields the version line.
    execFile(paths.binPath, ["-h"], { timeout: 5_000 }, (error, stdout) => {
      const match = String(stdout || "").match(/CLIProxyAPI Version:\s*([^\s,]+)/);
      resolve(match ? match[1] : null);
    });
  });
}

async function installCore({ sourcePath } = {}) {
  config.ensureDirs();
  if (sourcePath) {
    fs.copyFileSync(sourcePath, paths.binPath);
    fs.chmodSync(paths.binPath, 0o755);
    return { installed: true, path: paths.binPath, source: "local-file" };
  }
  const downloader = path.resolve(__dirname, "../../../scripts/fetch-core.cjs");
  if (!fs.existsSync(downloader)) {
    throw new Error("fetch-core script missing; reinstall AiTool or set AITOOL_CORE_BIN");
  }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [downloader], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`fetch-core exited ${code}`))));
    child.on("error", reject);
  });
  return { installed: true, path: paths.binPath, source: "download" };
}

async function start() {
  config.ensureConfig();
  if (!binaryExists()) {
    const envBin = process.env.AITOOL_CORE_BIN;
    if (envBin && fs.existsSync(envBin)) {
      await installCore({ sourcePath: envBin });
    } else {
      await installCore();
    }
  }

  const existingPid = readPid();
  if (pidAlive(existingPid)) {
    return { started: false, alreadyRunning: true, pid: existingPid };
  }
  clearPid();

  const port = config.getServerPort();
  const probe = await management.ping();
  if (probe.reachable && !probe.authError) {
    // Something is already listening on the management port and accepts our
    // key — treat it as the running core rather than spawning a duplicate.
    return { started: false, alreadyRunning: true, pid: null, external: true };
  }
  if (probe.reachable && probe.authError) {
    // Our own stale instance (pid file still alive) was started with an older
    // key — recycle it so the reconciled config takes effect. A foreign core
    // (no pid file) is not ours to kill.
    const stalePid = readPid();
    if (stalePid && pidAlive(stalePid)) {
      await stop();
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      throw new Error(`Port ${port} is in use by a core we cannot authenticate (stale management key?)`);
    }
  }

  fs.mkdirSync(paths.logsDir, { recursive: true });
  const logFd = fs.openSync(paths.coreLogPath, "a");
  const child = spawn(paths.binPath, ["-config", paths.configPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, AITOOL_MANAGED: "1" },
  });
  child.unref();
  fs.closeSync(logFd);
  writePid(child.pid);

  // Wait for the Management API to come up before declaring success.
  const deadline = Date.now() + 15_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!pidAlive(child.pid)) {
      clearPid();
      throw new Error(`Core exited during startup — see ${paths.coreLogPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const health = await management.ping();
    if (health.reachable && !health.authError) {
      return { started: true, pid: child.pid };
    }
    lastError = health.error || (health.authError ? "management auth rejected" : null);
  }
  throw new Error(`Core did not become healthy within 15s: ${lastError || "timeout"}`);
}

async function stop() {
  const pid = readPid();
  if (!pid || !pidAlive(pid)) {
    clearPid();
    return { stopped: false, running: false };
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      clearPid();
      return { stopped: true, running: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  clearPid();
  return { stopped: true, running: false };
}

async function status() {
  const binaryVersion = await readBinaryVersion();
  const pid = readPid();
  const running = pidAlive(pid);
  const probe = running ? await management.ping() : { reachable: false };
  const settings = config.readSettings();
  return {
    installed: binaryExists(),
    binary: binaryExists() ? paths.binPath : null,
    version: binaryVersion,
    running,
    pid: running ? pid : null,
    port: config.getServerPort(),
    host: config.getServerHost(),
    authDir: config.getAuthDir(),
    managementReachable: Boolean(probe.reachable) && !probe.authError,
    managementAuthError: Boolean(probe.authError),
    autoStart: settings.autoStart !== false,
    pidFile: paths.pidPath,
    logFile: paths.coreLogPath,
  };
}

module.exports = {
  binaryExists,
  installCore,
  start,
  stop,
  status,
  readPid,
  pidAlive,
  readBinaryVersion,
};
