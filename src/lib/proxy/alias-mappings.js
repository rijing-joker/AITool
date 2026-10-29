"use strict";

// Mapping identities describe native configuration entries, not client-visible
// alias names. A shared group model is one entry; explicit per-key model lists
// are separate owners, including OpenAI-compatible groups.
const crypto = require("node:crypto");
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const lower = (value) => String(value || "").toLowerCase();
const PROVIDERS = { "codex-api-key": "codex", "claude-api-key": "claude", "gemini-api-key": "gemini", "openai-compatibility": "openai-compatibility" };

function createMappingService(h) {
  let pending = Promise.resolve();
  const serial = (operation) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const conflict = (message = "Alias mapping changed. Refresh and try again") => Object.assign(new Error(message), { statusCode: 409 });

  function inventory(root, native) {
    const result = [];
    const occurrences = new Map();
    function addOwner(owner, ownerIdentity, details, location, legacyTargets = []) {
      if (!Array.isArray(owner.models)) return;
      const ownerKey = hash(ownerIdentity);
      const occurrence = occurrences.get(ownerKey) || 0;
      occurrences.set(ownerKey, occurrence + 1);
      const ownerId = `${ownerKey}:${occurrence}`;
      const duplicates = new Map();
      owner.models.forEach((model, modelIndex) => {
        const identity = h.configuredModelIdentity(model);
        if (!identity) return;
        const signature = hash([identity.source, identity.client]);
        const duplicate = duplicates.get(signature) || 0;
        duplicates.set(signature, duplicate + 1);
        const mappingId = `mapping:${hash([ownerId, signature, duplicate])}`;
        const effort = h.findThinkingAliasEffort(root, identity.client, details.protocol);
        const serviceTier = h.findSpeedAliasServiceTier(root, identity.client, details.protocol);
        const duplicateCount = owner.models.filter((candidate) => {
          const other = h.configuredModelIdentity(candidate);
          return other?.source === identity.source && other.client === identity.client;
        }).length;
        const revision = hash([model, duplicateCount, h.aliasOverrideParams(root, identity.client, details.protocol).map(({ params, raw }) => ({
          raw, params: Object.fromEntries(Object.entries(params).filter(([key]) => h.optionKeys.includes(key))),
        })).filter((entry) => Object.keys(entry.params).length)]);
        result.push({ mappingId, revision, owner, ownerId, model, modelIndex, identity, ...details,
          location, legacyTargets, effort, serviceTier,
          sourceId: `source:${mappingId}:${hash(model)}`,
        });
      });
    }
    for (const [channel, models] of Object.entries(root["oauth-model-alias"] || {})) {
      const details = h.oauthAliasChannelDetails(channel);
      addOwner({ models }, ["oauth", channel], details, { type: "oauth", channel });
    }
    for (const spec of h.sections) {
      const provider = PROVIDERS[spec.section];
      let offset = 0;
      for (const [groupIndex, group] of (native[provider] || []).entries()) {
        const keys = Array.isArray(group.keys) ? group.keys : [];
        const details = { ...spec, disabled: Boolean(group.disabled), provider: h.providerName(group, spec.fallbackProvider, groupIndex) };
        // Names and endpoints identify a group across array reordering. Keys
        // identify otherwise indistinguishable groups, without exposing secrets.
        const identity = [provider, group.name || "", group["base-url"] || "", group.prefix || ""];
        const matchingGroups = (native[provider] || []).filter((entry) => equal(
          [provider, entry.name || "", entry["base-url"] || "", entry.prefix || ""], identity));
        if (matchingGroups.length > 1) identity.push(keys.map((key) => hash(key["api-key"] || "")).sort());
        const legacyTargets = provider === "openai-compatibility" ? [offset] : keys.flatMap((key, index) => key.models == null ? [offset + index] : []);
        addOwner(group, ["group", identity], details, { type: "config", provider, section: spec.section, groupIndex, keyIndex: null }, legacyTargets);
        keys.forEach((key, keyIndex) => {
          if (!Array.isArray(key.models)) return;
          addOwner(key, ["key", identity, hash(key["api-key"] || "")], details,
            { type: "config", provider, section: spec.section, groupIndex, keyIndex },
            provider === "openai-compatibility" ? [] : [offset + keyIndex]);
        });
        offset += provider === "openai-compatibility" ? 1 : keys.length;
      }
    }
    return result;
  }

  const isAlias = (node) => node.location.type === "oauth" || node.identity.client !== node.identity.source;
  const supportsFast = (node) => node.kind === "codex-oauth" || ["codex-api-key", "openai-compatibility"].includes(node.location.section);
  function sourceFor(node, editing = false, definitions = []) {
    const definition = definitions.find((set) => set.channel.key === node.location.channel)?.models
      .find((model) => lower(model.id) === lower(node.identity.source));
    return {
      id: node.sourceId, model: editing ? node.identity.source : node.identity.client,
      displayName: node.identity.displayName || definition?.displayName || null,
      provider: node.provider, kind: node.kind, protocol: node.protocol,
      reasoningLevels: node.location.type === "oauth" ? definition?.reasoningLevels || [] : h.configuredModelReasoningLevels(node.model, node.protocol),
    };
  }
  function list(root, native) {
    const nodes = inventory(root, native).filter(isAlias);
    const entries = nodes.map((node) => ({
      mappingId: node.mappingId, revision: node.revision, sourceModel: node.identity.source, alias: node.identity.client,
      protocol: node.protocol, effort: node.effort, serviceTier: node.serviceTier,
      provider: node.provider, kind: node.kind, oauthChannel: node.location.channel || null,
      section: node.location.section || null, providerIndex: node.legacyTargets[0] ?? null, modelIndex: node.modelIndex,
      groupIndex: node.location.groupIndex ?? null, keyIndex: node.location.keyIndex ?? null,
      sharedMappingCount: nodes.filter((other) => lower(other.identity.client) === lower(node.identity.client) && other.protocol === node.protocol).length,
    })).sort((a, b) => a.provider.localeCompare(b.provider) || a.alias.localeCompare(b.alias) || a.mappingId.localeCompare(b.mappingId));
    return {
      thinkingEntries: entries.filter((entry) => entry.effort !== null || !entry.serviceTier),
      speedEntries: entries.filter((entry) => entry.serviceTier),
    };
  }

  function sources(root, native, definitions, available) {
    const configured = inventory(root, native).filter((node) => node.location.type === "config" && !node.disabled && !node.owner.disabled &&
      h.modelIsAvailable(available, node.identity.client) && (!isAlias(node) || node.effort === null));
    const result = configured.map((node) => ({ source: sourceFor(node), node, fast: supportsFast(node) }));
    for (const { channel, models } of definitions) {
      for (const model of models) {
        if (!h.modelIsAvailable(available, model.id)) continue;
        result.push({ source: { id: `${channel.kind}:${model.id}`, model: model.id, displayName: model.displayName || null,
          provider: channel.provider, kind: channel.kind, protocol: channel.protocol, reasoningLevels: model.reasoningLevels },
          channel, fast: channel.supportsFast });
      }
    }
    return result;
  }

  function resolveMapping(root, native, payload, alias, requireRevision = false, strictPosition = false) {
    const nodes = inventory(root, native).filter(isAlias);
    let candidates;
    if (payload.mappingId) candidates = nodes.filter((node) => node.mappingId === payload.mappingId);
    else {
      candidates = nodes.filter((node) => lower(node.identity.client) === lower(alias));
      if (payload.oauthChannel) candidates = candidates.filter((node) => node.location.channel === payload.oauthChannel);
      if (payload.sourceModel) candidates = candidates.filter((node) => lower(node.identity.source) === lower(payload.sourceModel));
      if (payload.section === "oauth-model-alias") {
        candidates = candidates.filter((node) => node.location.type === "oauth");
      } else if (payload.section != null || payload.providerIndex != null) {
        candidates = candidates.filter((node) => node.location.section === payload.section && node.legacyTargets.includes(Number(payload.providerIndex)));
      }
      if (payload.modelIndex != null && (strictPosition || !payload.sourceModel)) {
        candidates = candidates.filter((node) => node.modelIndex === Number(payload.modelIndex));
      }
    }
    if (candidates.length > 1) throw conflict("Alias name is ambiguous. Select a specific mapping");
    if (candidates.length !== 1 || lower(candidates[0].identity.client) !== lower(alias)) {
      throw payload.mappingId ? conflict() : conflict(strictPosition
        ? "Alias mapping does not exist at the saved position. Refresh and try again"
        : "Alias row moved or changed. Refresh and try again");
    }
    const node = candidates[0];
    const revision = payload.expectedRevision ?? payload.revision;
    if (payload.mappingId && requireRevision && revision == null) throw conflict("Mapping revision is required. Refresh and try again");
    if (revision != null && revision !== node.revision) throw conflict();
    return node;
  }

  function protocols(root, native, alias) {
    return new Set(inventory(root, native).filter((node) => lower(node.identity.client) === lower(alias)).map((node) => node.protocol));
  }
  function clearOptions(root, native, alias, protocol) {
    const active = protocols(root, native, alias);
    active.add(protocol);
    // A legacy unscoped rule can serve multiple protocols. Split that selector
    // before changing one protocol, retaining the other protocols' parameters.
    for (const section of ["override", "override-raw"]) {
      for (const rule of root.payload?.[section] || []) {
        if (!Array.isArray(rule.models)) continue;
        rule.models = rule.models.flatMap((model) => lower(model.name) === lower(alias) && !model.protocol
          ? [...active].map((name) => ({ ...model, protocol: name })) : [model]);
      }
    }
    h.removeAliasPayloadOptions(root, alias, h.payloadScopeForProtocol(protocol));
  }

  function resolveSelection(root, native, definitions, available, sourceId, original) {
    if (original && sourceId === original.sourceId) return { source: sourceFor(original, true, definitions), node: original, fast: supportsFast(original) };
    const selected = sources(root, native, definitions, available).find((entry) => entry.source.id === sourceId);
    if (selected) return selected;
    // Older clients send positional source ids. Only keep them while they
    // still identify exactly one native mapping with the same configuration.
    const legacy = h.resolveSources(root, definitions, available, "base").find((entry) => entry.source.id === sourceId);
    if (legacy?.location.type === "config") {
      const matches = inventory(root, native).filter((node) => node.location.section === legacy.location.section && node.legacyTargets.includes(legacy.location.providerIndex) && node.modelIndex === legacy.location.modelIndex);
      if (matches.length === 1) return { source: sourceFor(matches[0]), node: matches[0], fast: supportsFast(matches[0]) };
    }
    throw conflict("Source model changed. Refresh and select it again");
  }

  function mutate(snapshot, payload, definitions, available, deleting = false) {
    const root = snapshot.legacy, native = snapshot.nativeApiKeys;
    const originalAlias = deleting ? payload.alias : payload.originalAlias;
    const original = originalAlias ? resolveMapping(root, native, payload, h.existingAliasModelId(originalAlias, "Alias model"), true, deleting) : null;
    if (deleting) {
      original.owner.models.splice(original.modelIndex, 1);
      if (!protocols(root, native, original.identity.client).has(original.protocol)) clearOptions(root, native, original.identity.client, original.protocol);
      return;
    }
    const alias = original && lower(payload.alias) === lower(originalAlias)
      ? h.existingAliasModelId(payload.alias, "Alias model") : h.validateAliasModelId(payload.alias, "Alias model");
    const effort = String(payload.effort || "").trim() ? h.validateAliasEffort(payload.effort) : "";
    const serviceTier = payload.serviceTier ?? (payload.fast ? "priority" : "");
    if (!["", "priority", "ultrafast"].includes(serviceTier)) throw new Error("Unsupported service tier");
    const fast = serviceTier !== "";
    // Positional clients use this marker for an unchanged source. Resolve it
    // only after verifying the row's source/alias pair above.
    const sourceId = original && !payload.mappingId && payload.sourceId === `alias-edit:${lower(originalAlias)}`
      ? original.sourceId : payload.sourceId;
    const selected = resolveSelection(root, native, definitions, available, sourceId, original);
    const source = selected.source;
    if (fast && !selected.fast) throw new Error("Fast is not supported by this model source");
    if (effort && !source.reasoningLevels.some((level) => lower(level) === lower(effort))) throw new Error("Reasoning effort is not supported by this model source");
    if (lower(alias) === lower(source.model)) throw new Error("Alias model cannot be the same as the source model");
    const existing = inventory(root, native).filter((node) => isAlias(node) && lower(node.identity.client) === lower(alias));
    if (!existing.length && available.some((model) => lower(model.name) === lower(alias))) throw new Error("Alias is already an actual model ID");
    const sharedBefore = existing.some((node) => node.protocol === source.protocol);
    let owner = selected.node?.owner;
    if (!owner) {
      root["oauth-model-alias"] ||= {};
      root["oauth-model-alias"][selected.channel.key] ||= [];
      owner = { models: root["oauth-model-alias"][selected.channel.key] };
    }
    const sameOwner = original && (selected.node ? original.ownerId === selected.node.ownerId : original.location.channel === selected.channel.key);
    const base = sameOwner ? original.model : selected.node?.model;
    const replacement = typeof base === "object" ? structuredClone(base) : {};
    replacement.name = selected.node?.identity.source || source.model;
    replacement.alias = alias;
    if (selected.channel) {
      replacement.fork = true;
      if (selected.channel.forceMapping) replacement["force-mapping"] = true;
    }
    if (sameOwner) original.owner.models[original.modelIndex] = replacement;
    else {
      if (original) original.owner.models.splice(original.modelIndex, 1);
      owner.models.push(replacement);
    }
    if (original && (lower(originalAlias) !== lower(alias) || original.protocol !== source.protocol) &&
        !protocols(root, native, originalAlias).has(original.protocol)) clearOptions(root, native, originalAlias, original.protocol);
    if (original || !sharedBefore || effort || fast) {
      clearOptions(root, native, alias, source.protocol);
      if (effort) h.appendAliasPayloadOverride(root, alias, source.protocol, h.insertThinkingEffortParams(source, effort));
      if (fast) h.appendAliasPayloadOverride(root, alias, source.protocol, { service_tier: serviceTier });
    }
  }

  function sections(snapshot) {
    return [
      { url: "/v8/management/config/oauth/model-alias", data: snapshot.legacy["oauth-model-alias"] || {} },
      ...Object.values(PROVIDERS).map((provider) => ({ url: `/v8/management/config/api-keys/${provider}`, data: snapshot.nativeApiKeys[provider] || [] })),
      { url: "/v8/management/config/requests/payload", data: snapshot.legacy.payload || {} },
    ];
  }
  async function write(before, after) {
    const old = sections(before), next = sections(after);
    const changes = next.map((entry, index) => ({ ...entry, previous: old[index].data })).filter((entry) => !equal(entry.previous, entry.data));
    const applied = [];
    const put = async (url, data, etag) => {
      if (typeof etag !== "string" || !/^"[^"\r\n]+"$/.test(etag)) {
        throw new Error("PROXY_CONFIG_REVISION_REQUIRED");
      }
      const result = await h.request("PUT", url, { body: data, ifMatch: etag, timeoutMs: 30_000 });
      if (result.status === 412) throw Object.assign(conflict("Configuration changed during save. Refresh and try again"), { retryable: true });
      if (!result.ok) throw new Error(`Management API rejected alias save (${result.status})`);
    };
    try {
      for (const entry of changes) {
        // Detect external writes after our fresh read. Local alias writers
        // are serialized; a changed section is never overwritten blindly.
        const snapshot = await h.fetchLegacyConfig();
        const current = sections(snapshot).find((section) => section.url === entry.url).data;
        if (!equal(current, entry.previous)) throw Object.assign(conflict("Configuration changed during save. Refresh and try again"), { retryable: true });
        applied.push(entry); // An HTTP error can follow a successful server write.
        await put(entry.url, entry.data, snapshot.etag);
      }
    } catch (error) {
      let incomplete = false;
      for (const entry of applied.reverse()) {
        try {
          const snapshot = await h.fetchLegacyConfig();
          const current = sections(snapshot).find((section) => section.url === entry.url).data;
          if (equal(current, entry.previous)) continue;
          if (!equal(current, entry.data)) { incomplete = true; continue; }
          await put(entry.url, entry.previous, snapshot.etag);
        } catch { incomplete = true; }
      }
      if (incomplete) {
        error.retryable = false;
        error.message += "; rollback could not restore every section because configuration changed or the core is unavailable";
      }
      throw error;
    }
  }

  async function loadState() {
    const [available, definitions] = await Promise.all([h.fetchAvailableModels(), h.fetchOauthDefinitions()]);
    const { legacy: root, nativeApiKeys: native } = await h.fetchLegacyConfig();
    const choices = sources(root, native, definitions, available);
    return { ...list(root, native), baseSources: choices.map((entry) => entry.source),
      thinkingSources: choices.filter((entry) => entry.source.reasoningLevels.length).map((entry) => entry.source),
      speedSources: choices.filter((entry) => entry.fast).map((entry) => entry.source) };
  }
  async function getEditContext(payload) {
    const definitions = await h.fetchOauthDefinitions();
    const { legacy: root, nativeApiKeys: native } = await h.fetchLegacyConfig();
    const node = resolveMapping(root, native, payload, payload.alias);
    return { mappingId: node.mappingId, revision: node.revision, source: sourceFor(node, true, definitions),
      effort: node.effort, fast: Boolean(node.serviceTier), serviceTier: node.serviceTier || "" };
  }
  async function save(payload, deleting) {
    const [available, definitions] = deleting ? [[], []] : await Promise.all([h.fetchAvailableModels(), h.fetchOauthDefinitions()]);
    for (let attempt = 0; ; attempt++) {
      const before = await h.fetchLegacyConfig();
      const after = structuredClone(before);
      // Reapply onto fresh config after an unrelated external change. The
      // mapping's own revision still has to match on every attempt.
      mutate(after, payload, definitions, available, deleting);
      try {
        await write(before, after);
        return list(after.legacy, after.nativeApiKeys);
      } catch (error) {
        if (!error.retryable || attempt >= 2) throw error;
      }
    }
  }
  return {
    loadState: () => serial(loadState), getEditContext: (payload) => serial(() => getEditContext(payload)),
    createAlias: (payload) => serial(() => save(payload, false)),
    createSpeedAlias: (payload) => serial(() => save({ ...payload, fast: true }, false)),
    deleteAlias: (payload) => serial(() => save(payload, true)),
  };
}

module.exports = { createMappingService };
