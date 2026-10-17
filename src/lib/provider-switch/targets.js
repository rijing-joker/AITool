const floor = require("./floor");
const toml = require("./toml");
const envfile = require("./envfile");
const catalog = require("./catalog");
const { normalizeCodexProviderConfig } = require("./codex-provider-config");

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
// auth.json belongs to the official ChatGPT login only (cc-switch's current
// model, required since Codex 0.149 stopped reading auth.json keys for custom
// providers): the third-party key is injected into the route table as
// `experimental_bearer_token`, a live login is stashed on third-party switch
// (restored when switching back), and `requires_openai_auth` is recomputed
// from the credential kind + whether a login remains on disk.
function projectCodex({ prev, target, liveToml, liveAuth, stash }) {
  if (typeof liveToml !== "string") {
    throw new Error("Live ~/.codex/config.toml is missing (create it or run Codex once)");
  }
  const prevConfig = normalizeCodexProviderConfig(prev?.settingsConfig?.config, { official: prev?.category === "official" });
  const targetConfig = normalizeCodexProviderConfig(target?.settingsConfig?.config, { official: target?.category === "official" });

  // The model catalog sidecar rides on provider meta; inject its config.toml
  // pointer as a virtual floor key so the generic residue logic below manages
  // it (set for the target, removed when only the previous provider owned it
  // and the pointer still reads our filename).
  const prevCatalog = catalog.catalogRowsOf(prev);
  const targetCatalog = catalog.catalogRowsOf(target);
  if (prevCatalog.length > 0) prevConfig.model_catalog_json = catalog.CODEX_CATALOG_FILENAME;
  if (targetCatalog.length > 0) targetConfig.model_catalog_json = catalog.CODEX_CATALOG_FILENAME;

  let text = liveToml;
  // Route-based providers must not leave a second, obsolete endpoint or key
  // at top level. This also cleans a legacy live file on its first switch.
  for (const key of ["base_url", "openai_base_url", "wire_api", "experimental_bearer_token"]) {
    if (hasOwn(targetConfig, key)) continue;
    if (targetConfig.model_providers?.custom || hasOwn(prev?.settingsConfig?.config || {}, key)) {
      text = toml.removeTopLevelKey(text, key);
    }
  }

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

  // cc-switch 2ff37a76: provider-owned subagent defaults share [agents]
  // with user roles and limits. Only patch these two leaf keys.
  const liveAgents = require("smol-toml").parse(text || "").agents || {};
  for (const key of floor.CODEX_FLOOR_AGENTS) {
    if (hasOwn(targetConfig.agents || {}, key)) {
      text = toml.setTableValue(text, "agents", key, targetConfig.agents[key]);
    } else if (hasOwn(prevConfig.agents || {}, key) && stableEqual(liveAgents[key], prevConfig.agents[key])) {
      text = toml.setTableValue(text, "agents", key, undefined);
    }
  }
  const remainingAgents = require("smol-toml").parse(text || "").agents;
  if (remainingAgents && Object.keys(remainingAgents).length === 0) text = toml.replaceTable(text, "agents", null);

  // Auth decision first: whether a login remains on disk after the switch
  // feeds requires_openai_auth on the route table.
  const liveAuthObject = liveAuth && typeof liveAuth === "object" && Object.keys(liveAuth).length > 0 ? liveAuth : null;
  const auth = resolveCodexAuth({ prev, target, liveAuth, stash });
  const targetOfficial = !!target && target.category === "official";
  const loginOnDiskAfter =
    targetOfficial &&
    (liveAuthObject !== null ||
      (auth.action === "write" && auth.content && Object.keys(auth.content).length > 0));

  // [model_providers.custom] is owned wholesale by the switcher.
  const targetTable = targetConfig.model_providers && targetConfig.model_providers.custom;
  const prevTable = prevConfig.model_providers && prevConfig.model_providers.custom;
  if (targetTable && typeof targetTable === "object") {
    const entries = structuredClone(targetTable);
    applyCodexRouteAuth(entries, codexRowKey(target, entries), loginOnDiskAfter);
    text = toml.replaceTable(text, floor.CODEX_PROVIDER_TABLE, entries);
  } else {
    // Remove when the previous provider wrote one and the target has none.
    const liveTable = require("smol-toml").parse(text || "").model_providers?.custom;
    const unchanged = liveTable && prevTable && stableEqual(liveTable, normalizeTable(prevTable));
    if (unchanged) {
      text = toml.replaceTable(text, floor.CODEX_PROVIDER_TABLE, null);
    }
  }

  // Sidecar action for the caller: write the catalog file for the target,
  // remove ours when only the previous provider had one, or leave it alone.
  const catalogAction = targetCatalog.length > 0
    ? { action: "write", models: targetCatalog, options: {
      autoReviewModel: target.meta?.codexAutoReviewModel,
      speedTiersEnabled: target.meta?.codexSpeedTiersEnabled !== false,
    } }
    : prevCatalog.length > 0
      ? { action: "remove" }
      : { action: "keep" };

  return { configToml: text, auth, catalog: catalogAction, stashNext: auth.stashNext || null };
}

function normalizeTable(entries) {
  return structuredClone(entries || {});
}

// The provider row's key (cc-switch codex.rs row_key): auth.OPENAI_API_KEY
// first, then an experimental_bearer_token already written in the stored
// route table, then a top-level one (legacy Mobile 兼容形态).
function codexRowKey(target, tableEntries) {
  const rowAuth = target && target.settingsConfig && target.settingsConfig.auth;
  const fromAuth = rowAuth && typeof rowAuth === "object" ? String(rowAuth.OPENAI_API_KEY ?? "").trim() : "";
  if (fromAuth) return fromAuth;
  const fromTable = String((tableEntries && tableEntries.experimental_bearer_token) ?? "").trim();
  if (fromTable) return fromTable;
  const config = target && target.settingsConfig && target.settingsConfig.config;
  const fromTop = config && typeof config === "object" ? String(config.experimental_bearer_token ?? "").trim() : "";
  return fromTop;
}

function declaresAuthorizationHeader(headers) {
  if (!headers || typeof headers !== "object") return false;
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

// Where the route table's credentials come from (cc-switch declared_auth):
// the table may declare env_key or its own auth/headers; otherwise a row key
// rides in as experimental_bearer_token.
function codexRouteAuth(entries) {
  if ("env_key" in entries) return "env_key";
  if ("auth" in entries || "aws" in entries) return "headers";
  const requires = entries.requires_openai_auth === true;
  if (!requires && (declaresAuthorizationHeader(entries.http_headers) || declaresAuthorizationHeader(entries.env_http_headers))) {
    return "headers";
  }
  return "none";
}

// Mutates the route-table entries that will be written live: inject the row
// key as experimental_bearer_token, and recompute requires_openai_auth from
// the credential kind + whether a login remains on disk after the switch
// (cc-switch requires_openai_auth()). Codex 0.149+ ignores auth.json keys for
// custom providers — the table must carry the key itself.
function applyCodexRouteAuth(entries, rowKey, loginOnDiskAfter) {
  const declared = codexRouteAuth(entries);
  if (declared === "env_key") {
    entries.requires_openai_auth = !!loginOnDiskAfter;
    return;
  }
  if (declared === "headers") {
    delete entries.requires_openai_auth;
    return;
  }
  if (rowKey) {
    entries.experimental_bearer_token = rowKey;
    entries.requires_openai_auth = !!loginOnDiskAfter;
    return;
  }
  delete entries.requires_openai_auth;
}

// An auth.json holding only OPENAI_API_KEY is residue from the pre-bearer-
// token projection (or a stray key), not a ChatGPT login — clear it without
// stashing so switching back to official never restores a relay key.
function isCodexThirdPartyAuthResidue(auth) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
  if (Object.keys(auth).length === 0) return false;
  if (auth.tokens || auth.auth_mode === "chatgpt") return false;
  return Object.keys(auth).every((key) => key === "OPENAI_API_KEY");
}

// ---------------------------------------------------------------------------
// Codex login identity (cc-switch codex_login.rs, #8054): a login is the
// id_token user plus the ChatGPT workspace (tokens.account_id). The Plus and
// Team workspaces of one OpenAI user share the subject and differ only in
// account_id, so user-only identities collapsed their cards into one login.
// ---------------------------------------------------------------------------

// The `sub` claim of the id_token JWT: exactly three dot segments, the header
// decoding to JSON with a non-empty alg, the payload to JSON with a sub.
function codexIdTokenSubject(idToken) {
  if (typeof idToken !== "string") return null;
  const segments = idToken.split(".");
  if (segments.length !== 3) return null;
  const decode = (segment) => {
    try {
      return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    } catch {
      return null;
    }
  };
  const header = decode(segments[0]);
  const alg = header && typeof header.alg === "string" ? header.alg.trim() : "";
  if (!alg) return null;
  const claims = decode(segments[1]);
  const sub = claims && typeof claims.sub === "string" ? claims.sub.trim() : "";
  return sub || null;
}

function codexAuthUser(auth) {
  const idToken = auth && auth.tokens && typeof auth.tokens === "object" ? auth.tokens.id_token : null;
  const subject = codexIdTokenSubject(idToken);
  return subject ? `sub:${subject}` : null;
}

function codexAuthApiKey(auth) {
  const key = auth && typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY.trim() : "";
  return key || null;
}

function valuePresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// Anything Codex would treat as a login: any key (auth_mode excepted) with a
// present value — the OAuth token triple, a managed credential, or a bare API
// key (an OPENAI_API_KEY-only file is residue, handled before this check).
function codexAuthHasLoginMaterial(auth) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
  return Object.keys(auth).some((key) => key !== "auth_mode" && valuePresent(auth[key]));
}

function codexAuthHasCredentialLoginMaterial(auth) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
  for (const key of ["personal_access_token", "agent_identity", "bedrock_api_key"]) {
    if (valuePresent(auth[key])) return true;
  }
  const tokens = auth.tokens && typeof auth.tokens === "object" && !Array.isArray(auth.tokens) ? auth.tokens : null;
  return !!tokens && ["id_token", "access_token", "refresh_token"].some((key) => valuePresent(tokens[key]));
}

// Identity key: user + workspace when both, either when one is missing,
// "api-key" for key logins, "unknown" as the fallback (cc-switch identity()).
function codexIdentityOf(auth) {
  if (!auth || typeof auth !== "object") return "unknown";
  const user = codexAuthUser(auth);
  const account = auth.tokens && typeof auth.tokens === "object" && typeof auth.tokens.account_id === "string"
    ? auth.tokens.account_id.trim() || null
    : null;
  if (user && account) return `${user}|account:${account}`;
  if (user) return user;
  if (account) return `account:${account}`;
  if (codexAuthApiKey(auth)) return "api-key";
  return "unknown";
}

// Identity of a row that stores a real login (upstream oauth_identity).
function codexOauthIdentityOf(auth) {
  return codexAuthHasCredentialLoginMaterial(auth) ? codexIdentityOf(auth) : null;
}

function isCodexApiKeyCredential(auth) {
  return !!codexAuthApiKey(auth) && !codexAuthHasCredentialLoginMaterial(auth);
}

// ---------------------------------------------------------------------------
// Codex login stash (cc-switch LoginStash): a 0600 file holding every login
// seen on this machine keyed by identity, plus `last` — the most recently
// stashed one, restored for official cards that carry no login of their own.
// ---------------------------------------------------------------------------

const CODEX_STASH_VERSION = 1;

function emptyCodexStash() {
  return { version: CODEX_STASH_VERSION, logins: {}, last: null };
}

function normalizeCodexStash(raw) {
  if (raw && typeof raw === "object" && raw.logins && typeof raw.logins === "object" && !Array.isArray(raw.logins)) {
    const logins = {};
    for (const [id, auth] of Object.entries(raw.logins)) {
      if (auth && typeof auth === "object" && !Array.isArray(auth)) logins[id] = auth;
    }
    return { version: CODEX_STASH_VERSION, logins, last: typeof raw.last === "string" ? raw.last : null };
  }
  return null;
}

function codexStashPut(stash, auth) {
  const id = codexIdentityOf(auth);
  return { ...stash, logins: { ...stash.logins, [id]: auth }, last: id };
}

function codexStashTake(stash, id) {
  if (!stash.logins || !Object.prototype.hasOwnProperty.call(stash.logins, id)) {
    return { stash, auth: null };
  }
  const logins = { ...stash.logins };
  const auth = logins[id];
  delete logins[id];
  return { stash: { ...stash, logins, last: stash.last === id ? null : stash.last }, auth };
}

function codexStashChanged(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

// Older stash files predate workspace-aware identities (AiTool stored a
// single raw auth object; cc-switch 4.0.7 keyed by user only). Rekey by the
// current identity and restore workspaces merged away, seeded from the
// official cards' stored logins — but only for users still present in the
// stash or the live auth.json; a user found in neither has logged out and is
// not revived (cc-switch LoginStash::upgraded).
function upgradeCodexStash(raw, rowAuths, liveAuth) {
  const source = normalizeCodexStash(raw);
  const legacyAuths = [];
  if (source) {
    legacyAuths.push(...Object.values(source.logins));
  } else if (raw && typeof raw === "object" && raw.auth && typeof raw.auth === "object") {
    legacyAuths.push(raw.auth);
  }
  const live = liveAuth && codexAuthHasCredentialLoginMaterial(liveAuth) ? liveAuth : null;
  const users = new Set(
    [...legacyAuths, ...(live ? [live] : [])].map(codexAuthUser).filter(Boolean),
  );
  const logins = {};
  let last = null;
  for (const auth of legacyAuths) {
    logins[codexIdentityOf(auth)] = auth;
  }
  if (source && source.last && logins[source.last]) last = source.last;
  else if (legacyAuths.length === 1) last = codexIdentityOf(legacyAuths[0]);
  const liveIdentity = live ? codexIdentityOf(live) : null;
  for (const rowAuth of Array.isArray(rowAuths) ? rowAuths : []) {
    const id = codexOauthIdentityOf(rowAuth);
    if (!id || logins[id]) continue;
    const sameUser = codexAuthUser(rowAuth) && users.has(codexAuthUser(rowAuth));
    if (sameUser && liveIdentity !== id) logins[id] = rowAuth;
  }
  return { version: CODEX_STASH_VERSION, logins, last };
}

// Decision: "keep" | { action: "write", content } | { action: "stash" } —
// auth.json belongs to the official ChatGPT login only: the target row's
// OPENAI_API_KEY is projected into config.toml's route table instead (see
// applyCodexRouteAuth). `stashNext` carries the new multi-slot stash (null =
// unchanged); the caller persists it as a separate 0600 file.
// Port of cc-switch codex_login::plan: an official card with a stored login
// swaps logins through the stash, an unbound card follows the live login, and
// a third-party switch stashes the live login under its identity.
function resolveCodexAuth({ prev, target, liveAuth, stash }) {
  const targetOfficial = !!target && target.category === "official";
  const base = normalizeCodexStash(stash) || emptyCodexStash();
  const liveAuthObject = liveAuth && typeof liveAuth === "object" && Object.keys(liveAuth).length > 0 ? liveAuth : null;
  const residue = liveAuthObject && isCodexThirdPartyAuthResidue(liveAuthObject);
  const native = liveAuthObject && !residue && codexAuthHasLoginMaterial(liveAuthObject) ? liveAuthObject : null;
  let next = base;

  // Leaving an official card while Codex is logged out: the card's own stashed
  // login is stale — invalidate it and forget `last` so switching back cannot
  // revive a logout (cc-switch leaving_official). Applies for any target,
  // before the branch on it. An unbound card (API-key rows included) carries
  // no identity of its own, so there is nothing to take: a real logout on an
  // unbound card leaves nothing in the stash anyway (restoring on entry
  // consumes the entry), and the entry `last` points at may belong to another
  // card entirely — upstream removes it here, which silently destroys a live
  // login when the previous card was an official API-key one; diverged.
  const prevOfficial = !!prev && prev.category === "official";
  if (prevOfficial && !native) {
    const prevRow =
      prev.settingsConfig && prev.settingsConfig.auth && typeof prev.settingsConfig.auth === "object"
        ? prev.settingsConfig.auth
        : null;
    const prevId = codexOauthIdentityOf(prevRow);
    if (prevId) {
      next = codexStashTake(next, prevId).stash;
    }
    next = { ...next, last: null };
  }

  if (!targetOfficial) {
    // Third-party: stash the live login under its identity for the official
    // cards; stale third-party key residue is cleared without stashing, and
    // no auth.json is left beside a third-party route.
    if (native) next = codexStashPut(next, native);
    if (liveAuthObject) return { action: "stash", stashNext: codexStashChanged(base, next) ? next : null };
    return { action: "keep", stashNext: codexStashChanged(base, next) ? next : null };
  }

  const rowAuth =
    target.settingsConfig && target.settingsConfig.auth && typeof target.settingsConfig.auth === "object"
      ? target.settingsConfig.auth
      : null;

  // An official card whose credential is an API key writes it wholesale
  // (rare: relay keys normally ride the config.toml route table).
  if (rowAuth && isCodexApiKeyCredential(rowAuth)) {
    if (native && JSON.stringify(native) !== JSON.stringify(rowAuth)) {
      next = codexStashPut(next, native);
    }
    return { action: "write", content: rowAuth, stashNext: codexStashChanged(base, next) ? next : null };
  }

  const wanted = codexOauthIdentityOf(rowAuth);
  if (native) {
    const liveIdentity = codexIdentityOf(native);
    // No stored login (or it is the live one): follow Codex's current login.
    if (!wanted || wanted === liveIdentity) {
      return { action: "keep", stashNext: codexStashChanged(base, next) ? next : null };
    }
    // Another identity on the card: swap through the stash, but only if that
    // login was stashed — a card snapshot may be stale or logged out.
    const taken = codexStashTake(next, wanted);
    if (!taken.auth) {
      return { action: "keep", stashNext: codexStashChanged(base, next) ? next : null };
    }
    return {
      action: "write",
      content: taken.auth,
      stashNext: codexStashPut(taken.stash, native),
    };
  }

  // No live login: restore the card's own login, or the most recently
  // stashed one for unbound cards. With nothing to restore there is nothing
  // to clear either (the file is already empty).
  const restored = wanted
    ? codexStashTake(next, wanted)
    : next.last
      ? codexStashTake(next, next.last)
      : { stash: next, auth: null };
  if (restored.auth) {
    return { action: "write", content: restored.auth, stashNext: restored.stash };
  }
  return { action: "keep", stashNext: codexStashChanged(base, next) ? next : null };
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
  const parsed = normalizeCodexProviderConfig(require("smol-toml").parse(liveToml || ""));
  for (const key of floor.CODEX_FLOOR_TOP) {
    const value = parsed[key];
    if (value !== undefined) config[key] = value;
  }
  for (const key of floor.CODEX_FLOOR_AGENTS) {
    if (parsed.agents?.[key] !== undefined) (config.agents ||= {})[key] = parsed.agents[key];
  }
  const table = parsed.model_providers?.custom;
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
      const liveTable = require("smol-toml").parse(liveToml || "").model_providers?.custom || {};
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
  // exported for tests
  codexIdentityOf,
  codexAuthHasLoginMaterial,
  codexAuthHasCredentialLoginMaterial,
  emptyCodexStash,
  normalizeCodexStash,
  codexStashPut,
  codexStashTake,
  upgradeCodexStash,
};
