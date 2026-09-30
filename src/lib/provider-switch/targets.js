const floor = require("./floor");
const toml = require("./toml");
const envfile = require("./envfile");

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
  const prevConfig = (prev && prev.settingsConfig && prev.settingsConfig.config) || {};
  const targetConfig = (target && target.settingsConfig && target.settingsConfig.config) || {};

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

  return { configToml: text, auth: resolveCodexAuth({ prev, target, liveAuth, stash }) };
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

module.exports = {
  projectClaude,
  projectCodex,
  projectGemini,
  resolveCodexAuth,
};
