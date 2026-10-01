"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { updateJsonLocked } = require("./fs");
const { execFileSync } = require("node:child_process");

function resolveQueuePath() {
  return path.join(os.homedir(), ".tokentracker", "tracker", "queue.jsonl");
}

/**
 * Path of the purge-surviving identity seed file.
 *
 * `uninstall --purge` removes all of `~/.tokentracker` including config.json,
 * which used to destroy the machineId: the reinstall minted a fresh id, the
 * cloud created a brand-new device row, and the full history replay was
 * double-counted next to the still-active old device (issue #176). The seed
 * lives OUTSIDE the purged tree so a reinstall recovers the exact id the
 * existing cloud device row is anchored to — including legacy random UUIDs
 * that cannot be re-derived from hardware.
 *
 * Derived from the queue path's home when it follows the standard
 * `<home>/.tokentracker/tracker/queue.jsonl` layout (keeps tests sandboxed in
 * their temp homes), falling back to the real home directory otherwise.
 */
function defaultSeedPath(queuePath) {
  const rootDir = path.dirname(path.dirname(queuePath));
  const home = path.basename(rootDir) === ".tokentracker" ? path.dirname(rootDir) : os.homedir();
  return path.join(home, ".config", "tokentracker", "machine-id");
}

function isValidMachineIdString(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function readSeedFile(seedPath) {
  try {
    const v = fs.readFileSync(seedPath, "utf8").trim();
    return isValidMachineIdString(v) ? v : null;
  } catch {
    return null;
  }
}

/** Best-effort: keep the seed file mirroring the active machineId. */
function mirrorSeedFile(seedPath, machineId) {
  if (!isValidMachineIdString(machineId)) return;
  if (readSeedFile(seedPath) === machineId) return;
  try {
    fs.mkdirSync(path.dirname(seedPath), { recursive: true });
    fs.writeFileSync(seedPath, `${machineId}\n`);
    try { fs.chmodSync(seedPath, 0o600); } catch { /* best effort */ }
  } catch {
    // Read-only home etc. — identity still works, it just won't survive purge.
  }
}

/**
 * dbus machine-id format: 32 lowercase hex chars. Rejects placeholder values
 * (all-zeros / a single repeated character) that cloned images sometimes ship.
 */
function isValidLinuxMachineId(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(v)) return false;
  if (/^(.)\1+$/.test(v)) return false;
  return true;
}

/**
 * Containers routinely share the image's (or host's) /etc/machine-id, so it is
 * NOT a per-machine identity there — two containers on one cloud account would
 * collapse onto one device row and their hourly upserts would overwrite each
 * other. Treat any container signal as "no stable id available".
 */
function isLinuxContainer({ env = process.env, pathExists = fs.existsSync, readFile = fs.readFileSync } = {}) {
  try {
    if (env.container) return true;
    if (pathExists("/.dockerenv") || pathExists("/run/.containerenv")) return true;
    const cgroup = String(readFile("/proc/1/cgroup", "utf8"));
    if (/docker|containerd|kubepods|lxc/i.test(cgroup)) return true;
  } catch {
    // Detection failure → assume not a container; the dbus-format validity
    // check still filters placeholder ids.
  }
  return false;
}

/**
 * Hardware-derived machine fingerprint, or null when no stable OS identifier
 * is available (containers, cloned-image placeholder ids, stripped-down hosts).
 *
 * Used as the machineId for FRESH generations (no seed to recover) so the id
 * survives `uninstall --purge` even when the seed file was deleted too: the
 * post-reinstall login lands on the SAME cloud device row and the history
 * replay upserts onto existing rows instead of duplicating them (issue #176).
 *
 * Privacy: the raw OS identifier never leaves the machine — it is hashed with
 * a fixed namespace plus the OS username (so two OS users sharing one machine
 * and one cloud account keep separate device rows and don't clobber each
 * other's hourly upserts).
 */
function computeStableMachineId({
  platform = process.platform,
  execFile = execFileSync,
  username,
  env = process.env,
  pathExists = fs.existsSync,
  readFile = fs.readFileSync,
} = {}) {
  let raw = null;
  try {
    if (platform === "darwin") {
      const out = execFile("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        timeout: 5000,
      });
      const m = String(out).match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/);
      raw = m ? m[1] : null;
    } else if (platform === "linux") {
      if (isLinuxContainer({ env, pathExists, readFile })) return null;
      for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const v = String(readFile(p, "utf8")).trim();
          if (isValidLinuxMachineId(v)) {
            raw = v.toLowerCase();
            break;
          }
        } catch {
          // try next candidate
        }
      }
    } else if (platform === "win32") {
      const out = execFile("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
        encoding: "utf8",
        timeout: 5000,
      });
      const m = String(out).match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      raw = m ? m[1] : null;
    }
  } catch {
    return null;
  }
  if (!raw) return null;
  let user = username;
  if (user == null) {
    try {
      user = os.userInfo().username;
    } catch {
      user = "";
    }
  }
  return crypto.createHash("sha256").update(`tokentracker-machine-v1:${raw}:${user}`).digest("hex");
}

/**
 * Stable per-MACHINE identifier, persisted in config.json next to the queue
 * and mirrored to a purge-surviving seed file (see defaultSeedPath).
 *
 * The dashboard uses this (not a per-browser localStorage id) as the cloud
 * device_name suffix, so every browser / WKWebView / cleared-cache session on
 * the SAME machine resolves to ONE cloud device_id. That keeps cross-device
 * SUM aggregation correct: one physical machine = one device (its cumulative
 * queue upserts onto a single row), while genuinely distinct machines stay
 * distinct devices that legitimately sum. Browser-keyed ids conflated one
 * machine into several device_ids and inflated the account-view total.
 *
 * Fresh-generation priority: seed file (recovers the exact id the existing
 * cloud device row is anchored to, including legacy random UUIDs) → hardware
 * fingerprint → random UUID. Existing config.json ids are never migrated —
 * their cloud device row is anchored to the old value.
 *
 * If configuration cannot be read or updated, recover the existing seed when
 * available; otherwise return null so the caller can use its own client id.
 */
// Resolved ids keyed by config.json path. Within a long-lived `serve` process
// the dashboard polls the machine-id endpoint (and heartbeat/cloud-sync paths
// re-resolve it) constantly; once the id is persisted the answer never changes,
// so caching it avoids taking a file lock on every call. A purge+reinstall that
// must re-derive the id happens across process restarts, where the cache starts
// empty — so this never masks recovery in production.
const resolvedMachineIds = new Map();

function _resetMachineIdCache() {
  resolvedMachineIds.clear();
}

async function getOrCreateMachineId(queuePath, { seedPath, stableMachineId } = {}) {
  const resolvedQueuePath = queuePath || resolveQueuePath();
  const configPath = path.join(path.dirname(resolvedQueuePath), "config.json");
  const resolvedSeedPath = seedPath || defaultSeedPath(resolvedQueuePath);
  const cached = resolvedMachineIds.get(configPath);
  if (typeof cached === "string" && cached.length >= 8) return cached;
  try {
    const config = await updateJsonLocked(configPath, (current) => {
      if (typeof current.machineId === "string" && current.machineId.length >= 8) return null;
      const generated = readSeedFile(resolvedSeedPath)
        || (stableMachineId === undefined ? computeStableMachineId() : stableMachineId)
        || crypto.randomUUID();
      return { ...current, machineId: generated };
    });
    mirrorSeedFile(resolvedSeedPath, config.machineId);
    if (typeof config.machineId === "string" && config.machineId.length >= 8) {
      resolvedMachineIds.set(configPath, config.machineId);
    }
    return config.machineId;
  } catch {
    // Preserve unreadable/corrupt configuration instead of discarding tokens.
    return readSeedFile(resolvedSeedPath);
  }
}

module.exports = {
  getOrCreateMachineId,
  _resetMachineIdCache,
  computeStableMachineId,
  isLinuxContainer,
  isValidLinuxMachineId,
  defaultSeedPath,
};
