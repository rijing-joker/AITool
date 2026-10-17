// Users supply an AiTool client access key, never the adapter's internal key.
function freePreset(app) {
  if (!["claude", "codex", "opencode"].includes(app)) return null;
  const endpoint = `http://127.0.0.1:${require("../proxy/config").getServerPort()}`;
  const model = "big-pickle";
  const base = {
    id: `${app}_aitool_opencode_free`, name: "AiTool OpenCode Free", nameKey: "pswitch.preset.aitool_opencode_free",
    hintKey: "pswitch.hint.aitool_opencode_free", group: "local", icon: "server", color: "green",
    websiteUrl: "https://opencode.ai/docs/zen/", endpointCandidates: [app === "claude" ? endpoint : `${endpoint}/v1`],
  };
  const key = (path) => ({ id: "api_key", path, labelKey: "pswitch.field.api_key", secret: true, placeholder: "sk-…" });
  if (app === "claude") return { ...base, settingsConfig: { env: {
    ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
  } }, formFields: [key("env.ANTHROPIC_AUTH_TOKEN"),
    { id: "base_url", path: "env.ANTHROPIC_BASE_URL", labelKey: "pswitch.field.base_url", placeholder: endpoint },
    { id: "model", path: "env.ANTHROPIC_MODEL", labelKey: "pswitch.field.model", placeholder: model }] };
  if (app === "codex") return { ...base,
    meta: { codexCatalogModels: [{ model, displayName: "Big Pickle", contextWindow: "200000", inputModalities: ["text"], reasoningLevels: [] }] },
    settingsConfig: { auth: null, config: {
    model, model_provider: "custom", disable_response_storage: true,
    model_providers: { custom: { name: base.name, base_url: `${endpoint}/v1`, wire_api: "responses", experimental_bearer_token: "" } },
  } }, formFields: [key("config.model_providers.custom.experimental_bearer_token"),
    { id: "base_url", path: "config.model_providers.custom.base_url", labelKey: "pswitch.field.base_url", placeholder: `${endpoint}/v1` },
    { id: "model", path: "config.model", labelKey: "pswitch.field.default_model", placeholder: model }] };
  return { ...base, settingsConfig: {
    slotKey: "aitool-free", modelId: `aitool-free/${model}`, provider: {
      npm: "@ai-sdk/openai-compatible", name: base.name, options: { baseURL: `${endpoint}/v1`, apiKey: "" },
      models: { [model]: { name: model, reasoning: true, limit: { context: 200000, output: 32000 }, modalities: { input: ["text"], output: ["text"] } } },
    },
  }, formFields: [key("provider.$slot.options.apiKey"),
    { id: "base_url", path: "provider.$slot.options.baseURL", labelKey: "pswitch.field.base_url", placeholder: `${endpoint}/v1` }] };
}
module.exports = { freePreset };
