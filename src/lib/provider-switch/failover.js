// Provider failover monitor (provider-switch layer). Watches the proxy's
// per-request usage records for the ACTIVE provider of each app and, when
// its recent failure rate crosses the configured threshold, puts it into a
// cooldown: the dashboard shows a switch suggestion (autoSwitch off) or the
// monitor switches to the next healthy provider itself (autoSwitch on).
//
// Request-to-provider matching is heuristic but stable: a row matches when
// its api_key_hash equals the hash of a credential found in the provider's
// settingsConfig, or when its core-side provider name equals the row's
// provider name. Records only exist for traffic that went through the Go
// core — direct upstream connections are invisible here by design.
//
// State (config + cooldowns + last actions) lives in one JSON file under
// ~/.aitool/provider-switch, separate from providers.json so the store
// schema stays untouched.

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { updateJsonLocked } = require("../fs");
const store = require("./store");
const paths = require("./paths");
const recordStore = require("../proxy/usage-records").createUsageRecordStore();

const DEFAULT_CONFIG = {
  enabled: false,
  autoSwitch: false,
  windowMinutes: 30,
  minRequests: 5,
  failureRatePct: 50,
  cooldownMinutes: 30,
};
const MAX_ACTIONS = 50;

function failoverStatePath() {
  return path.join(paths.providerSwitchRoot(), "failover-state.json");
}

// The proxy's usage records dir, resolved lazily so tests can point HOME at
// a temp directory (src/lib/proxy/paths.js resolves at require time).
function proxyUsageDir() {
  return path.join(os.homedir(), ".aitool", "proxy", "usage");
}

function clampInt(value, min, max, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled === true,
    autoSwitch: source.autoSwitch === true,
    windowMinutes: clampInt(source.windowMinutes, 1, 24 * 60, DEFAULT_CONFIG.windowMinutes),
    minRequests: clampInt(source.minRequests, 1, 1000, DEFAULT_CONFIG.minRequests),
    failureRatePct: clampInt(source.failureRatePct, 1, 100, DEFAULT_CONFIG.failureRatePct),
    cooldownMinutes: clampInt(source.cooldownMinutes, 1, 24 * 60, DEFAULT_CONFIG.cooldownMinutes),
  };
}

async function readState() {
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(failoverStatePath(), "utf8"));
  } catch {
    parsed = null;
  }
  return normalizeState(parsed);
}

// All mutations go through the same file lock the provider store uses. The
// update callback receives the freshly-read state so concurrent evaluations
// merge cooldown/action changes instead of overwriting the file wholesale.
async function mutateState(update) {
  return updateJsonLocked(failoverStatePath(), (current) => {
    const state = normalizeState(current);
    const next = update(state);
    return next === undefined ? state : next;
  });
}

function normalizeState(value) {
  const cooldowns = {};
  const saved = value && typeof value === "object" ? value.cooldowns : null;
  if (saved && typeof saved === "object") {
    for (const [key, entry] of Object.entries(saved)) {
      if (entry && typeof entry === "object" && Number.isFinite(Number(entry.until))) {
        cooldowns[key] = { until: Number(entry.until), reason: String(entry.reason || ""), since: Number(entry.since) || 0 };
      }
    }
  }
  return {
    config: normalizeConfig(value && value.config),
    cooldowns,
    actions: Array.isArray(value?.actions) ? value.actions.slice(-MAX_ACTIONS) : [],
  };
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

const CREDENTIAL_KEYS = new Set([
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY", "apiKey", "api_key",
]);

// First credential-looking string in the provider's settingsConfig, walking
// nested objects breadth-first. Placeholder values ($TOKEN$ proxies) and
// non-strings are skipped.
function findCredential(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCredential(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(key) && typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed && !trimmed.includes("$TOKEN$") && !trimmed.includes("://")) return trimmed;
    }
  }
  for (const item of Object.values(value)) {
    const found = findCredential(item, depth + 1);
    if (found) return found;
  }
  return null;
}

function providerCredentialHash(provider) {
  const key = findCredential(provider?.settingsConfig);
  return key ? sha256Hex(key) : null;
}

async function updateConfig(value) {
  const config = normalizeConfig(value);
  await mutateState((state) => ({ ...state, config }));
  return config;
}

async function clearCooldown(app, id) {
  if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  await mutateState((state) => {
    const cooldowns = { ...state.cooldowns };
    delete cooldowns[`${app}:${id}`];
    return { ...state, cooldowns };
  });
}

// Evaluates every app's active provider against recent proxy records.
// `switchFn` (injected to avoid a require cycle with api.js) performs an
// actual provider switch when autoSwitch is on.
async function evaluate({ switchFn = null, now = Date.now() } = {}) {
  const state = await readState();
  const config = state.config;
  const cooldowns = { ...state.cooldowns };
  const actions = [...state.actions];
  const status = { config, apps: {}, suggestions: [], cooldowns: [], actions: [] };
  if (!config.enabled) return status;

  let rows = [];
  try {
    rows = await recordStore.readRecords(proxyUsageDir());
  } catch {
    rows = [];
  }
  const windowStart = now - config.windowMinutes * 60_000;
  const windowRows = rows.filter((row) => {
    const ts = Date.parse(row.timestamp || "");
    return Number.isFinite(ts) && ts >= windowStart;
  });

  const healthOf = (provider) => {
    const hash = providerCredentialHash(provider);
    if (!hash && !provider?.name) return null;
    // Credential-hash match is authoritative; the core's provider field is an
    // executor-type label, so name matching is only a fallback for providers
    // without a usable credential.
    const matched = hash
      ? windowRows.filter((row) => row.api_key_hash === hash)
      : windowRows.filter((row) => provider.name && row.provider === provider.name);
    if (matched.length === 0) return null;
    const failed = matched.filter((row) => row.failed && !row.canceled).length;
    return { requests: matched.length, failed, ratePct: Math.round((failed / matched.length) * 100) };
  };

  const providerStore = await store.readStore();
  let stateDirty = false;
  const enteredCooldowns = {};
  const newActions = [];
  for (const app of store.SUPPORTED_APPS) {
    const { current, providers } = providerStore.apps[app];
    if (!providers.length) continue;
    const appInfo = { current, health: null, cooldown: null, suggestion: null, switchedTo: null };
    const cooldownKey = `${app}:${current}`;
    const currentProvider = current ? providers.find((provider) => provider.id === current) : null;

    if (currentProvider) {
      const health = healthOf(currentProvider);
      if (health) appInfo.health = health;
      if (health && health.requests >= config.minRequests && health.ratePct >= config.failureRatePct
        && !cooldowns[cooldownKey]) {
        cooldowns[cooldownKey] = enteredCooldowns[cooldownKey] = {
          until: now + config.cooldownMinutes * 60_000,
          reason: `${health.failed}/${health.requests} requests failed (${health.ratePct}%)`,
          since: now,
        };
        stateDirty = true;
      }
      const cooldown = cooldowns[cooldownKey] || null;
      if (cooldown && cooldown.until > now) {
        appInfo.cooldown = { ...cooldown, remainingMs: cooldown.until - now };
        const isCooling = (id) => (cooldowns[`${app}:${id}`]?.until ?? 0) > now;
        const candidate = providers.find((provider) =>
          provider.id !== currentProvider.id && !isCooling(provider.id));
        if (candidate) {
          appInfo.suggestion = { id: candidate.id, name: candidate.name };
          if (config.autoSwitch && switchFn) {
            try {
              await switchFn({ app, id: candidate.id });
              appInfo.switchedTo = candidate.id;
              newActions.push({ app, from: currentProvider.name, to: candidate.name, at: now });
              stateDirty = true;
            } catch (error) {
              appInfo.switchError = error?.message || String(error);
            }
          } else {
            status.suggestions.push({ app, from: currentProvider.name, to: candidate.name, id: candidate.id });
          }
        }
      }
    }
    status.apps[app] = appInfo;
  }

  const live = Object.entries(cooldowns).filter(([, entry]) => entry.until > now);
  status.cooldowns = live.map(([key, entry]) => {
    const separator = key.indexOf(":");
    return {
      app: key.slice(0, separator),
      id: key.slice(separator + 1),
      until: entry.until,
      reason: entry.reason,
      remainingMs: entry.until - now,
    };
  });
  if (stateDirty || live.length !== Object.keys(cooldowns).length) {
    // Merge under the file lock: drop expired entries from the saved state,
    // add the cooldowns entered during this evaluation, append actions. The
    // saved config always wins over the snapshot read at evaluation start.
    await mutateState((saved) => {
      const mergedCooldowns = { ...saved.cooldowns };
      for (const [key, entry] of Object.entries(mergedCooldowns)) {
        if (!(entry.until > now)) delete mergedCooldowns[key];
      }
      for (const [key, entry] of Object.entries(enteredCooldowns)) mergedCooldowns[key] = entry;
      return {
        config: saved.config,
        cooldowns: mergedCooldowns,
        actions: [...saved.actions, ...newActions].slice(-MAX_ACTIONS),
      };
    });
  }
  status.actions = [...actions, ...newActions].slice(-10);
  return status;
}

module.exports = { normalizeConfig, evaluate, updateConfig, clearCooldown, providerCredentialHash, findCredential, DEFAULT_CONFIG };
