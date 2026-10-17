"use strict";

// cc-switch's stale-client notice and graceful daemon restart, adapted to
// AiTool's file projections. Only digests of model catalogs/login identities
// are retained. Reading status never restarts a client.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { runCommand, resolveBinaryPath, resolvedCliEnvironment } = require("../command-runner");
const { updateJsonLocked, ensureDir } = require("../fs");
const paths = require("./paths");
const { codexIdentityOf, codexAuthHasCredentialLoginMaterial } = require("./targets");
const toml = require("./toml");

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}
function codexDirectory() { return path.dirname(paths.targetFile("codex", "config").path); }
function historyPath() { return path.join(paths.providerSwitchRoot(), "codex-client-history.json"); }

async function fingerprint() {
  const directory = codexDirectory();
  let config = "";
  try { config = await fs.readFile(path.join(directory, "config.toml"), "utf8"); } catch {}
  const pointer = toml.getTopLevelValue(config, "model_catalog_json");
  let catalog = "none";
  if (typeof pointer === "string" && pointer) {
    try {
      const file = path.isAbsolute(pointer) ? pointer : path.join(directory, pointer);
      catalog = digest(await fs.readFile(file));
    } catch { catalog = "unreadable"; }
  }
  const auth = await readJson(path.join(directory, "auth.json"));
  const identity = codexAuthHasCredentialLoginMaterial(auth) ? codexIdentityOf(auth) : null;
  return { catalog, login: identity ? digest(identity) : null };
}

function elapsedMs(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((v) => Number(v || 0));
  if (seconds >= 60 || minutes >= 60) return null;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function appServerRole(command) {
  const match = /(?:^|[/\\])codex(?:\.exe)?\s+(.+)$/.exec(command);
  if (!match) return null;
  const words = match[1].trim().split(/\s+/);
  let i = 0;
  while (words[i]?.startsWith("-")) {
    if (["-c", "--config"].includes(words[i])) i += 2;
    else i++;
  }
  if (words[i] !== "app-server" || ["daemon", "proxy"].includes(words[i + 1])) return null;
  return words.includes("--managed-daemon") ? "daemon" : "other";
}

async function probe({ commandRunner, platform = process.platform, nowMs = Date.now() } = {}) {
  const directory = codexDirectory();
  const record = await readJson(path.join(directory, "app-server-daemon", "daemon.pid"));
  const pid = Number(record?.pid);
  const result = { daemon: null, others: [], unverified: true };
  if (platform === "win32") {
    // Query process identity and FILETIME together; a recycled PID is never
    // enough evidence to offer a restart for this configuration directory.
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof record.processStartTime !== "string") return result;
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'codex') { $p.StartTime.ToFileTimeUtc().ToString() }`;
    const output = await runCommand(commandRunner, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 3000, windowsHide: true });
    if (output.status === 0 && String(output.stdout).trim() === record.processStartTime) {
      try { result.daemon = Number(BigInt(record.processStartTime) / 10000n - 11644473600000n); } catch {}
    }
    return result;
  }
  const output = await runCommand(commandRunner, "ps", ["-Ao", "pid=,etime=,command="], { timeout: 3000 });
  if (output.error || output.status !== 0) return result;
  result.unverified = false;
  for (const line of String(output.stdout).split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const duration = elapsedMs(match[2]);
    const role = appServerRole(match[3]);
    if (duration === null || !role) continue;
    const started = Math.max(0, nowMs - duration);
    if (role === "daemon" && Number(match[1]) === pid) result.daemon = started;
    else if (role === "other" && !match[3].startsWith(path.join(directory, "plugins") + path.sep)) result.others.push(started);
  }
  return result;
}

async function observe(nowMs) {
  const current = await fingerprint();
  await ensureDir(paths.providerSwitchRoot());
  let snapshot;
  await updateJsonLocked(historyPath(), (previous) => {
    const history = previous?.version === 1 && Array.isArray(previous.generations) ? previous : { version: 1, generations: [], acknowledged: current };
    const last = history.generations.at(-1);
    if (!last || last.catalog !== current.catalog || last.login !== current.login) {
      history.generations.push({ sinceMs: nowMs, ...current });
      history.generations = history.generations.slice(-64);
    }
    snapshot = history;
    return history;
  });
  return { current, snapshot };
}

async function getCodexClientStatus(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const { current, snapshot } = await observe(nowMs);
  const processes = await probe({ ...options, nowMs });
  const changesFor = (started) => {
    const previous = [...snapshot.generations].reverse().find((row) => row.sinceMs <= started) || snapshot.generations[0];
    if (!previous) return { catalog: false, auth: false };
    return { catalog: previous.catalog !== current.catalog, auth: previous.login !== current.login };
  };
  const daemonChanges = processes.daemon !== null ? changesFor(processes.daemon) : { catalog: false, auth: false };
  const otherChanges = processes.others.map(changesFor);
  const acknowledged = snapshot.acknowledged || current;
  if (processes.unverified) otherChanges.push({ catalog: acknowledged.catalog !== current.catalog, auth: acknowledged.login !== current.login });
  const daemonStale = daemonChanges.catalog || daemonChanges.auth;
  const othersStale = otherChanges.some((row) => row.catalog || row.auth);
  return {
    daemonRunning: processes.daemon !== null,
    daemon: daemonStale,
    others: othersStale,
    auth: daemonChanges.auth || otherChanges.some((row) => row.auth),
    catalog: daemonChanges.catalog || otherChanges.some((row) => row.catalog),
    unverified: processes.unverified,
    revision: digest(JSON.stringify(current)),
  };
}

async function acknowledgeCodexClients() {
  const current = await fingerprint();
  await ensureDir(paths.providerSwitchRoot());
  await updateJsonLocked(historyPath(), (previous) => ({ ...previous, version: 1, generations: previous?.generations || [], acknowledged: current }));
}

const restarts = new Map();
function restartCodexDaemon(options = {}) {
  const directory = codexDirectory();
  if (restarts.has(directory)) return restarts.get(directory);
  const task = (async () => {
    const processes = await probe(options);
    if (processes.daemon === null) return { outcome: "notRunning" };
    const settings = await readJson(path.join(directory, "app-server-daemon", "settings.json"));
    const configured = settings?.shutdownGraceSeconds;
    const grace = Number.isSafeInteger(configured) && configured >= 0 ? Math.min(configured, 300) : 60;
    const executable = options.executable || await resolveBinaryPath("codex", options);
    if (!executable) throw new Error("Codex CLI is unavailable.");
    const env = { ...resolvedCliEnvironment(executable, { platform: options.platform || process.platform }), CODEX_HOME: directory };
    const output = await runCommand(options.commandRunner, executable, ["app-server", "daemon", "restart"], {
      env, cwd: directory, timeout: (grace + 75) * 1000, maxBuffer: 1024 * 1024,
      windowsHide: true, useShell: (options.platform || process.platform) === "win32" && /\.(cmd|bat)$/i.test(executable),
    });
    // CLI diagnostics may include local credentials; surface a bounded generic
    // failure instead of passing its stdout/stderr through the API.
    if (output.error || output.status !== 0) throw new Error(output.error?.code === "ETIMEDOUT" ? "Codex daemon restart timed out." : "Codex daemon restart failed.");
    const last = String(output.stdout).trim().split("\n").at(-1);
    let lifecycle = null;
    try { lifecycle = JSON.parse(last)?.status; } catch {}
    return { outcome: lifecycle === "notRunning" ? "notRunning" : "restarted" };
  })().finally(() => restarts.delete(directory));
  restarts.set(directory, task);
  return task;
}

module.exports = { getCodexClientStatus, acknowledgeCodexClients, restartCodexDaemon, noteCodexState: () => observe(Date.now()), appServerRole, elapsedMs };
