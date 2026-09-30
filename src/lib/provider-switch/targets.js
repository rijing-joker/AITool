const floor = require("./floor");
const toml = require("./toml");
const envfile = require("./envfile");
const catalog = require("./catalog");

// Provider → live-file projections, ported from cc-switch's
// live/project/{claude,codex,gemini}.rs. Each projection computes the next
// live content as a minimal patch: write the target provider's key fields,
// remove the previous provider's residue (only when the user hasn't touched
// the value since), and leave every other byte/field alone. All functions
// are pure — callers read the live files, back them up, and write the
// results atomically.

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function stableEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Claude Code — ~/.claude/settings.json
// ---------------------------------------------------------------------------

// settingsConfig shape: any JSON object; only floor keys (env + top level)
// are projected, everything else in the preset is ignored on switch.
function projectClaude({ prev, target, live }) {
  if (live === null || typeof live !== "object" || Array.isArray(live)) {
    throw new Error("Live ~/.claude/settings.json is missing or not a JSON object");
  }
  const next = JSON.parse(JSON.stringify(live));
  const prevConfig = (prev && prev.settingsConfig) || {};
  const targetConfig = (target && target.settingsConfig) || {};
  const prevEnv = prevConfig.env || {};
  const targetEnv = targetConfig.env || {};

  const liveEnv = next.env && typeof next.env === "object" && !Array.isArray(next.env) ? { ...next.env } : {};

  // Residue: env keys the previous provider owns, still at the value it
  // wrote, and not re-defined by the target.
  for (const key of Object.keys(prevEnv)) {
    if (!floor.isClaudeProjectedEnv(key)) continue;
    if (hasOwn(targetEnv, key)) continue;
    if (hasOwn(liveEnv, key) && stableEqual(liveEnv[key], prevEnv[key])) delete liveEnv[key];
  }
  for (const key of Object.keys(targetEnv)) {
    if (!floor.isClaudeProjectedEnv(key)) continue;
    liveEnv[key] = targetEnv[key];
  }
  if (Object.keys(liveEnv).length > 0) next.env = liveEnv;
  else delete next.env;

  for (const key of Object.keys(prevConfig)) {
    if (!floor.isClaudeFloorTop(key)) continue;
    if (hasOwn(targetConfig, key)) continue;
    if (hasOwn(next, key) && stableEqual(next[key], prevConfig[key])) delete next[key];
  }
  for (const key of Object.keys(targetConfig)) {
    if (!floor.isClaudeFloorTop(key)) continue;
    next[key] = targetConfig[key];
  }
  return next;
}

// ---------------------------------------------------------------------------
// Codex — ~/.codex/config.toml + ~/.codex/auth.json
// ---------------------------------------------------------------------------

// settingsConfig shape: { auth: object|null, config: { ...floor keys,
// model_providers?: { custom?: { base_url, wire_api, ... } } } }.
// auth.json belongs to the official ChatGPT login only: switching away from
// the official provider stashes it (restored when switching back); a preset
// may also carry explicit auth content which is written as-is.
function projectCodex({ prev, target, liveToml, liveAuth, stash }) {
  if (typeof liveToml !== "string") {
    throw new Error("Live ~/.codex/config.toml is missing (create it or run Codex once)");
  }
  const prevConfig = { ...((prev && prev.settingsConfig && prev.settingsConfig.config) || {}) };
  const targetConfig = { ...((target && target.settingsConfig && target.settingsConfig.config) || {}) };

  // The model catalog sidecar rides on provider meta; inject its config.toml
  // pointer as a virtual floor key so the generic residue logic below manages
  // it (set for the target, removed when only the previous provider owned it
  // and the pointer still reads our filename).
  const prevCatalog = catalog.catalogRowsOf(prev);
  const targetCatalog = catalog.catalogRowsOf(target);
  if (prevCatalog.length > 0) prevConfig.model_catalog_json = catalog.CODEX_CATALOG_FILENAME;
  if (targetCatalog.length > 0) targetConfig.model_catalog_json = catalog.CODEX_CATALOG_FILENAME;

  let text = liveToml;

  // Top-level floor keys: residue first, then the target's values.
  const managedKeys = new Set([...floor.CODEX_FLOOR_TOP, ...Object.keys(prevConfig), ...Object.keys(targetConfig)]);
  for (const key of managedKeys) {
    if (!floor.isCodexFloorTop(key)) continue;
    if (hasOwn(targetConfig, key)) continue;
    if (!hasOwn(prevConfig, key)) continue;
    const current = toml.getTopLevelValue(text, key);
    if (current !== undefined && stableEqual(current, prevConfig[key])) {
      text = toml.removeTopLevelKey(text, key);
    }
  }
  for (const key of Object.keys(targetConfig)) {
    if (!floor.isCodexFloorTop(key)) continue;
    text = toml.setTopLevelKey(text, key, targetConfig[key]);
  }

  // [model_providers.custom] is owned wholesale by the switcher.
  const targetTable = targetConfig.model_providers && targetConfig.model_providers.custom;
  const prevTable = prevConfig.model_providers && prevConfig.model_providers.custom;
  if (targetTable && typeof targetTable === "object") {
    const entries = {};
    for (const [key, value] of Object.entries(targetTable)) {
      if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
        entries[key] = value;
      }
    }
    text = toml.setTable(text, floor.CODEX_PROVIDER_TABLE, entries);
  } else {
    // Remove when the previous provider wrote one and the target has none.
    const liveTable = toml.getTableEntries(text, floor.CODEX_PROVIDER_TABLE);
    const unchanged = liveTable && prevTable && stableEqual(liveTable, normalizeTable(prevTable));
    if (liveTable && (prevTable ? unchanged : true)) {
      text = toml.setTable(text, floor.CODEX_PROVIDER_TABLE, null);
    }
  }

  // Sidecar action for the caller: write the catalog file for the target,
  // remove ours when only the previous provider had one, or leave it alone.
  const catalogAction = targetCatalog.length > 0
    ? { action: "write", models: targetCatalog }
    : prevCatalog.length > 0
      ? { action: "remove" }
      : { action: "keep" };

  return { configToml: text, auth: resolveCodexAuth({ prev, target, liveAuth, stash }), catalog: catalogAction };
}

function normalizeTable(entries) {
  const out = {};
  for (const [key, value] of Object.entries(entries || {})) {
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      out[key] = value;
    }
  }
  return out;
}

// Decision: "keep" | { action: "write", content } — stash file handling is
// done by the caller (it is a separate 0600 file).
function resolveCodexAuth({ prev, target, liveAuth, stash }) {
  const targetAuth = (target && target.settingsConfig && target.settingsConfig.auth) || null;
  const targetOfficial = !!target && target.category === "official";
  const prevOfficial = !!prev && prev.category === "official";
  const liveAuthObject = liveAuth && typeof liveAuth === "object" && Object.keys(liveAuth).length > 0 ? liveAuth : null;

  if (targetAuth) return { action: "write", content: targetAuth };
  if (targetOfficial) {
    // Switching back to the official provider: restore the stashed login if
    // the live auth file is empty; never clobber a fresh login.
    if (stash && typeof stash === "object" && Object.keys(stash).length > 0 && !liveAuthObject) {
      return { action: "write", content: stash, restoreStash: true };
    }
    return { action: "keep" };
  }
  // Leaving the official provider (or first switch) with a live login:
  // stash it and clear auth.json so stale tokens never reach a third party.
  if (liveAuthObject && (!prev || prevOfficial)) {
    return { action: "stash", content: {}, stashContent: liveAuthObject };
  }
  return { action: "keep" };
}

// ---------------------------------------------------------------------------
// Gemini CLI — ~/.gemini/.env
// ---------------------------------------------------------------------------

// settingsConfig shape: { env: { GEMINI_API_KEY: "...", ... } }; only floor
// env keys are projected.
function projectGemini({ prev, target, liveEnv }) {
  if (typeof liveEnv !== "string") {
    throw new Error("Live ~/.gemini/.env is missing (create it or run Gemini CLI once)");
  }
  const prevEnv = (prev && prev.settingsConfig && prev.settingsConfig.env) || {};
  const targetEnv = (target && target.settingsConfig && target.settingsConfig.env) || {};

  let text = liveEnv;
  for (const key of Object.keys(prevEnv)) {
    if (!floor.isGeminiFloorEnv(key)) continue;
    if (hasOwn(targetEnv, key)) continue;
    const current = envfile.getEnvValue(text, key);
    if (current !== undefined && stableEqual(current, String(prevEnv[key]))) {
      text = envfile.removeEnvValue(text, key);
    }
  }
  for (const key of Object.keys(targetEnv)) {
    if (!floor.isGeminiFloorEnv(key)) continue;
    text = envfile.setEnvValue(text, key, String(targetEnv[key]));
  }
  return text;
}

// ---------------------------------------------------------------------------
// Live extraction + merge (import-from-live and the editor view)
// ---------------------------------------------------------------------------

// Pull only the provider-owned (floor) fields out of a parsed live config —
// used when importing the current live state as a new provider, so
// user-owned keys (hooks, permissions, …) are never absorbed into a preset.
function extractClaudeConfig(live) {
  const out = {};
  if (!live || typeof live !== "object") return out;
  if (live.env && typeof live.env === "object") {
    const env = {};
    for (const [key, value] of Object.entries(live.env)) {
      if (floor.isClaudeProjectedEnv(key)) env[key] = value;
    }
    if (Object.keys(env).length > 0) out.env = env;
  }
  for (const key of Object.keys(live)) {
    if (floor.isClaudeFloorTop(key)) out[key] = live[key];
  }
  return out;
}

function extractCodexConfig(liveToml) {
  const config = {};
  if (typeof liveToml !== "string") return { auth: null, config };
  for (const key of floor.CODEX_FLOOR_TOP) {
    const value = toml.getTopLevelValue(liveToml, key);
    if (value !== undefined) config[key] = value;
  }
  const table = toml.getTableEntries(liveToml, floor.CODEX_PROVIDER_TABLE);
  if (table && Object.keys(table).length > 0) {
    config.model_providers = { custom: table };
  }
  return { auth: null, config };
}

function extractGeminiConfig(liveEnv) {
  const env = {};
  if (typeof liveEnv !== "string") return { env };
  for (const entry of envfile.parseEnvFile(liveEnv)) {
    if (floor.isGeminiFloorEnv(entry.key)) env[entry.key] = entry.value;
  }
  return { env };
}

// Editor-view merge (cc-switch's read_live_provider_settings): when editing
// the *current* provider, the live files may have been hand-edited since the
// switch — overlay the live value onto every key the provider itself owns,
// so the form shows the state that is actually in effect. Only provider-
// defined paths are overlaid; live keys the provider never managed stay out.
function mergeLiveIntoSettingsConfig(app, settingsConfig, live) {
  const merged = JSON.parse(JSON.stringify(settingsConfig || {}));

  if (app === "claude") {
    const liveConfig = live && typeof live === "object" ? live : {};
    const liveEnv = liveConfig.env && typeof liveConfig.env === "object" ? liveConfig.env : {};
    if (merged.env && typeof merged.env === "object") {
      for (const key of Object.keys(merged.env)) {
        if (key in liveEnv) merged.env[key] = liveEnv[key];
      }
    }
    for (const key of Object.keys(merged)) {
      if (key === "env") continue;
      if (key in liveConfig) merged[key] = liveConfig[key];
    }
    return merged;
  }

  if (app === "codex") {
    const liveToml = typeof live === "string" ? live : "";
    const config = merged.config && typeof merged.config === "object" ? merged.config : {};
    for (const key of Object.keys(config)) {
      if (key === "model_providers") continue;
      const value = toml.getTopLevelValue(liveToml, key);
      if (value !== undefined) config[key] = value;
    }
    const providerTable =
      config.model_providers && typeof config.model_providers === "object" ? config.model_providers.custom : null;
    if (providerTable && typeof providerTable === "object") {
      const liveTable = toml.getTableEntries(liveToml, floor.CODEX_PROVIDER_TABLE) || {};
      for (const key of Object.keys(providerTable)) {
        if (key in liveTable) providerTable[key] = liveTable[key];
      }
    }
    return merged;
  }

  if (app === "gemini") {
    const liveEnv = typeof live === "string" ? live : "";
    if (merged.env && typeof merged.env === "object") {
      for (const key of Object.keys(merged.env)) {
        const value = envfile.getEnvValue(liveEnv, key);
        if (value !== undefined) merged.env[key] = value;
      }
    }
    return merged;
  }

  return merged;
}

module.exports = {
  projectClaude,
  projectCodex,
  projectGemini,
  resolveCodexAuth,
  extractClaudeConfig,
  extractCodexConfig,
  extractGeminiConfig,
  mergeLiveIntoSettingsConfig,
};
