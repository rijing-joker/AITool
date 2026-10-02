const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const YAML = require("yaml");
const paths = require("./paths");

// Bootstrap config for the CLIProxyAPI core. Only the fields AiTool must pin
// live here; everything else (client api-keys, upstream providers, aliases,
// request rules) is managed at runtime through the core's Management API and
// persists back into this same file.
//
// The plaintext management key lives in AiTool's own settings.json, not in
// config.yaml: the core bcrypt-hashes `management.secret-key` in place on
// first load, so config.yaml alone can never authenticate the dashboard
// (same constraint EasyCLIProxyAPI solves by keeping the key in its GUI config).
// Docker / reverse-proxy deployments set AITOOL_BIND_HOST so the dashboard
// and the core are reachable through published container ports. Empty by
// default = loopback only, matching the local-first security posture.
function configuredBindHost() {
  return String(process.env.AITOOL_BIND_HOST || "").trim();
}

function defaultConfigYaml(managementKey) {
  return YAML.stringify({
    "config-version": 8,
    server: {
      // Loopback only — the dashboard proxies management calls, so the core
      // never needs to be reachable from the network by default. 8318 (not
      // the core's conventional 8317) so AiTool coexists with a standalone
      // CLIProxyAPI / EasyCLIProxyAPI install on the same machine.
      host: configuredBindHost() || "127.0.0.1",
      port: 8318,
    },
    management: {
      "allow-remote": false,
      // Plaintext here; the core hashes it on first load.
      "secret-key": managementKey,
    },
    oauth: {
      "auth-dir": paths.authDir,
    },
    observability: {
      usage: {
        "usage-statistics-enabled": true,
        // Keep bridged events replayable after a bridge restart (max allowed).
        "redis-usage-queue-retention-seconds": 3600,
      },
    },
  });
}

function ensureDirs() {
  for (const dir of [paths.proxyRoot, paths.binDir, paths.authDir, paths.logsDir, paths.usageDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function configExists() {
  return fs.existsSync(paths.configPath);
}

// Returns {created} so callers can log first-run bootstrap distinctly.
// Always reconciles `management.secret-key` in config.yaml with the
// settings.json plaintext copy, so a core started afterwards accepts the
// dashboard's Bearer token even if the core hashed an earlier key.
// AITOOL_BIND_HOST is likewise reconciled: the host is a bootstrap-pinned
// field, and a config.yaml carried over from a loopback-only host (e.g. a
// mounted Docker volume) must follow the override instead of silently
// keeping the container unreachable.
function ensureConfig() {
  ensureDirs();
  const settings = readSettings();
  if (!settings.managementKey) {
    settings.managementKey = crypto.randomBytes(24).toString("hex");
    writeSettings(settings);
  }
  const bindHost = configuredBindHost();
  if (!configExists()) {
    fs.writeFileSync(paths.configPath, defaultConfigYaml(settings.managementKey), { mode: 0o600 });
    return { created: true };
  }
  const existing = readConfig();
  let changed = false;
  if (existing && bindHost && existing?.server?.host !== bindHost) {
    existing.server = { ...(existing.server || {}), host: bindHost };
    changed = true;
  }
  if (existing && existing?.management?.["secret-key"] !== settings.managementKey) {
    existing.management = { ...(existing.management || {}), "secret-key": settings.managementKey };
    changed = true;
  }
  if (changed) writeConfig(existing);
  return { created: false };
}

function readConfig() {
  if (!configExists()) return null;
  try {
    return YAML.parse(fs.readFileSync(paths.configPath, "utf8")) || {};
  } catch {
    return null;
  }
}

function writeConfig(configObject) {
  ensureDirs();
  fs.writeFileSync(paths.configPath, YAML.stringify(configObject), { mode: 0o600 });
}

function getServerPort(configObject) {
  const cfg = configObject || readConfig() || {};
  const port = Number(cfg?.server?.port);
  return Number.isFinite(port) && port > 0 ? port : 8318;
}

function getServerHost(configObject) {
  const cfg = configObject || readConfig() || {};
  const host = String(cfg?.server?.host || "").trim();
  return host || "127.0.0.1";
}

function getManagementKey(configObject) {
  // The settings copy is authoritative (config.yaml's copy is bcrypt-hashed
  // by the core after first load). Hashed-looking values are never usable.
  const looksHashed = (value) => !value || value.startsWith("$2") || /^[0-9a-f]{64}$/i.test(value);
  const settingsKey = String(readSettings().managementKey || "").trim();
  if (!looksHashed(settingsKey)) return settingsKey;
  const cfg = configObject || readConfig() || {};
  const yamlKey = String(cfg?.management?.["secret-key"] || "").trim();
  if (!looksHashed(yamlKey)) return yamlKey;
  return "";
}

function getAuthDir(configObject) {
  const cfg = configObject || readConfig() || {};
  const dir = String(cfg?.oauth?.["auth-dir"] || "").trim();
  if (!dir) return paths.authDir;
  if (dir.startsWith("~")) return path.join(os.homedir(), dir.slice(1));
  return dir;
}

// settings.json — AiTool-side proxy preferences (not core config).
//   autoStart: bridge + core start when the dashboard server boots.
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(paths.settingsPath, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  ensureDirs();
  fs.writeFileSync(paths.settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

module.exports = {
  ensureConfig,
  ensureDirs,
  configExists,
  readConfig,
  writeConfig,
  getServerPort,
  getServerHost,
  getManagementKey,
  getAuthDir,
  readSettings,
  writeSettings,
};
