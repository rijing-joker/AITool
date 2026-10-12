const fs = require("node:fs");
const os = require("node:os");
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
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
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
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    // signal 0 → existence probe; EPERM still means "alive".
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// A recycled PID must never let us signal an unrelated process, so before
// killing (or adopting) a pid-file PID its identity is verified like the
// original does by executable path (EasyCLIProxyAPI core_runtime.rs). Our
// core always runs as `<binPath> -config <configPath>`, and matching the
// config path keeps hands off same-binary cores pointed at another config
// (e.g. a separate install on this machine).
async function managedCoreAlive(pid, { platform = process.platform, execFileImpl = execFile } = {}) {
  if (!pid || !pidAlive(pid)) return false;
  if (platform === "linux") {
    // NUL-delimited arguments preserve paths containing spaces and distinguish
    // config.yaml from config.yaml.bak. This also works without ps installed.
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      return args[0] === paths.binPath
        && args.some((arg, index) => arg === "-config" && args[index + 1] === paths.configPath);
    } catch (error) {
      if ((error.code === "ENOENT" || error.code === "ESRCH") && !pidAlive(pid)) return false;
    }
  }
  const windows = platform === "win32";
  const result = await new Promise((resolve) => {
    const executable = windows ? "powershell.exe" : "ps";
    const args = windows
      ? ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`]
      : ["-ww", "-p", String(pid), "-o", "command="];
    execFileImpl(executable, args, { timeout: 5_000, windowsHide: true }, (error, stdout) => resolve({ error, stdout }));
  });
  if (!windows && result.error?.code === 1) return false;
  if (result.error) throw new Error(`Cannot verify core process ${pid}: ${result.error.message}`);
  let command = String(result.stdout || "").trim();
  if (windows) {
    if (!command) return false;
    let info;
    try { info = JSON.parse(command); } catch {}
    if (!info?.ExecutablePath || !info?.CommandLine) throw new Error(`Cannot verify core process ${pid}`);
    if (info.ExecutablePath.toLowerCase() !== paths.binPath.toLowerCase()) return false;
    command = info.CommandLine.trim();
  }
  if (!command) throw new Error(`Cannot verify core process ${pid}`);
  // ps/Windows flatten arguments. Match the complete launch command, allowing
  // quotes around paths, never a substring from an editor or another config.
  return [paths.binPath, `"${paths.binPath}"`].some((binary) =>
    [paths.configPath, `"${paths.configPath}"`].some((configPath) =>
      command === `${binary} -config ${configPath}`));
}

let versionCache = null;

async function readBinaryVersion() {
  let stat;
  try {
    stat = fs.statSync(paths.binPath, { bigint: true });
  } catch {
    versionCache = null;
    return null;
  }
  const key = `${paths.binPath}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  if (versionCache?.key === key && Date.now() < versionCache.expiresAt) return versionCache.promise;
  // Reprobe occasionally even when metadata is unchanged (coarse timestamp
  // filesystems can hide a same-size in-place replacement).
  const entry = { key, expiresAt: Date.now() + 5 * 60_000, promise: null };
  entry.promise = new Promise((resolve) => {
    // The core prints a "CLIProxyAPI Version: x.y.z" banner before flag
    // parsing, so even a rejected flag yields the version line.
    execFile(paths.binPath, ["-h"], { timeout: 5_000 }, (error, stdout) => {
      const match = String(stdout || "").match(/CLIProxyAPI Version:\s*([^\s,]+)/);
      // A failed/timed-out probe is transient. Coalesce it briefly, then retry.
      if (!match) entry.expiresAt = Date.now() + 1_000;
      resolve(match ? match[1] : null);
    });
  });
  versionCache = entry;
  return entry.promise;
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

// Build the core from a local CLIProxyAPI checkout (e.g. the user's fork with
// fixes not yet in an upstream release) and install that binary instead.
async function installFromRepo(repoPath) {
  const { execFile, execFileSync } = require("node:child_process");
  const repo = path.resolve(String(repoPath || ""));
  if (!fs.existsSync(path.join(repo, "cmd", "server", "main.go"))) {
    throw new Error(`not a CLIProxyAPI checkout: ${repo}`);
  }
  const out = path.join(os.tmpdir(), `aitool-core-${Date.now()}`);
  await new Promise((resolve, reject) => {
    execFile("go", ["build", "-o", out, "./cmd/server"], { cwd: repo, timeout: 300_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`go build failed: ${stderr || error.message}`));
      else resolve();
    });
  });
  let version = "dev-local";
  try {
    const short = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"]).toString().trim();
    version = `dev-local+${short}`;
  } catch {}
  config.ensureDirs();
  fs.copyFileSync(out, paths.binPath);
  fs.chmodSync(paths.binPath, 0o755);
  fs.writeFileSync(paths.coreVersionPath, `${version}\n`);
  try {
    fs.rmSync(out, { force: true });
  } catch {}
  return { installed: true, path: paths.binPath, source: `local-repo (${version})` };
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
  if (await managedCoreAlive(existingPid)) {
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
    // Our own stale instance (verified by command line) was started with an
    // older key — recycle it so the reconciled config takes effect. A foreign
    // core (no pid file, or a recycled PID we cannot identify) is not ours to
    // kill.
    const stalePid = readPid();
    if (await managedCoreAlive(stalePid)) {
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
  if (!(await managedCoreAlive(pid))) {
    // Nothing to stop, or the PID was recycled by a process that is not our
    // core — drop the stale pid file and never signal it.
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
  const running = await managedCoreAlive(pid);
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

// easy parity (Kernel.tsx restart_core_process): one action that recycles the
// core. The usage bridge goes down with it and the caller brings it back once
// the start handshake succeeds.
async function restart() {
  await stop();
  return start();
}

module.exports = {
  binaryExists,
  installCore,
  installFromRepo,
  start,
  stop,
  restart,
  status,
  readPid,
  pidAlive,
  managedCoreAlive,
  readBinaryVersion,
};
