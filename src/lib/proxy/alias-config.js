const crypto = require("node:crypto");
const fs = require("node:fs");
const paths = require("./paths");
const config = require("./config");
const management = require("./management");

// Node port of EasyCLIProxyAPI's kernel model-alias engine
// (src-tauri/src/core_config/aliases.rs + alias_edit.rs). The Rust original
// edits the kernel YAML and writes it back through the management API; here the
// same legacy config view is read from GET /v8/management/config (JSON) and the
// changed sections are written back like put_management_legacy_alias_view_changes:
//   oauth-model-alias → PUT /config/oauth/model-alias
//   payload           → PUT/DELETE /config/requests/payload
//   api-key sections  → models-only changes applied onto the NATIVE v8 groups
//                       (applyModelsToNativeProviderGroups), preserving
//                       multi-key layouts and per-key overrides
// Error strings mirror the Rust ones because the ported page surfaces them raw.

const OAUTH_ALIAS_CHANNELS = [
  { key: "vertex", provider: "Vertex OAuth", kind: "vertex-oauth", protocol: "gemini", supportsReasoning: true, supportsFast: false, forceMapping: false },
  { key: "aistudio", provider: "AI Studio OAuth", kind: "aistudio-oauth", protocol: "gemini", supportsReasoning: true, supportsFast: false, forceMapping: false },
  { key: "antigravity", provider: "Antigravity OAuth", kind: "antigravity-oauth", protocol: "antigravity", supportsReasoning: true, supportsFast: false, forceMapping: true },
  { key: "claude", provider: "Claude OAuth", kind: "claude-oauth", protocol: "claude", supportsReasoning: true, supportsFast: false, forceMapping: false },
  { key: "codex", provider: "Codex OAuth", kind: "codex-oauth", protocol: "codex", supportsReasoning: true, supportsFast: true, forceMapping: false },
  { key: "kimi", provider: "Kimi OAuth", kind: "kimi-oauth", protocol: "openai", supportsReasoning: true, supportsFast: false, forceMapping: false },
  { key: "devin", provider: "Devin OAuth", kind: "devin-oauth", protocol: "interactions", supportsReasoning: false, supportsFast: false, forceMapping: false },
  { key: "xai", provider: "xAI OAuth", kind: "xai-oauth", protocol: "codex", supportsReasoning: true, supportsFast: false, forceMapping: false },
  // easy c89e2fb: the Muse channel — plain aliases only, no reasoning/fast.
  { key: "meta", provider: "Meta OAuth", kind: "meta-oauth", protocol: "openai", supportsReasoning: false, supportsFast: false, forceMapping: false },
];

const ALIAS_SECTIONS = [
  { section: "codex-api-key", fallbackProvider: "Codex API", kind: "codex-api", protocol: "codex" },
  { section: "openai-compatibility", fallbackProvider: "OpenAI-compatible", kind: "openai-compatible", protocol: "openai" },
  { section: "claude-api-key", fallbackProvider: "Claude API", kind: "claude-api", protocol: "claude" },
  { section: "gemini-api-key", fallbackProvider: "Gemini API", kind: "gemini-api", protocol: "gemini" },
];

const SECTION_PROTOCOLS = {
  "codex-api-key": "codex",
  "openai-compatibility": "openai",
  "claude-api-key": "claude",
  "gemini-api-key": "gemini",
};

const ALIAS_EFFORT_KEYS = [
  "reasoning.effort",
  "reasoning_effort",
  "output_config.effort",
  "generationConfig.thinkingConfig.thinkingLevel",
  "thinking.effort",
];

const SHARED_PROVIDER_FIELDS = new Set([
  "priority", "prefix", "proxy-url", "headers", "models", "excluded-models",
  "disable-cooling", "request-retry", "request-scoped-errors", "base-url",
]);

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function readString(value, ...keys) {
  if (!isRecord(value)) return "";
  for (const key of keys) {
    const candidate = value[key];
    if (candidate === undefined || candidate === null) continue;
    const text = String(candidate).trim();
    if (text) return text;
  }
  return "";
}

function readBoolean(value, ...keys) {
  if (!isRecord(value)) return false;
  for (const key of keys) {
    if (typeof value[key] === "boolean") return value[key];
  }
  return false;
}

function yamlValue(value, ...keys) {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    if (value[key] !== undefined) return value[key];
  }
  return undefined;
}

const sha256Hex = (text) => crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

// --- legacy config view (mirrors management_v8_yaml_to_legacy_view) ----------

function flattenV8ProviderGroups(provider, groups) {
  if (!Array.isArray(groups)) return [];
  const records = [];
  groups.forEach((group, groupIndex) => {
    if (!isRecord(group)) throw new Error(`api-keys.${provider}[${groupIndex}] must be an object`);
    const keys = Array.isArray(group.keys) ? group.keys : [];
    if (provider === "openai-compatibility") {
      const record = { ...group };
      delete record.keys;
      if (keys.length > 0) record["api-key-entries"] = keys.map((key) => ({ ...key }));
      records.push(record);
      return;
    }
    keys.forEach((key, keyIndex) => {
      if (!isRecord(key)) throw new Error(`api-keys.${provider}[${groupIndex}].keys[${keyIndex}] must be an object`);
      const record = {};
      const name = readString(group, "name");
      const generated = name.startsWith(`${provider}-`) && /^[0-9]+$/.test(name.slice(provider.length + 1));
      if (name && !generated) record.name = name;
      for (const [field, value] of Object.entries(group)) {
        if (field === "name" || field === "keys") continue;
        if (field === "base-url" || SHARED_PROVIDER_FIELDS.has(field)) record[field] = value;
      }
      for (const [field, value] of Object.entries(key)) {
        if (value !== null && value !== undefined) record[field] = value;
      }
      records.push(record);
    });
  });
  return records;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Alias edits only touch models[]. Instead of rebuilding each provider section
// from the flattened legacy view (which would split multi-key groups and drop
// per-key overrides — the EasyCLIProxyAPI alias-save bug fixed in be9a2b6),
// apply exactly those model changes back onto the NATIVE v8 groups: keys that
// inherit the group's model list get the shared update at group level, keys
// with their own models are updated in place, and everything else (names,
// connection settings, unknown fields, key layout) is preserved verbatim.
function applyModelsToNativeProviderGroups(provider, groups, beforeRecords, afterRecords) {
  if (!Array.isArray(groups) || !Array.isArray(beforeRecords) || !Array.isArray(afterRecords)) {
    throw new Error("Provider groups changed. Refresh and try again");
  }
  if (!sameJson(flattenV8ProviderGroups(provider, groups), beforeRecords)) {
    throw new Error("Provider groups changed. Refresh and try again");
  }
  if (beforeRecords.length !== afterRecords.length) {
    throw new Error("An alias update cannot add or remove provider keys");
  }
  for (let index = 0; index < beforeRecords.length; index += 1) {
    const stripModels = (record) => {
      if (!isRecord(record)) return record;
      const copy = { ...record };
      delete copy.models;
      return copy;
    };
    if (!sameJson(stripModels(beforeRecords[index]), stripModels(afterRecords[index]))) {
      throw new Error("An alias update cannot change provider connection settings");
    }
  }
  const modelsOf = (record) => (isRecord(record) ? record.models : undefined);
  const assignModels = (target, value) => {
    if (value !== undefined) target.models = structuredClone(value);
    else delete target.models;
  };
  const updated = structuredClone(groups);
  let offset = 0;
  for (const group of updated) {
    if (provider === "openai-compatibility") {
      if (!sameJson(modelsOf(beforeRecords[offset]), modelsOf(afterRecords[offset]))) {
        assignModels(group, modelsOf(afterRecords[offset]));
      }
      offset += 1;
      continue;
    }
    const keys = Array.isArray(group.keys) ? group.keys : [];
    const inherited = [];
    keys.forEach((key, index) => {
      if (!isRecord(key) || key.models === undefined || key.models === null) inherited.push(index);
    });
    const first = inherited[0];
    let sharedUpdate = false;
    if (first !== undefined
      && !sameJson(modelsOf(beforeRecords[offset + first]), modelsOf(afterRecords[offset + first]))
      && inherited.every((index) => sameJson(modelsOf(afterRecords[offset + index]), modelsOf(afterRecords[offset + first])))) {
      assignModels(group, modelsOf(afterRecords[offset + first]));
      sharedUpdate = true;
    }
    keys.forEach((key, index) => {
      if (sameJson(modelsOf(beforeRecords[offset + index]), modelsOf(afterRecords[offset + index]))) return;
      if (sharedUpdate && inherited.includes(index)) return;
      if (!isRecord(key)) throw new Error(`api-keys.${provider} group keys[${index}] must be an object`);
      assignModels(key, modelsOf(afterRecords[offset + index]));
    });
    offset += keys.length;
  }
  return updated;
}

async function fetchLegacyConfig() {
  const result = await management.request("GET", "/v8/management/config", { timeoutMs: 20_000 });
  if (!result.ok) {
    throw new Error(`Management API error (${result.status}): ${typeof result.data === "string" ? result.data : "not_found"}`);
  }
  const payload = isRecord(result.data) ? result.data : {};
  const legacy = { ...payload };
  const upstream = isRecord(payload["api-keys"]) ? payload["api-keys"] : {};
  const sectionProviders = {
    "codex-api-key": "codex",
    "openai-compatibility": "openai-compatibility",
    "claude-api-key": "claude",
    "gemini-api-key": "gemini",
  };
  for (const { section } of ALIAS_SECTIONS) {
    legacy[section] = flattenV8ProviderGroups(sectionProviders[section], upstream[sectionProviders[section]]);
  }
  const access = isRecord(payload.access) ? payload.access : null;
  if (access && Array.isArray(access["api-keys"])) legacy["api-keys"] = access["api-keys"];
  const oauth = isRecord(payload.oauth) ? payload.oauth : null;
  legacy["oauth-model-alias"] = oauth && oauth["model-alias"] !== undefined
    ? oauth["model-alias"]
    : {};
  const requests = isRecord(payload.requests) ? payload.requests : null;
  legacy.payload = requests && requests.payload !== undefined ? requests.payload : {};
  // Native v8 group arrays per provider section — the write-back needs the
  // original layout (multi-key groups, per-key overrides) that the flattened
  // legacy view above deliberately erases.
  return { legacy, nativeApiKeys: upstream };
}

// --- kernel model list -------------------------------------------------------

// The kernel's /v1/models authenticates with a CLIENT access key, not the
// management secret (same as EasyCLIProxyAPI's effective_agent_api_key: the
// first configured client key, falling back to the legacy default "123456").
function effectiveAgentApiKey() {
  try {
    const YAML = require("yaml");
    const doc = YAML.parse(fs.readFileSync(paths.configPath, "utf8")) || {};
    const access = doc.access && Array.isArray(doc.access["api-keys"]) ? doc.access["api-keys"] : [];
    for (const key of access) {
      const trimmed = String(key ?? "").trim();
      if (trimmed) return trimmed;
    }
  } catch {}
  return "123456";
}

async function fetchAvailableModels() {
  const port = config.getServerPort();
  if (!port) throw new Error("Invalid kernel port");
  const token = effectiveAgentApiKey();
  const { request: undiciRequest } = require("undici");
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  for (const endpoint of [`http://127.0.0.1:${port}/v1/models`, `http://127.0.0.1:${port}/models`]) {
    try {
      const response = await undiciRequest(endpoint, { method: "GET", headers, body: undefined });
      const text = await response.body.text();
      if (response.statusCode < 200 || response.statusCode >= 300) continue;
      const payload = JSON.parse(text);
      const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
      const models = rows
        .map((row) => readString(row, "id", "name", "model"))
        .filter(Boolean)
        .map((name) => ({ name }));
      if (models.length > 0 || rows.length === 0) return models;
    } catch {}
  }
  throw new Error("Failed to request local model list");
}

async function fetchOauthDefinitions() {
  const active = await fetchActiveOauthChannels().catch(() => null);
  const definitions = [];
  for (const channel of OAUTH_ALIAS_CHANNELS) {
    if (active && !active.has(channel.key)) continue;
    const models = await fetchChannelDefinitions(channel.key).catch(() => null);
    if (models) definitions.push({ channel, models });
  }
  return definitions;
}

async function fetchActiveOauthChannels() {
  const result = await management.request("GET", "/v8/management/credentials", { timeoutMs: 15_000 });
  if (!result.ok) throw new Error("Failed to read OAuth credential sources");
  const payload = result.data;
  const files = Array.isArray(payload?.files) ? payload.files : Array.isArray(payload) ? payload : null;
  if (!files) throw new Error("OAuth credential source response is missing a files array");
  const active = new Set();
  for (const file of files) {
    if (readBoolean(file, "disabled") || readBoolean(file, "unavailable")) continue;
    const provider = normalizeOauthAliasChannel(readString(file, "provider", "type"));
    if (provider) active.add(provider);
  }
  return active;
}

function normalizeOauthAliasChannel(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  switch (normalized) {
    case "vertex": case "vertex-ai": return "vertex";
    case "aistudio": case "ai-studio": case "gemini": case "gemini-cli": return "aistudio";
    case "antigravity": case "anti-gravity": return "antigravity";
    case "claude": case "anthropic": return "claude";
    case "codex": return "codex";
    case "kimi": case "moonshot": return "kimi";
    case "devin": case "cognition": return "devin";
    case "xai": case "x-ai": case "grok": return "xai";
    case "meta": case "muse": return "meta";
    default: return null;
  }
}

async function fetchChannelDefinitions(channel) {
  const result = await management.request("GET", `/v8/management/routing/model-definitions/${encodeURIComponent(channel)}`, { timeoutMs: 15_000 });
  if (!result.ok) throw new Error(String(result.error || result.status));
  const payload = result.data;
  const rows = Array.isArray(payload?.models) ? payload.models : [];
  return rows.map((row) => {
    const id = readString(row, "id", "name");
    const displayName = readString(row, "display_name", "display-name", "displayName");
    let reasoningLevels = [];
    const levels = yamlValue(row, "reasoning_levels", "reasoning-levels");
    if (Array.isArray(levels)) reasoningLevels = levels.map((level) => String(level).trim().toLowerCase()).filter(Boolean);
    else if (isRecord(row.thinking) && Array.isArray(row.thinking.levels)) {
      reasoningLevels = row.thinking.levels.map((level) => String(level).trim().toLowerCase()).filter(Boolean);
    }
    return { id, displayName: displayName && displayName !== id ? displayName : undefined, reasoningLevels };
  }).filter((row) => row.id);
}

// --- config model helpers ----------------------------------------------------

function configuredModelIdentity(model) {
  if (typeof model === "string") {
    const name = model.trim();
    return name ? { source: name, client: name, displayName: undefined } : null;
  }
  if (!isRecord(model)) return null;
  const name = readString(model, "name");
  if (!name) return null;
  const alias = readString(model, "alias");
  const displayName = readString(model, "display-name", "display_name", "displayName");
  return { source: name, client: alias || name, displayName: displayName || undefined };
}

function providerName(provider, fallback, index) {
  const name = readString(provider, "name") || readString(provider, "base-url");
  return name || `${fallback} ${index + 1}`;
}

function configuredModelReasoningLevels(model, protocol) {
  let levels = [];
  const thinking = isRecord(model) ? yamlValue(model, "thinking") : undefined;
  const rows = isRecord(thinking) ? yamlValue(thinking, "levels") : undefined;
  if (Array.isArray(rows)) {
    for (const level of rows) {
      const normalized = String(level).trim().toLowerCase();
      if (normalized && !levels.includes(normalized)) levels.push(normalized);
    }
  }
  if (levels.length === 0 && (protocol === "codex" || protocol === "openai")) {
    levels = ["low", "medium", "high", "xhigh", "max"];
  }
  return levels;
}

function modelIsAvailable(availableModels, model) {
  return availableModels.some((candidate) => candidate.name.toLowerCase() === model.toLowerCase());
}

// --- source resolution -------------------------------------------------------

function collectConfigSources(root, section, fallbackProvider, kind, protocol, availableModels, capability) {
  const sources = [];
  const providers = yamlValue(root, section);
  if (!Array.isArray(providers)) return sources;
  providers.forEach((provider, providerIndex) => {
    if (!isRecord(provider)) return;
    if (readBoolean(provider, "disabled")) return;
    const name = providerName(provider, fallbackProvider, providerIndex);
    const revision = sha256Hex(JSON.stringify(provider));
    const models = yamlValue(provider, "models");
    if (!Array.isArray(models)) return;
    models.forEach((model, modelIndex) => {
      const identity = configuredModelIdentity(model);
      if (!identity) return;
      if (!modelIsAvailable(availableModels, identity.client)) return;
      if (identity.client !== identity.source
        && findThinkingAliasEffort(root, identity.client, protocol) !== null) return;
      sources.push({
        source: {
          id: `${section}:${providerIndex}:${modelIndex}:${revision}`,
          model: identity.client,
          displayName: identity.displayName ?? null,
          provider: name,
          kind,
          protocol,
          reasoningLevels: configuredModelReasoningLevels(model, protocol),
        },
        location: { type: "config", section, providerIndex, modelIndex },
      });
    });
  });
  if (capability === "reasoning") return sources.filter((entry) => entry.source.reasoningLevels.length > 0);
  if (capability === "fast") return sources.filter((entry) => aliasSourceSupportsFast(entry));
  return sources;
}

function aliasSourceSupportsFast(entry) {
  if (entry.location.type === "oauth") return entry.location.channel === "codex";
  return entry.location.section === "codex-api-key" || entry.location.section === "openai-compatibility";
}

function resolveSources(root, definitions, availableModels, capability) {
  const sources = [];
  for (const { section, fallbackProvider, kind, protocol } of ALIAS_SECTIONS) {
    sources.push(...collectConfigSources(root, section, fallbackProvider, kind, protocol, availableModels, capability));
  }
  const configuredCodexApiModels = new Set(
    sources.filter((entry) => entry.source.kind === "codex-api").map((entry) => entry.source.model.toLowerCase()),
  );
  for (const { channel, models } of definitions) {
    const supportsCapability = capability === "base"
      || (capability === "reasoning" && channel.supportsReasoning)
      || (capability === "fast" && channel.supportsFast);
    if (!supportsCapability) continue;
    for (const definition of models) {
      if (capability === "reasoning" && definition.reasoningLevels.length === 0) continue;
      if (!modelIsAvailable(availableModels, definition.id)) continue;
      if (channel.key === "codex" && configuredCodexApiModels.has(definition.id.toLowerCase())) continue;
      sources.push({
        source: {
          id: `${channel.kind}:${definition.id}`,
          model: definition.id,
          displayName: definition.displayName ?? null,
          provider: channel.provider,
          kind: channel.kind,
          protocol: channel.protocol,
          reasoningLevels: definition.reasoningLevels,
        },
        location: { type: "oauth", channel: channel.key, forceMapping: channel.forceMapping },
      });
    }
  }
  return sources;
}

// --- entry extraction --------------------------------------------------------

function oauthAliasChannelDetails(channel) {
  const known = OAUTH_ALIAS_CHANNELS.find((candidate) => candidate.key.toLowerCase() === channel.toLowerCase());
  if (known) return { provider: known.provider, kind: known.kind, protocol: known.protocol };
  const normalized = String(channel ?? "").trim().toLowerCase();
  return { provider: `${normalized} OAuth`, kind: `${normalized}-oauth`, protocol: normalized };
}

function aliasOverrideParams(root, alias, protocol) {
  const payload = isRecord(root.payload) ? root.payload : {};
  const results = [];
  for (const section of ["override-raw", "override"]) {
    const rules = yamlValue(payload, section);
    if (!Array.isArray(rules)) continue;
    const rows = [...rules].reverse();
    for (const rule of rows) {
      if (!isRecord(rule)) continue;
      const models = yamlValue(rule, "models");
      if (!Array.isArray(models)) continue;
      const matches = models.some((model) => payloadModelMatches(model, alias, protocol));
      if (!matches) continue;
      const params = yamlValue(rule, "params");
      if (!isRecord(params)) continue;
      results.push({ params, raw: section === "override-raw" });
    }
  }
  return results;
}

function payloadModelMatches(model, alias, protocol) {
  if (!isRecord(model)) return false;
  const name = readString(model, "name");
  if (name.toLowerCase() !== alias.toLowerCase()) return false;
  const modelProtocol = readString(model, "protocol");
  return !modelProtocol || modelProtocol.toLowerCase() === protocol.toLowerCase();
}

function payloadParamString(params, key, raw) {
  const value = yamlValue(params, key);
  if (typeof value !== "string") return null;
  let text = value;
  if (raw) {
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== "string") return null;
      text = decoded;
    } catch {
      return null;
    }
  }
  const normalized = text.trim().toLowerCase();
  return normalized || null;
}

function thinkingEffortFromParams(params, protocol, raw) {
  for (const key of ALIAS_EFFORT_KEYS) {
    const value = payloadParamString(params, key, raw);
    if (value) return value;
  }
  const thinkingType = payloadParamString(params, "thinking.type", raw);
  if (thinkingType === "disabled") return "none";
  if (thinkingType === "adaptive" && protocol.toLowerCase() === "claude") return "auto";
  return null;
}

function findThinkingAliasEffort(root, alias, protocol) {
  for (const { params, raw } of aliasOverrideParams(root, alias, protocol)) {
    const effort = thinkingEffortFromParams(params, protocol, raw);
    if (effort) return effort;
  }
  return null;
}

function findSpeedAliasServiceTier(root, alias, protocol) {
  for (const { params, raw } of aliasOverrideParams(root, alias, protocol)) {
    const tier = payloadParamString(params, "service_tier", raw);
    if (tier) return tier;
  }
  return null;
}

// --- payload override maintenance --------------------------------------------

function payloadScopeForProtocol(protocol) {
  return { protocol, preservedProtocols: new Set() };
}

function payloadScopeMatches(scope, model, alias) {
  if (!isRecord(model)) return false;
  const name = readString(model, "name");
  if (name.toLowerCase() !== alias.toLowerCase()) return false;
  const protocol = readString(model, "protocol");
  if (!protocol) return scope.preservedProtocols.size === 0;
  if (scope.protocol && scope.protocol.toLowerCase() !== protocol.toLowerCase()) return false;
  return ![...scope.preservedProtocols].some((existing) => existing.toLowerCase() === protocol.toLowerCase());
}

function removeAliasPayloadOptions(root, alias, scope) {
  const payload = root.payload;
  if (!isRecord(payload)) return;
  for (const section of ["override", "override-raw"]) {
    const rules = yamlValue(payload, section);
    if (!Array.isArray(rules)) continue;
    const next = [];
    for (const rule of rules) {
      if (!isRecord(rule) || !isRecord(rule.params)) {
        next.push(rule);
        continue;
      }
      const retainedParams = { ...rule.params };
      for (const key of [...ALIAS_EFFORT_KEYS, "thinking.type", "service_tier"]) delete retainedParams[key];
      if (JSON.stringify(retainedParams) === JSON.stringify(rule.params)) {
        next.push(rule);
        continue;
      }
      const models = rule.models;
      if (!Array.isArray(models)) {
        next.push(rule);
        continue;
      }
      const target = models.filter((model) => payloadScopeMatches(scope, model, alias));
      const others = models.filter((model) => !payloadScopeMatches(scope, model, alias));
      if (target.length === 0) {
        next.push(rule);
        continue;
      }
      if (others.length > 0) next.push({ ...rule, models: others });
      if (Object.keys(retainedParams).length > 0) {
        next.push({ ...rule, models: target, params: retainedParams });
      }
    }
    if (next.length > 0) payload[section] = next;
    else delete payload[section];
  }
  if (Object.keys(payload).length === 0) delete root.payload;
}

function appendAliasPayloadOverride(root, alias, protocol, params) {
  if (!params || Object.keys(params).length === 0) return;
  const payload = isRecord(root.payload) ? root.payload : {};
  const override = Array.isArray(payload.override) ? payload.override : [];
  override.push({
    models: [{ name: alias, protocol }],
    params,
  });
  payload.override = override;
  root.payload = payload;
}

function insertThinkingEffortParams(source, effort) {
  const params = {};
  const insert = (key, value) => { params[key] = value; };
  const kind = source.kind;
  const normalizedEffort = effort.toLowerCase();
  if (kind === "claude-oauth" || kind === "claude-api") {
    if (normalizedEffort === "none") insert("thinking.type", "disabled");
    else {
      insert("thinking.type", "adaptive");
      if (normalizedEffort !== "auto") insert("output_config.effort", effort);
    }
  } else if (kind === "aistudio-oauth" || kind === "vertex-oauth" || kind === "gemini-api" || kind === "antigravity-oauth") {
    insert("generationConfig.thinkingConfig.thinkingLevel", effort);
  } else if (kind === "kimi-oauth") {
    if (normalizedEffort === "none") insert("thinking.type", "disabled");
    else {
      insert("thinking.type", "enabled");
      insert("thinking.effort", effort);
    }
  } else if (kind === "codex-oauth" || kind === "codex-api" || kind === "xai-oauth") {
    insert("reasoning.effort", effort);
  } else if (kind === "openai-compatible") {
    insert("reasoning_effort", effort);
    if (source.model.toLowerCase().startsWith("deepseek")) insert("thinking.type", "enabled");
  } else {
    const protocol = source.protocol;
    if (protocol === "codex") insert("reasoning.effort", effort);
    else if (protocol === "openai") insert("reasoning_effort", effort);
    else if (protocol === "claude") {
      if (normalizedEffort === "none") insert("thinking.type", "disabled");
      else {
        insert("thinking.type", "adaptive");
        if (normalizedEffort !== "auto") insert("output_config.effort", effort);
      }
    } else if (protocol === "gemini" || protocol === "antigravity") {
      insert("generationConfig.thinkingConfig.thinkingLevel", effort);
    } else {
      throw new Error(`Forcing a reasoning effort override is not yet supported for ${protocol} sources`);
    }
  }
  return params;
}

// --- validation --------------------------------------------------------------

function existingAliasModelId(value, label) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  if (trimmed.length > 240 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`Invalid ${label} format`);
  }
  return trimmed;
}

function validateAliasModelId(value, label) {
  const trimmed = existingAliasModelId(value, label);
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`Invalid ${label} format; whitespace is not allowed`);
  }
  return trimmed;
}

function validateAliasEffort(value) {
  const effort = String(value ?? "").trim().toLowerCase();
  if (!effort) throw new Error("Reasoning effort cannot be empty");
  if (/^[0-9]+$/.test(effort)) {
    throw new Error("Fixed reasoning aliases do not support numeric-only budgets. Enter a reasoning level name");
  }
  if (effort.length > 64 || !/^[a-z0-9._-]+$/i.test(effort)) {
    throw new Error("Invalid reasoning effort format. Only letters, numbers, hyphens, underscores, and periods are allowed");
  }
  return effort;
}

const mappingService = require("./alias-mappings").createMappingService({
  sections: ALIAS_SECTIONS,
  optionKeys: [...ALIAS_EFFORT_KEYS, "thinking.type", "service_tier"],
  fetchLegacyConfig, fetchAvailableModels, fetchOauthDefinitions,
  request: (...args) => management.request(...args),
  configuredModelIdentity, configuredModelReasoningLevels, providerName,
  modelIsAvailable, resolveSources, oauthAliasChannelDetails, aliasOverrideParams,
  findThinkingAliasEffort, findSpeedAliasServiceTier,
  removeAliasPayloadOptions, payloadScopeForProtocol, appendAliasPayloadOverride,
  insertThinkingEffortParams, existingAliasModelId, validateAliasModelId, validateAliasEffort,
});

module.exports = {
  ...mappingService,
  flattenV8ProviderGroups,
  applyModelsToNativeProviderGroups,
};
