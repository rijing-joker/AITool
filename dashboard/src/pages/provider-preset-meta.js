// Preset catalogs are editable defaults. Never replace a user's own catalog
// (including a live external catalog pointer that could not be imported).
export function mergePresetMeta(meta = {}, presetMeta = {}, config = {}) {
  const next = { ...meta };
  if (!meta.codexCatalogModels?.length && !config.model_catalog_json && presetMeta.codexCatalogModels?.length) {
    next.codexCatalogModels = structuredClone(presetMeta.codexCatalogModels);
  }
  return next;
}

export function prefillProviderMeta(app, row, presets) {
  const meta = { ...(row?.meta || {}) };
  if (app !== "codex" || row?.category === "official") return meta;
  const config = row?.settingsConfig?.config || {};
  const endpoint = config.model_providers?.[config.model_provider || "custom"]?.base_url
    || config.openai_base_url || config.base_url;
  if (!endpoint) return meta;
  const preset = presets.find((item) => (item.id === "codex_moark" || item.group === "local")
    && item.endpointCandidates?.some((url) => url.replace(/\/+$/, "") === endpoint.replace(/\/+$/, "")));
  return mergePresetMeta(meta, preset?.meta, config);
}

export function claudeApiKeyName(env = {}) {
  // Local services intentionally pair a bearer token with an empty API key.
  // Selecting the empty key would hide the preset's token and fail validation.
  return env.ANTHROPIC_API_KEY || (!env.ANTHROPIC_AUTH_TOKEN && "ANTHROPIC_API_KEY" in env)
    ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
}
