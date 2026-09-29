const crypto = require("node:crypto");
const fs = require("node:fs");
const paths = require("./paths");
const config = require("./config");
const management = require("./management");

// Node port of EasyCLIProxyAPI's kernel model-alias engine
// (src-tauri/src/core_config/aliases.rs + alias_edit.rs). The Rust original
// edits the kernel YAML and writes it back through the management API; here the
// same legacy config view is read from GET /v8/management/config (JSON) and the
// changed sections are written back section-by-section exactly like
// put_management_legacy_alias_view_changes:
//   oauth-model-alias → PUT /config/oauth/model-alias
//   payload           → PUT/DELETE /config/requests/payload
//   api-key sections  → regrouped PUT /config/api-keys/{provider}
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

function groupLegacyProviderRecords(provider, records) {
  if (!Array.isArray(records)) throw new Error(`${provider} provider configuration must be an array`);
  return records.map((record, index) => {
    if (!isRecord(record)) throw new Error(`${provider} provider entry ${index} must be an object`);
    if (provider === "openai-compatibility") {
      const group = { ...record };
      const keys = Array.isArray(group["api-key-entries"]) ? group["api-key-entries"] : [];
      delete group["api-key-entries"];
      group.keys = keys.map((key) => ({ ...key }));
      return group;
    }
    const group = { name: readString(record, "name") || `${provider}-${index + 1}` };
    const key = {};
    for (const [field, value] of Object.entries(record)) {
      if (field === "name") continue;
      if (field === "base-url" || SHARED_PROVIDER_FIELDS.has(field)) group[field] = value;
      else if (value !== null && value !== undefined) key[field] = value;
    }
    if (Object.keys(key).length > 0) group.keys = [key];
    return group;
  });
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
  return legacy;
}

function diffAndWriteBack(before, after) {
  const jobs = [];
  const beforeOauth = isRecord(before["oauth-model-alias"]) ? before["oauth-model-alias"] : {};
  const afterOauth = isRecord(after["oauth-model-alias"]) ? after["oauth-model-alias"] : {};
  if (JSON.stringify(beforeOauth) !== JSON.stringify(afterOauth)) {
    jobs.push(management.request("PUT", "/v8/management/config/oauth/model-alias", { body: afterOauth, timeoutMs: 30_000 }));
  }
  const beforePayload = isRecord(before.payload) ? before.payload : {};
  const afterPayload = isRecord(after.payload) ? after.payload : {};
  if (JSON.stringify(beforePayload) !== JSON.stringify(afterPayload)) {
    jobs.push(Object.keys(afterPayload).length > 0
      ? management.request("PUT", "/v8/management/config/requests/payload", { body: afterPayload, timeoutMs: 30_000 })
      : management.request("DELETE", "/v8/management/config/requests/payload", { timeoutMs: 30_000 }));
  }
  const sectionProviders = {
    "codex-api-key": "codex",
    "openai-compatibility": "openai-compatibility",
    "claude-api-key": "claude",
    "gemini-api-key": "gemini",
  };
  for (const { section } of ALIAS_SECTIONS) {
    const provider = sectionProviders[section];
    const beforeRecords = Array.isArray(before[section]) ? before[section] : [];
    const afterRecords = Array.isArray(after[section]) ? after[section] : [];
    if (JSON.stringify(beforeRecords) !== JSON.stringify(afterRecords)) {
      const groups = groupLegacyProviderRecords(provider, afterRecords);
      jobs.push(management.request("PUT", `/v8/management/config/api-keys/${provider}`, { body: groups, timeoutMs: 30_000 }));
    }
  }
  return jobs;
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

function collectConfigThinkingEntries(root, section, fallbackProvider, kind, protocol, entries) {
  const providers = yamlValue(root, section);
  if (!Array.isArray(providers)) return;
  providers.forEach((provider, providerIndex) => {
    if (!isRecord(provider)) return;
    const name = providerName(provider, fallbackProvider, providerIndex);
    const models = yamlValue(provider, "models");
    if (!Array.isArray(models)) return;
    models.forEach((model, modelIndex) => {
      const identity = configuredModelIdentity(model);
      if (!identity || identity.source === identity.client) return;
      const effort = findThinkingAliasEffort(root, identity.client, protocol);
      if (effort === null && findSpeedAliasServiceTier(root, identity.client, protocol) !== null) return;
      entries.push({
        sourceModel: identity.source,
        alias: identity.client,
        effort,
        provider: name,
        kind,
        oauthChannel: null,
        section,
        providerIndex,
        modelIndex,
      });
    });
  });
}

function thinkingEntriesFromConfig(root) {
  const entries = [];
  const oauthAliases = yamlValue(root, "oauth-model-alias");
  if (isRecord(oauthAliases)) {
    for (const [channel, channelAliases] of Object.entries(oauthAliases)) {
      if (!Array.isArray(channelAliases)) continue;
      const details = oauthAliasChannelDetails(channel);
      for (const entry of channelAliases) {
        if (!isRecord(entry)) continue;
        const sourceModel = readString(entry, "name");
        const alias = readString(entry, "alias");
        if (!sourceModel || !alias) continue;
        entries.push({
          sourceModel,
          alias,
          effort: findThinkingAliasEffort(root, alias, details.protocol),
          provider: details.provider,
          kind: details.kind,
          oauthChannel: channel,
          section: null,
          providerIndex: null,
          modelIndex: null,
        });
      }
    }
  }
  for (const { section, fallbackProvider, kind, protocol } of ALIAS_SECTIONS) {
    collectConfigThinkingEntries(root, section, fallbackProvider, kind, protocol, entries);
  }
  entries.sort((left, right) => {
    const byProvider = left.provider.toLowerCase().localeCompare(right.provider.toLowerCase());
    return byProvider !== 0 ? byProvider : left.alias.toLowerCase().localeCompare(right.alias.toLowerCase());
  });
  return entries;
}

function speedEntriesFromConfig(root) {
  const entries = [];
  const oauthAliases = yamlValue(root, "oauth-model-alias");
  if (isRecord(oauthAliases)) {
    for (const [channel, channelAliases] of Object.entries(oauthAliases)) {
      if (!Array.isArray(channelAliases)) continue;
      const details = oauthAliasChannelDetails(channel);
      for (const entry of channelAliases) {
        if (!isRecord(entry)) continue;
        const sourceModel = readString(entry, "name");
        const alias = readString(entry, "alias");
        if (!sourceModel || !alias) continue;
        const serviceTier = findSpeedAliasServiceTier(root, alias, details.protocol);
        if (!serviceTier) continue;
        entries.push({
          sourceModel,
          alias,
          serviceTier,
          provider: details.provider,
          kind: details.kind,
          oauthChannel: channel,
          section: null,
          providerIndex: null,
          modelIndex: null,
        });
      }
    }
  }
  for (const { section, fallbackProvider, kind, protocol } of ALIAS_SECTIONS) {
    if (protocol !== "codex" && protocol !== "openai") continue;
    const providers = yamlValue(root, section);
    if (!Array.isArray(providers)) continue;
    providers.forEach((provider, providerIndex) => {
      if (!isRecord(provider)) return;
      const name = providerName(provider, fallbackProvider, providerIndex);
      const models = yamlValue(provider, "models");
      if (!Array.isArray(models)) return;
      models.forEach((model, modelIndex) => {
        const identity = configuredModelIdentity(model);
        if (!identity || identity.source === identity.client) return;
        const serviceTier = findSpeedAliasServiceTier(root, identity.client, protocol);
        if (!serviceTier) return;
        entries.push({
          sourceModel: identity.source,
          alias: identity.client,
          serviceTier,
          provider: name,
          kind,
          oauthChannel: null,
          section,
          providerIndex,
          modelIndex,
        });
      });
    });
  }
  entries.sort((left, right) => {
    const byProvider = left.provider.toLowerCase().localeCompare(right.provider.toLowerCase());
    return byProvider !== 0 ? byProvider : left.alias.toLowerCase().localeCompare(right.alias.toLowerCase());
  });
  return entries;
}

// --- conflict / occurrence helpers -------------------------------------------

function countConfiguredAliasOccurrences(root, alias) {
  let count = 0;
  const oauthAliases = yamlValue(root, "oauth-model-alias");
  if (isRecord(oauthAliases)) {
    for (const entries of Object.values(oauthAliases)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (readString(entry, "alias").toLowerCase() === alias.toLowerCase()) count += 1;
      }
    }
  }
  for (const { section } of ALIAS_SECTIONS) {
    const providers = yamlValue(root, section);
    if (!Array.isArray(providers)) continue;
    for (const provider of providers) {
      const models = isRecord(provider) ? yamlValue(provider, "models") : undefined;
      if (!Array.isArray(models)) continue;
      for (const model of models) {
        const identity = configuredModelIdentity(model);
        if (identity && identity.client.toLowerCase() === alias.toLowerCase()) count += 1;
      }
    }
  }
  return count;
}

function configuredModelAliasConflicts(root, alias, target, exclude) {
  const oauthAliases = yamlValue(root, "oauth-model-alias");
  if (isRecord(oauthAliases)) {
    for (const [channel, entries] of Object.entries(oauthAliases)) {
      if (!Array.isArray(entries)) continue;
      const excluded = exclude && exclude.type === "oauth" && exclude.channel === channel;
      for (let index = 0; index < entries.length; index += 1) {
        if (excluded && index === exclude.index) continue;
        if (readString(entries[index], "alias").toLowerCase() === alias.toLowerCase()) return true;
      }
    }
  }
  for (const { section } of ALIAS_SECTIONS) {
    const providers = yamlValue(root, section);
    if (!Array.isArray(providers)) continue;
    providers.forEach((provider, providerIndex) => {
      const models = isRecord(provider) ? yamlValue(provider, "models") : undefined;
      if (!Array.isArray(models)) return;
      models.forEach((model, modelIndex) => {
        if (exclude && exclude.type === "config" && exclude.section === section
          && exclude.providerIndex === providerIndex && exclude.modelIndex === modelIndex) return;
        const identity = configuredModelIdentity(model);
        if (!identity || identity.client.toLowerCase() !== alias.toLowerCase()) return;
        if (target && target.section === section && target.providerIndex === providerIndex) {
          if (section !== "openai-compatibility") {
            throw new Error(`Alias model ${alias} already exists`);
          }
        }
      });
    });
  }
  return false;
}

// --- payload override maintenance --------------------------------------------

function payloadScopeForProtocol(protocol) {
  return { protocol, preservedProtocols: new Set() };
}

function payloadScopeAfterRemoval(root, alias, channel) {
  const preservedProtocols = new Set();
  const oauthAliases = yamlValue(root, "oauth-model-alias");
  if (isRecord(oauthAliases)) {
    for (const [channelName, entries] of Object.entries(oauthAliases)) {
      const matches = Array.isArray(entries) && entries.some((entry) => readString(entry, "alias").toLowerCase() === alias.toLowerCase());
      if (matches) preservedProtocols.add(oauthAliasChannelDetails(channelName).protocol);
    }
  }
  for (const [section, protocol] of Object.entries(SECTION_PROTOCOLS)) {
    const providers = yamlValue(root, section);
    if (!Array.isArray(providers)) continue;
    const matches = providers.some((provider) => {
      const models = isRecord(provider) ? yamlValue(provider, "models") : undefined;
      return Array.isArray(models) && models.some((model) => {
        const identity = configuredModelIdentity(model);
        return identity && identity.client.toLowerCase() === alias.toLowerCase();
      });
    });
    if (matches) preservedProtocols.add(protocol);
  }
  return {
    protocol: channel ? oauthAliasChannelDetails(channel).protocol : null,
    preservedProtocols,
  };
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
      for (const key of [...ALIAS_EFFORT_KEYS, "service_tier"]) delete retainedParams[key];
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

function configModelKeyFromParts(section, providerIndex, modelIndex) {
  if (section == null && providerIndex == null && modelIndex == null) return null;
  if (section == null || providerIndex == null || modelIndex == null) {
    throw new Error("Invalid alias model location");
  }
  if (!ALIAS_SECTIONS.some((entry) => entry.section === section)) {
    throw new Error("Unknown model configuration section");
  }
  return { section, providerIndex: Number(providerIndex), modelIndex: Number(modelIndex) };
}

// --- mutations ---------------------------------------------------------------

function appendOauthModelAlias(root, channel, sourceModel, alias, forceMapping) {
  const oauthAliases = isRecord(root["oauth-model-alias"]) ? root["oauth-model-alias"] : {};
  const entries = Array.isArray(oauthAliases[channel]) ? oauthAliases[channel] : [];
  const aliasMapping = { name: sourceModel, alias, fork: true };
  if (forceMapping) aliasMapping["force-mapping"] = true;
  entries.push(aliasMapping);
  oauthAliases[channel] = entries;
  root["oauth-model-alias"] = oauthAliases;
}

function appendConfigThinkingAlias(root, section, providerIndex, modelIndex, expectedModel, alias, effort) {
  const providers = yamlValue(root, section);
  if (!Array.isArray(providers)) throw new Error(`${section} must be an array`);
  const provider = providers[providerIndex];
  if (!isRecord(provider)) throw new Error("Model provider changed. Refresh and try again");
  const models = yamlValue(provider, "models");
  if (!Array.isArray(models)) throw new Error(`${section}.models must be an array`);
  const source = models[modelIndex];
  const identity = configuredModelIdentity(source);
  if (!identity) throw new Error("Invalid source model configuration format");
  if (identity.client.toLowerCase() !== expectedModel.toLowerCase()) {
    throw new Error("Source model changed. Refresh and try again");
  }
  const aliasModel = isRecord(source) ? { ...source } : { name: String(source) };
  aliasModel.alias = alias;
  if (effort) {
    const displayName = readString(aliasModel, "display-name", "display_name");
    if (displayName) aliasModel["display-name"] = `${displayName} (${effort})`;
  }
  models.push(aliasModel);
}

function appendConfigSpeedAlias(root, section, providerIndex, modelIndex, expectedModel, alias) {
  const providers = yamlValue(root, section);
  if (!Array.isArray(providers)) throw new Error(`${section} must be an array`);
  const provider = providers[providerIndex];
  if (!isRecord(provider)) throw new Error("Model provider changed. Refresh and try again");
  const models = yamlValue(provider, "models");
  if (!Array.isArray(models)) throw new Error(`${section}.models must be an array`);
  const source = models[modelIndex];
  const identity = configuredModelIdentity(source);
  if (!identity) throw new Error("Invalid source model configuration format");
  if (identity.client.toLowerCase() !== expectedModel.toLowerCase()) {
    throw new Error("Source model changed. Refresh and try again");
  }
  const aliasModel = isRecord(source) ? { ...source } : { name: String(source) };
  aliasModel.alias = alias;
  const displayName = readString(aliasModel, "display-name", "display_name");
  if (displayName) aliasModel["display-name"] = `${displayName} (Fast)`;
  models.push(aliasModel);
}

function removeOauthModelAlias(root, alias, targetChannel) {
  const oauthAliases = yamlValue(root, "oauth-model-alias");
  if (!isRecord(oauthAliases)) return false;
  let removed = false;
  for (const [channel, entries] of Object.entries(oauthAliases)) {
    if (targetChannel && targetChannel.toLowerCase() !== channel.toLowerCase()) continue;
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => {
      const matches = readString(entry, "alias").toLowerCase() === alias.toLowerCase();
      if (matches) removed = true;
      return !matches;
    });
    if (kept.length > 0) oauthAliases[channel] = kept;
    else delete oauthAliases[channel];
  }
  if (Object.keys(oauthAliases).length === 0) delete root["oauth-model-alias"];
  return removed;
}

function removeConfigModelAliasEntryAt(root, key, alias) {
  const providers = yamlValue(root, key.section);
  if (!Array.isArray(providers)) return false;
  const provider = providers[key.providerIndex];
  if (!isRecord(provider)) return false;
  const models = yamlValue(provider, "models");
  if (!Array.isArray(models)) return false;
  const model = models[key.modelIndex];
  const identity = configuredModelIdentity(model);
  const isTarget = identity && identity.source !== identity.client
    && identity.client.toLowerCase() === alias.toLowerCase();
  if (!isTarget) return false;
  models.splice(key.modelIndex, 1);
  return true;
}

function removeConfigModelAlias(root, section, alias) {
  const providers = yamlValue(root, section);
  if (!Array.isArray(providers)) return false;
  let removed = false;
  for (const provider of providers) {
    const models = isRecord(provider) ? yamlValue(provider, "models") : undefined;
    if (!Array.isArray(models)) continue;
    const kept = models.filter((model) => {
      const identity = configuredModelIdentity(model);
      const matches = identity && identity.source !== identity.client
        && identity.client.toLowerCase() === alias.toLowerCase();
      if (matches) removed = true;
      return !matches;
    });
    if (kept.length !== models.length) provider.models = kept;
  }
  return removed;
}

function removeConfigSpeedAlias(root, section, protocol, alias) {
  if (findSpeedAliasServiceTier(root, alias, protocol) === null) return false;
  const providers = yamlValue(root, section);
  if (!Array.isArray(providers)) return false;
  let removed = false;
  for (const provider of providers) {
    const models = isRecord(provider) ? yamlValue(provider, "models") : undefined;
    if (!Array.isArray(models)) continue;
    const kept = models.filter((model) => {
      const identity = configuredModelIdentity(model);
      const matches = identity && identity.source !== identity.client
        && identity.client.toLowerCase() === alias.toLowerCase();
      if (matches) removed = true;
      return !matches;
    });
    if (kept.length !== models.length) provider.models = kept;
  }
  return removed;
}

// --- public operations -------------------------------------------------------

async function loadState() {
  const root = await fetchLegacyConfig();
  const availableModels = await fetchAvailableModels();
  const definitions = await fetchOauthDefinitions();
  const baseSources = resolveSources(root, definitions, availableModels, "base");
  const thinkingSources = resolveSources(root, definitions, availableModels, "reasoning");
  const speedSources = resolveSources(root, definitions, availableModels, "fast");
  return {
    thinkingEntries: thinkingEntriesFromConfig(root),
    speedEntries: speedEntriesFromConfig(root),
    baseSources: baseSources.map((entry) => entry.source),
    thinkingSources: thinkingSources.map((entry) => entry.source),
    speedSources: speedSources.map((entry) => entry.source),
  };
}

async function resolveSourceForEdit(root, definitions, originalAlias, target) {
  const availableModels = await fetchAvailableModels();
  if (target) {
    const providers = yamlValue(root, target.section);
    if (!Array.isArray(providers)) throw new Error("Model provider changed. Refresh and try again");
    const provider = providers[target.providerIndex];
    if (!isRecord(provider)) throw new Error("Model provider changed. Refresh and try again");
    const models = yamlValue(provider, "models");
    if (!Array.isArray(models)) throw new Error("Model provider changed. Refresh and try again");
    const model = models[target.modelIndex];
    const identity = configuredModelIdentity(model);
    if (!identity) throw new Error("Invalid source model configuration format");
    const protocol = SECTION_PROTOCOLS[target.section];
    const sectionInfo = ALIAS_SECTIONS.find((entry) => entry.section === target.section);
    // The edit source's model is the upstream (source) name — the alias itself
    // is the client-side name being edited.
    return {
      source: {
        id: `${target.section}:${target.providerIndex}:${target.modelIndex}:${sha256Hex(JSON.stringify(provider))}`,
        model: identity.source,
        displayName: identity.displayName ?? null,
        provider: providerName(provider, sectionInfo.fallbackProvider, target.providerIndex),
        kind: sectionInfo.kind,
        protocol,
        reasoningLevels: configuredModelReasoningLevels(model, protocol),
      },
      location: { type: "config", section: target.section, providerIndex: target.providerIndex, modelIndex: target.modelIndex },
      availableModels,
    };
  }
  const oauthAliases = yamlValue(root, "oauth-model-alias");
  if (isRecord(oauthAliases)) {
    for (const [channel, entries] of Object.entries(oauthAliases)) {
      if (!Array.isArray(entries)) continue;
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (readString(entry, "alias").toLowerCase() !== originalAlias.toLowerCase()) continue;
        const sourceModel = readString(entry, "name");
        const details = oauthAliasChannelDetails(channel);
        const channelDef = OAUTH_ALIAS_CHANNELS.find((candidate) => candidate.key === channel)
          ?? { ...details, supportsReasoning: false, supportsFast: details.protocol === "codex", forceMapping: false };
        const definitionSet = definitions.find((candidate) => candidate.channel.key === channel);
        const definition = definitionSet?.models.find((candidate) => candidate.id.toLowerCase() === sourceModel.toLowerCase());
        return {
          source: {
            id: `${channelDef.kind}:${sourceModel}`,
            model: sourceModel,
            displayName: definition?.displayName ?? readString(entry, "display-name") ?? null,
            provider: channelDef.provider,
            kind: channelDef.kind,
            protocol: channelDef.protocol,
            reasoningLevels: definition?.reasoningLevels ?? [],
          },
          location: { type: "oauth", channel, index, forceMapping: Boolean(readBoolean(entry, "force-mapping") || channelDef.forceMapping) },
          availableModels,
        };
      }
    }
  }
  throw new Error("Alias model does not exist. Refresh and try again");
}

async function getEditContext({ alias, section, providerIndex, modelIndex }) {
  const normalizedAlias = existingAliasModelId(alias, "Alias model");
  const target = configModelKeyFromParts(section, providerIndex, modelIndex);
  const root = await fetchLegacyConfig();
  const definitions = await fetchOauthDefinitions();
  const resolved = await resolveSourceForEdit(root, definitions, normalizedAlias, target);
  const protocol = resolved.source.protocol;
  return {
    source: resolved.source,
    revision: sha256Hex(JSON.stringify(
      target
        ? (yamlValue(root, target.section) ?? [])[target.providerIndex]
        : resolved.source,
    )),
    effort: findThinkingAliasEffort(root, normalizedAlias, protocol),
    fast: findSpeedAliasServiceTier(root, normalizedAlias, protocol) !== null,
  };
}

async function createAlias(payload) {
  const sourceId = String(payload.sourceId ?? "").trim();
  if (!sourceId) throw new Error("Select the source model first");
  let alias;
  const originalAlias = payload.originalAlias != null && String(payload.originalAlias).trim() !== ""
    ? existingAliasModelId(payload.originalAlias, "Alias model")
    : null;
  if (originalAlias && originalAlias.toLowerCase() === String(payload.alias ?? "").trim().toLowerCase()) {
    alias = existingAliasModelId(payload.alias, "Alias model");
  } else {
    alias = validateAliasModelId(payload.alias, "Alias model");
  }
  const effort = String(payload.effort ?? "").trim() ? validateAliasEffort(payload.effort) : "";
  const fast = Boolean(payload.fast);
  const target = configModelKeyFromParts(payload.section, payload.providerIndex, payload.modelIndex);

  const root = await fetchLegacyConfig();
  if (originalAlias) {
    const revision = payload.expectedRevision;
    const providers = target ? yamlValue(root, target.section) : null;
    const currentRevision = target
      ? sha256Hex(JSON.stringify(Array.isArray(providers) ? providers[target.providerIndex] : undefined))
      : null;
    if (target && revision != null && currentRevision !== revision) {
      throw new Error("Configuration changed. Refresh and try again");
    }
    if (!target && revision != null && revision !== sha256Hex(JSON.stringify(root["oauth-model-alias"] ?? {}))) {
      throw new Error("Configuration changed. Refresh and try again");
    }
  }
  const availableModels = await fetchAvailableModels();
  const definitions = await fetchOauthDefinitions();
  const capability = effort ? "reasoning" : fast ? "fast" : "base";
  let resolved;
  if (originalAlias) {
    resolved = await resolveSourceForEdit(root, definitions, originalAlias, target);
    if (sourceId !== resolved.source.id) {
      // The user picked a different source model in the combobox while editing.
      const chosen = resolveSources(root, definitions, availableModels, capability)
        .find((entry) => entry.source.id === sourceId);
      if (chosen) resolved = chosen;
    }
  } else {
    resolved = resolveSources(root, definitions, availableModels, capability)
      .find((entry) => entry.source.id === sourceId);
    if (!resolved) {
      throw new Error("The source model is no longer available in the kernel, or its configuration source has changed. Refresh and select it again");
    }
  }
  const source = resolved.source;
  if (fast && !aliasSourceSupportsFast(resolved)) {
    throw new Error("Fast supports only OpenAI-compatible API, Codex API, or Codex OAuth model sources");
  }
  if (effort && !source.reasoningLevels.some((level) => level.toLowerCase() === effort.toLowerCase())) {
    throw new Error(`Reasoning effort ${effort} is not among the levels currently supported by model ${source.model}`);
  }
  if (source.model.toLowerCase() === alias.toLowerCase()) {
    throw new Error("Alias model cannot be the same as the source model");
  }
  const aliasAlreadyConfigured = countConfiguredAliasOccurrences(root, alias) > 0;
  if (!aliasAlreadyConfigured
    && availableModels.some((model) => model.name.toLowerCase() === alias.toLowerCase()
      && !(originalAlias && originalAlias.toLowerCase() === alias.toLowerCase()))) {
    throw new Error(`${alias} is already an actual model ID and cannot also be used as an alias`);
  }

  const mutated = structuredClone(root);
  if (originalAlias) {
    applyEditAlias(mutated, resolved, originalAlias, alias, effort, fast, target);
  } else {
    const priorOccurrences = countConfiguredAliasOccurrences(root, alias);
    if (resolved.location.type === "oauth") {
      if (priorOccurrences > 0) throw new Error(`Alias model ${alias} already exists`);
      appendOauthModelAlias(mutated, resolved.location.channel, source.model, alias, resolved.location.forceMapping);
    } else {
      configuredModelAliasConflicts(mutated, alias, {
        section: resolved.location.section,
        providerIndex: resolved.location.providerIndex,
      });
      appendConfigThinkingAlias(mutated, resolved.location.section, resolved.location.providerIndex, resolved.location.modelIndex, source.model, alias, effort);
    }
    if (priorOccurrences === 0 || effort || fast) {
      removeAliasPayloadOptions(mutated, alias, payloadScopeForProtocol(source.protocol));
    }
    if (effort) {
      appendAliasPayloadOverride(mutated, alias, source.protocol, insertThinkingEffortParams(source, effort));
    }
    if (fast) {
      appendAliasPayloadOverride(mutated, alias, source.protocol, { service_tier: "priority" });
    }
  }
  await Promise.all(diffAndWriteBack(root, mutated));
  return { thinkingEntries: thinkingEntriesFromConfig(mutated), speedEntries: speedEntriesFromConfig(mutated) };
}

// --- edit (edit_model_alias_in_yaml) ------------------------------------------

function findOriginalAliasEntry(root, originalAlias, target) {
  if (target) {
    const providers = yamlValue(root, target.section);
    const provider = Array.isArray(providers) ? providers[target.providerIndex] : null;
    const models = isRecord(provider) ? yamlValue(provider, "models") : undefined;
    const model = Array.isArray(models) ? models[target.modelIndex] : undefined;
    const identity = configuredModelIdentity(model);
    if (identity && identity.client.toLowerCase() === originalAlias.toLowerCase()) {
      return { type: "config", section: target.section, providerIndex: target.providerIndex, modelIndex: target.modelIndex };
    }
  }
  const oauthAliases = yamlValue(root, "oauth-model-alias");
  if (isRecord(oauthAliases)) {
    for (const [channel, entries] of Object.entries(oauthAliases)) {
      if (!Array.isArray(entries)) continue;
      for (let index = 0; index < entries.length; index += 1) {
        if (readString(entries[index], "alias").toLowerCase() === originalAlias.toLowerCase()) {
          return { type: "oauth", channel, index };
        }
      }
    }
  }
  for (const { section } of ALIAS_SECTIONS) {
    const providers = yamlValue(root, section);
    if (!Array.isArray(providers)) continue;
    for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
      const provider = providers[providerIndex];
      const models = isRecord(provider) ? yamlValue(provider, "models") : undefined;
      if (!Array.isArray(models)) continue;
      for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
        const identity = configuredModelIdentity(models[modelIndex]);
        if (identity && identity.client.toLowerCase() === originalAlias.toLowerCase()) {
          return { type: "config", section, providerIndex, modelIndex };
        }
      }
    }
  }
  throw new Error("Alias model does not exist. Refresh and try again");
}

function isSameAliasGroup(original, location) {
  if (original.type === "oauth") {
    return location.type === "oauth" && location.channel === original.channel;
  }
  return location.type === "config"
    && location.section === original.section
    && location.providerIndex === original.providerIndex;
}

function applyEditAlias(root, resolved, originalAlias, alias, effort, fast, target) {
  const source = resolved.source;
  const original = findOriginalAliasEntry(root, originalAlias, target);
  const group = isSameAliasGroup(original, resolved.location);

  // Conflict checks before mutating anything.
  const destProviderKey = resolved.location.type === "config"
    ? { section: resolved.location.section, providerIndex: resolved.location.providerIndex }
    : null;
  const renamed = alias.toLowerCase() !== originalAlias.toLowerCase();
  if (renamed) {
    configuredModelAliasConflicts(root, alias, destProviderKey);
  } else if (!group) {
    configuredModelAliasConflicts(root, alias, destProviderKey, original);
  }

  // Build the replacement entry.
  let replacement;
  if (resolved.location.type === "config") {
    const providers = yamlValue(root, resolved.location.section);
    const provider = Array.isArray(providers) ? providers[resolved.location.providerIndex] : null;
    const models = isRecord(provider) ? yamlValue(provider, "models") : [];
    const sameProvider = original.type === "config"
      && original.section === resolved.location.section
      && original.providerIndex === resolved.location.providerIndex;
    const baseEntry = sameProvider && Array.isArray(models) ? models[original.modelIndex] : undefined;
    const base = isRecord(baseEntry) ? structuredClone(baseEntry) : {};
    base.name = source.model;
    base.alias = alias;
    replacement = base;
  } else {
    const oauthAliases = isRecord(root["oauth-model-alias"]) ? root["oauth-model-alias"] : {};
    const originalSameChannel = original.type === "oauth" && original.channel === resolved.location.channel;
    const base = originalSameChannel
      ? structuredClone(oauthAliases[original.channel][original.index])
      : {};
    base.name = source.model;
    base.alias = alias;
    if (!originalSameChannel) {
      base.fork = true;
      if (resolved.location.forceMapping) base["force-mapping"] = true;
    }
    replacement = base;
  }

  // Apply: same group replaces in place, otherwise remove + append.
  let removedOriginal = false;
  if (original.type === "config") {
    const providers = yamlValue(root, original.section);
    const provider = Array.isArray(providers) ? providers[original.providerIndex] : null;
    const models = isRecord(provider) ? yamlValue(provider, "models") : undefined;
    if (!Array.isArray(models)) throw new Error("Original alias changed. Refresh and try again");
    if (group && resolved.location.type === "config") {
      models[original.modelIndex] = replacement;
    } else {
      removedOriginal = removeConfigModelAliasEntryAt(root, original, originalAlias);
      if (!removedOriginal) throw new Error("Original alias changed. Refresh and try again");
      const destProviders = yamlValue(root, resolved.location.section);
      const destProvider = Array.isArray(destProviders) ? destProviders[resolved.location.providerIndex] : null;
      const destModels = isRecord(destProvider) ? yamlValue(destProvider, "models") : undefined;
      if (!Array.isArray(destModels)) throw new Error("Model provider changed. Refresh and try again");
      destModels.push(replacement);
    }
  } else {
    const oauthAliases = isRecord(root["oauth-model-alias"]) ? root["oauth-model-alias"] : {};
    const entries = Array.isArray(oauthAliases[original.channel]) ? oauthAliases[original.channel] : [];
    if (group && resolved.location.type === "oauth") {
      entries[original.index] = replacement;
      oauthAliases[original.channel] = entries;
    } else {
      removedOriginal = removeOauthModelAliasEntryAt(root, original.channel, original.index, originalAlias);
      if (!removedOriginal) throw new Error("Original alias changed. Refresh and try again");
      appendOauthModelAlias(root, resolved.location.channel, source.model, alias, resolved.location.forceMapping);
    }
    root["oauth-model-alias"] = oauthAliases;
  }

  // Payload rules are bound to the alias; move or rewrite them.
  const originalStillServed = countConfiguredAliasOccurrences(root, originalAlias) > 0;
  if (renamed && originalStillServed) {
    removeAliasPayloadOptions(root, alias, payloadScopeForProtocol(source.protocol));
    if (effort) appendAliasPayloadOverride(root, alias, source.protocol, insertThinkingEffortParams(source, effort));
    if (fast) appendAliasPayloadOverride(root, alias, source.protocol, { service_tier: "priority" });
  } else {
    removeAliasPayloadOptions(root, originalAlias, payloadScopeForProtocol(source.protocol));
    if (effort) appendAliasPayloadOverride(root, alias, source.protocol, insertThinkingEffortParams(source, effort));
    if (fast) appendAliasPayloadOverride(root, alias, source.protocol, { service_tier: "priority" });
  }
}

async function createSpeedAlias(payload) {
  const sourceId = String(payload.sourceId ?? "").trim();
  if (!sourceId) throw new Error("Select the source model first");
  const alias = validateAliasModelId(payload.alias, "Alias model");
  const root = await fetchLegacyConfig();
  const availableModels = await fetchAvailableModels();
  const definitions = await fetchOauthDefinitions();
  const resolved = resolveSources(root, definitions, availableModels, "fast")
    .find((entry) => entry.source.id === sourceId);
  if (!resolved) {
    throw new Error("The source model is no longer available in the kernel, or its configuration source has changed. Refresh and try again");
  }
  const source = resolved.source;
  if (!aliasSourceSupportsFast(resolved)) {
    throw new Error("Fast supports only OpenAI-compatible API, Codex API, or Codex OAuth model sources");
  }
  if (source.model.toLowerCase() === alias.toLowerCase()) {
    throw new Error("Alias model cannot be the same as the source model");
  }
  const aliasAlreadyConfigured = countConfiguredAliasOccurrences(root, alias) > 0;
  if (!aliasAlreadyConfigured && availableModels.some((model) => model.name.toLowerCase() === alias.toLowerCase())) {
    throw new Error(`${alias} is already an actual model ID and cannot also be used as an alias`);
  }
  const priorOccurrences = countConfiguredAliasOccurrences(root, alias);
  const mutated = structuredClone(root);
  if (resolved.location.type === "oauth") {
    if (priorOccurrences > 0) throw new Error(`Alias model ${alias} already exists`);
    appendOauthModelAlias(mutated, resolved.location.channel, source.model, alias, resolved.location.forceMapping);
  } else {
    configuredModelAliasConflicts(mutated, alias, {
      section: resolved.location.section,
      providerIndex: resolved.location.providerIndex,
    });
    appendConfigSpeedAlias(mutated, resolved.location.section, resolved.location.providerIndex, resolved.location.modelIndex, source.model, alias);
  }
  if (priorOccurrences === 0) {
    removeAliasPayloadOptions(mutated, alias, payloadScopeForProtocol(source.protocol));
    appendAliasPayloadOverride(mutated, alias, source.protocol, { service_tier: "priority" });
  } else if (findSpeedAliasServiceTier(mutated, alias, source.protocol) === null) {
    appendAliasPayloadOverride(mutated, alias, source.protocol, { service_tier: "priority" });
  }
  await Promise.all(diffAndWriteBack(root, mutated));
  return { thinkingEntries: thinkingEntriesFromConfig(mutated), speedEntries: speedEntriesFromConfig(mutated) };
}

function removeOauthModelAliasEntryAt(root, channel, modelIndex, alias) {
  const oauthAliases = yamlValue(root, "oauth-model-alias");
  if (!isRecord(oauthAliases)) return false;
  const entries = Array.isArray(oauthAliases[channel]) ? oauthAliases[channel] : null;
  if (!entries) return false;
  const entry = entries[modelIndex];
  if (readString(entry, "alias").toLowerCase() !== alias.toLowerCase()) return false;
  entries.splice(modelIndex, 1);
  if (entries.length === 0) {
    delete oauthAliases[channel];
    if (Object.keys(oauthAliases).length === 0) delete root["oauth-model-alias"];
  }
  return true;
}

async function deleteAlias(payload) {
  const alias = existingAliasModelId(payload.alias, "Alias model");
  const oauthChannel = payload.oauthChannel ? String(payload.oauthChannel) : null;
  const target = configModelKeyFromParts(payload.section, payload.providerIndex, payload.modelIndex);
  const isSpeed = payload.kind === "speed"
    || (payload.serviceTier && !payload.effort);
  const root = await fetchLegacyConfig();
  const mutated = structuredClone(root);
  let removed = false;
  if (!target) {
    removed = removeOauthModelAlias(mutated, alias, oauthChannel);
  }
  if (!oauthChannel) {
    if (target) {
      removed = removeConfigModelAliasEntryAt(mutated, target, alias) || removed;
    } else {
      removed = removeConfigModelAlias(mutated, "codex-api-key", alias) || removed;
      removed = removeConfigModelAlias(mutated, "openai-compatibility", alias) || removed;
      removed = removeConfigModelAlias(mutated, "claude-api-key", alias) || removed;
      removed = removeConfigModelAlias(mutated, "gemini-api-key", alias) || removed;
      if (isSpeed) {
        removed = removeConfigSpeedAlias(mutated, "codex-api-key", "codex", alias) || removed;
        removed = removeConfigSpeedAlias(mutated, "openai-compatibility", "openai", alias) || removed;
      }
    }
  }
  if (!removed) {
    throw new Error(`Alias model ${alias} does not exist. Refresh and try again`);
  }
  removeAliasPayloadOptions(mutated, alias, payloadScopeAfterRemoval(mutated, alias, oauthChannel));
  await Promise.all(diffAndWriteBack(root, mutated));
  return { thinkingEntries: thinkingEntriesFromConfig(mutated), speedEntries: speedEntriesFromConfig(mutated) };
}

module.exports = {
  loadState,
  getEditContext,
  createAlias,
  createSpeedAlias,
  deleteAlias,
};
