// Local server defaults adapted from cc-switch v4.0.12 (MIT). Each address
// remains editable; model names must match a model loaded by the local server.
const SERVERS = [
  {
    id: "ollama", name: "Ollama", websiteUrl: "https://ollama.com", key: "ollama",
    endpoints: ["http://localhost:11434", "http://127.0.0.1:11434"],
    claudeModel: "qwen3.5", codexModel: "gpt-oss:20b",
    models: [
      { model: "gpt-oss:20b", displayName: "GPT-OSS 20B", contextWindow: "131072", inputModalities: ["text"], reasoningLevels: ["low", "medium", "high"] },
      { model: "gpt-oss:120b", displayName: "GPT-OSS 120B", contextWindow: "131072", inputModalities: ["text"], reasoningLevels: ["low", "medium", "high"] },
      { model: "qwen3.5", displayName: "Qwen3.5", contextWindow: "262144", inputModalities: ["text", "image"], reasoningLevels: ["none", "high"] },
    ],
  },
  {
    id: "lmstudio", name: "LM Studio", websiteUrl: "https://lmstudio.ai", key: "lmstudio",
    endpoints: ["http://localhost:1234", "http://127.0.0.1:1234"],
    claudeModel: "openai/gpt-oss-20b", codexModel: "openai/gpt-oss-20b",
    models: [{ model: "openai/gpt-oss-20b", displayName: "GPT-OSS 20B", contextWindow: "131072", inputModalities: ["text"], reasoningLevels: ["low", "medium", "high"] }],
  },
  {
    id: "llamacpp", name: "llama.cpp", websiteUrl: "https://github.com/ggml-org/llama.cpp", key: "no-key",
    endpoints: ["http://127.0.0.1:9931", "http://127.0.0.1:8080"],
    claudeModel: "ggml-org/Qwen3-Coder-30B-A3B-Instruct-Q8_0-GGUF",
    codexModel: "ggml-org/Qwen3-Coder-30B-A3B-Instruct-Q8_0-GGUF",
    models: [{ model: "ggml-org/Qwen3-Coder-30B-A3B-Instruct-Q8_0-GGUF", displayName: "Qwen3-Coder 30B A3B", contextWindow: "262144", inputModalities: ["text"], reasoningLevels: ["high"] }],
  },
  {
    id: "vllm", name: "vLLM", websiteUrl: "https://vllm.ai", key: "dummy",
    endpoints: ["http://localhost:8000", "http://127.0.0.1:8000"],
    claudeModel: "Qwen/Qwen3.6-27B", codexModel: "Qwen/Qwen3.6-27B",
    models: [{ model: "Qwen/Qwen3.6-27B", displayName: "Qwen3.6 27B", contextWindow: "262144", inputModalities: ["text", "image"], reasoningLevels: ["none", "high"] }],
  },
];

function localPreset(app, server) {
  const endpoints = server.endpoints.map((url) => app === "claude" ? url : `${url}/v1`);
  const base = {
    id: `${app}_${server.id}`, name: server.name, group: "local", icon: "server", color: "green",
    hintKey: "pswitch.hint.local", websiteUrl: server.websiteUrl, endpointCandidates: endpoints,
  };
  if (app === "claude") {
    return {
      ...base,
      settingsConfig: { env: {
        ANTHROPIC_BASE_URL: endpoints[0], ANTHROPIC_AUTH_TOKEN: server.key, ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODEL: server.claudeModel, ANTHROPIC_DEFAULT_HAIKU_MODEL: server.claudeModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: server.claudeModel, ANTHROPIC_DEFAULT_OPUS_MODEL: server.claudeModel,
      } },
      formFields: [
        { id: "base_url", path: "env.ANTHROPIC_BASE_URL", labelKey: "pswitch.field.base_url", placeholder: endpoints[0] },
        { id: "api_key", path: "env.ANTHROPIC_AUTH_TOKEN", labelKey: "pswitch.field.api_key", placeholder: server.key, secret: true },
        { id: "model", path: "env.ANTHROPIC_MODEL", labelKey: "pswitch.field.model", placeholder: server.claudeModel },
      ],
    };
  }
  if (app === "codex") {
    return {
      ...base,
      meta: { codexCatalogModels: server.models.map((row) => ({ ...row, defaultReasoningLevel: "high" })) },
      settingsConfig: { auth: null, config: {
        model: server.codexModel, model_provider: "custom", model_reasoning_effort: "high", disable_response_storage: true,
        model_providers: { custom: {
          name: server.name, base_url: endpoints[0], wire_api: "responses", experimental_bearer_token: server.key,
        } },
      } },
      formFields: [
        { id: "api_key", path: "config.model_providers.custom.experimental_bearer_token", labelKey: "pswitch.field.api_key", placeholder: server.key, secret: true },
        { id: "base_url", path: "config.model_providers.custom.base_url", labelKey: "pswitch.field.base_url", placeholder: endpoints[0] },
        { id: "model", path: "config.model", labelKey: "pswitch.field.default_model", placeholder: server.codexModel },
      ],
    };
  }
  return {
    ...base,
    settingsConfig: {
      slotKey: server.id, modelId: `${server.id}/${server.claudeModel}`,
      provider: {
        npm: "@ai-sdk/openai-compatible", name: server.name,
        options: { baseURL: endpoints[0], apiKey: server.key, setCacheKey: true },
        models: Object.fromEntries(server.models.map((row) => [row.model, {
          name: row.displayName, reasoning: row.reasoningLevels.some((level) => level !== "none"),
          limit: { context: Number(row.contextWindow), output: row.model.startsWith("qwen") || row.model.startsWith("Qwen/") ? 32768 : 65536 },
          modalities: { input: row.inputModalities, output: ["text"] },
        }])),
      },
    },
    formFields: [
      { id: "api_key", path: "provider.$slot.options.apiKey", labelKey: "pswitch.field.api_key", placeholder: server.key, secret: true },
      { id: "base_url", path: "provider.$slot.options.baseURL", labelKey: "pswitch.field.base_url", placeholder: endpoints[0] },
    ],
  };
}

module.exports = Object.fromEntries(["claude", "codex", "opencode"].map((app) => [app, SERVERS.map((server) => localPreset(app, server))]));
