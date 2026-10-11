"use strict";

// Older Codex presets put their endpoint at the top level. Normalize only
// that legacy shape; an existing selected route (or custom route) wins.
// Official login rows retain their original selectors and auth handling.
function normalizeCodexProviderConfig(value, { official = false } = {}) {
  const config = structuredClone(value || {});
  if (official) return config;
  if (config.model_provider === "openai" && config.model_providers?.openai) {
    return require("./floor").normalizeCodexConfig(config);
  }
  if (!config.base_url && !config.openai_base_url) return config;
  const providers = config.model_providers || {};
  const selected = providers[config.model_provider] || providers.custom;
  const route = selected && typeof selected === "object" && !Array.isArray(selected)
    ? structuredClone(selected)
    : { name: "Custom", base_url: config.openai_base_url || config.base_url, wire_api: config.wire_api || "responses" };
  if (!route.experimental_bearer_token && config.experimental_bearer_token) {
    route.experimental_bearer_token = config.experimental_bearer_token;
  }
  config.model_provider = "custom";
  config.model_providers = { ...providers, custom: route };
  delete config.base_url;
  delete config.openai_base_url;
  delete config.wire_api;
  delete config.experimental_bearer_token;
  return config;
}

module.exports = { normalizeCodexProviderConfig };
