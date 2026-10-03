// Built-in provider presets, ported from cc-switch's src/config/*ProviderPresets.ts
// (official + community/relay templates; the sponsored-partner promotion
// catalog — affiliate links, prime badges — is intentionally not carried over).
//
// Each preset carries a `settingsConfig` template plus declarative
// `formFields` (the port of cc-switch's templateValues): the dashboard's
// add-provider dialog renders one input per field and writes values into the
// template at the dotted `path`, so presets stay data and the interaction
// mirrors the upstream dialog (preset cards → structured form → optional raw
// JSON editor).
//
// `name` is the English fallback; `nameKey`/`hintKey`/field `labelKey`s
// resolve through the dashboard copy registry. `color` keys into the
// dashboard's avatar palette. `group` drives the selector badge
// (official | community | custom). `endpointCandidates` seeds the endpoint
// speed-test dialog; `modelsUrl` overrides the model-list URL when the
// models endpoint lives on a different host than the API endpoint.
//
// Additive-app presets (opencode/openclaw/mcode) carry the wrapper shape
// documented in additive.js. Their `formFields` paths, though, address the
// FULL native document the dialog edits after the editor view loads:
// The container is `provider`, `models.providers`, or `custom_provider`.
// `$slot` is substituted by the dialog with the row/preset's slot key, and
// the sentinel `ADDITIVE_MODEL_POINTER`
// resolves to the app's default-model pointer path.

const CLAUDE_OFFICIAL = {
  id: "claude_official",
  name: "Anthropic Official",
  nameKey: "pswitch.preset.claude_official",
  hintKey: "pswitch.hint.claude_official",
  group: "official",
  icon: "sparkles",
  color: "orange",
  websiteUrl: "https://www.anthropic.com/claude-code",
  // Official plan: authenticated by the Claude login / OAuth token on the
  // machine, so the template carries no credentials (cc-switch does the same).
  settingsConfig: { env: {} },
  formFields: [],
};

// Community presets below are carried verbatim from cc-switch's MIT-licensed
// claudeProviderPresets.ts (affiliate parameters stripped), including their
// role-model mappings so Claude Code's /model menu keeps working per relay.
const CLAUDE_KIMI = {
  id: "claude_kimi",
  name: "Kimi",
  group: "community",
  icon: "moon",
  color: "indigo",
  websiteUrl: "https://platform.kimi.com",
  endpointCandidates: ["https://api.moonshot.cn/anthropic"],
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "kimi-k2.7-code",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2.7-code",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k2.7-code",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k2.7-code",
    },
  },
  formFields: [
    {
      id: "api_key",
      path: "env.ANTHROPIC_AUTH_TOKEN",
      labelKey: "pswitch.field.api_key",
      placeholder: "sk-…",
      secret: true,
    },
  ],
};

const CLAUDE_DEEPSEEK = {
  id: "claude_deepseek",
  name: "DeepSeek",
  group: "community",
  icon: "waves",
  color: "blue",
  websiteUrl: "https://platform.deepseek.com",
  endpointCandidates: ["https://api.deepseek.com/anthropic"],
  // The Anthropic-compatible layer lives under /anthropic; /models is a
  // separate endpoint at the root (same note as cc-switch's preset).
  modelsUrl: "https://api.deepseek.com/models",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
    },
  },
  formFields: [
    {
      id: "api_key",
      path: "env.ANTHROPIC_AUTH_TOKEN",
      labelKey: "pswitch.field.api_key",
      placeholder: "sk-…",
      secret: true,
    },
  ],
};

const CLAUDE_MODELSCOPE = {
  id: "claude_modelscope",
  name: "ModelScope",
  group: "community",
  icon: "boxes",
  color: "violet",
  websiteUrl: "https://modelscope.cn",
  endpointCandidates: ["https://api-inference.modelscope.cn"],
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://api-inference.modelscope.cn",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "ZhipuAI/GLM-5.2",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "ZhipuAI/GLM-5.2",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "ZhipuAI/GLM-5.2",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "ZhipuAI/GLM-5.2",
    },
  },
  formFields: [
    {
      id: "api_key",
      path: "env.ANTHROPIC_AUTH_TOKEN",
      labelKey: "pswitch.field.api_key",
      placeholder: "ms-…",
      secret: true,
    },
  ],
};

const CLAUDE_CUSTOM = {
  id: "claude_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.claude_custom",
  group: "custom",
  icon: "shuffle",
  color: "blue",
  settingsConfig: {
    env: {
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "",
      ANTHROPIC_MODEL: "",
    },
  },
  formFields: [
    {
      id: "base_url",
      path: "env.ANTHROPIC_BASE_URL",
      labelKey: "pswitch.field.base_url",
      placeholder: "https://your-relay.example.com",
    },
    {
      id: "api_key",
      path: "env.ANTHROPIC_AUTH_TOKEN",
      labelKey: "pswitch.field.api_key",
      placeholder: "sk-…",
      secret: true,
    },
    {
      id: "model",
      path: "env.ANTHROPIC_MODEL",
      labelKey: "pswitch.field.model",
      placeholder: "",
      hintKey: "pswitch.field.model_hint",
    },
  ],
};

const CODEX_OFFICIAL = {
  id: "codex_official",
  name: "OpenAI Official (ChatGPT Login)",
  nameKey: "pswitch.preset.codex_official",
  hintKey: "pswitch.hint.codex_official",
  group: "official",
  icon: "terminal",
  color: "green",
  websiteUrl: "https://chatgpt.com/codex",
  settingsConfig: { auth: null, config: {} },
  formFields: [],
};

// Field set mirrors cc-switch's CodexFormFields: API Key, endpoint, default
// model — nothing else. wire_api stays "responses" in the template (cc-switch
// forces the same); relays that need another protocol are edited through the
// config editor. Relay display name, wire protocol and reasoning effort are
// template keys without dedicated inputs.
const CODEX_CUSTOM = {
  id: "codex_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.codex_custom",
  group: "custom",
  icon: "shuffle",
  color: "blue",
  settingsConfig: {
    auth: { OPENAI_API_KEY: "" },
    config: {
      model: "",
      model_provider: "custom",
      model_reasoning_effort: "high",
      model_providers: {
        custom: {
          name: "custom",
          base_url: "",
          wire_api: "responses",
        },
      },
    },
  },
  formFields: [
    {
      id: "api_key",
      path: "auth.OPENAI_API_KEY",
      labelKey: "pswitch.field.api_key",
      placeholderKey: "pswitch.field.codex_key_placeholder",
      secret: true,
    },
    {
      id: "base_url",
      path: "config.model_providers.custom.base_url",
      labelKey: "pswitch.field.base_url",
      placeholder: "https://your-relay.example.com/v1",
    },
    {
      id: "model",
      path: "config.model",
      labelKey: "pswitch.field.default_model",
      placeholder: "",
      hintKey: "pswitch.field.default_model_hint",
    },
  ],
};

const GEMINI_OFFICIAL = {
  id: "gemini_official",
  name: "Google Official",
  nameKey: "pswitch.preset.gemini_official",
  group: "official",
  icon: "gem",
  color: "sky",
  websiteUrl: "https://aistudio.google.com/",
  settingsConfig: { env: { GEMINI_API_KEY: "" } },
  formFields: [
    {
      id: "api_key",
      path: "env.GEMINI_API_KEY",
      labelKey: "pswitch.field.api_key",
      placeholder: "AIza…",
      secret: true,
    },
  ],
};

const GEMINI_CUSTOM = {
  id: "gemini_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.gemini_custom",
  group: "custom",
  icon: "shuffle",
  color: "blue",
  settingsConfig: {
    env: {
      GEMINI_API_KEY: "",
      GOOGLE_GEMINI_BASE_URL: "",
      GEMINI_MODEL: "",
    },
  },
  formFields: [
    {
      id: "api_key",
      path: "env.GEMINI_API_KEY",
      labelKey: "pswitch.field.api_key",
      placeholder: "AIza…",
      secret: true,
    },
    {
      id: "base_url",
      path: "env.GOOGLE_GEMINI_BASE_URL",
      labelKey: "pswitch.field.base_url",
      placeholder: "https://your-relay.example.com",
    },
    {
      id: "model",
      path: "env.GEMINI_MODEL",
      labelKey: "pswitch.field.model",
      placeholder: "",
    },
  ],
};

// ---------------------------------------------------------------------------
// Additive apps (opencode / openclaw / mcode) — see additive.js for the row
// wrapper shape. Community presets are carried from cc-switch's MIT-licensed
// opencode/openclaw/mcode provider presets (affiliate parameters stripped,
// model lists trimmed to the rows these CLIs actively resolve today). mcode
// has no default-model pointer — MiniMax Code owns model selection — so its
// presets carry no modelId.
// ---------------------------------------------------------------------------

const OPENCODE_KIMI = {
  id: "opencode_kimi",
  name: "Kimi",
  group: "community",
  icon: "moon",
  color: "indigo",
  websiteUrl: "https://platform.kimi.com",
  endpointCandidates: ["https://api.moonshot.cn/v1"],
  settingsConfig: {
    slotKey: "kimi",
    modelId: "kimi/kimi-k2.7-code",
    provider: {
      npm: "@ai-sdk/openai-compatible",
      name: "Kimi",
      options: {
        baseURL: "https://api.moonshot.cn/v1",
        apiKey: "",
      },
      models: {
        "kimi-k2.7-code": { name: "Kimi K2.7 Code" },
        "kimi-k3": { name: "Kimi K3" },
      },
    },
  },
  formFields: [
    { id: "api_key", path: "provider.$slot.options.apiKey", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
    { id: "base_url", path: "provider.$slot.options.baseURL", labelKey: "pswitch.field.base_url", placeholder: "https://api.moonshot.cn/v1" },
  ],
};

const OPENCODE_DEEPSEEK = {
  id: "opencode_deepseek",
  name: "DeepSeek",
  group: "community",
  icon: "waves",
  color: "blue",
  websiteUrl: "https://platform.deepseek.com",
  endpointCandidates: ["https://api.deepseek.com/v1"],
  settingsConfig: {
    slotKey: "deepseek",
    modelId: "deepseek/deepseek-chat",
    provider: {
      npm: "@ai-sdk/openai-compatible",
      name: "DeepSeek",
      options: {
        baseURL: "https://api.deepseek.com/v1",
        apiKey: "",
      },
      models: {
        "deepseek-chat": { name: "DeepSeek Chat" },
        "deepseek-reasoner": { name: "DeepSeek Reasoner" },
      },
    },
  },
  formFields: [
    { id: "api_key", path: "provider.$slot.options.apiKey", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
    { id: "base_url", path: "provider.$slot.options.baseURL", labelKey: "pswitch.field.base_url", placeholder: "https://api.deepseek.com/v1" },
  ],
};

const OPENCODE_MODELSCOPE = {
  id: "opencode_modelscope",
  name: "ModelScope",
  group: "community",
  icon: "boxes",
  color: "violet",
  websiteUrl: "https://modelscope.cn",
  endpointCandidates: ["https://api-inference.modelscope.cn/v1"],
  settingsConfig: {
    slotKey: "modelscope",
    modelId: "modelscope/ZhipuAI/GLM-5.2",
    provider: {
      npm: "@ai-sdk/openai-compatible",
      name: "ModelScope",
      options: {
        baseURL: "https://api-inference.modelscope.cn/v1",
        apiKey: "",
      },
      models: {
        "ZhipuAI/GLM-5.2": { name: "GLM 5.2" },
        "ZhipuAI/GLM-5.1": { name: "GLM 5.1" },
      },
    },
  },
  formFields: [
    { id: "api_key", path: "provider.$slot.options.apiKey", labelKey: "pswitch.field.api_key", placeholder: "ms-…", secret: true },
    { id: "base_url", path: "provider.$slot.options.baseURL", labelKey: "pswitch.field.base_url", placeholder: "https://api-inference.modelscope.cn/v1" },
  ],
};

const OPENCODE_CUSTOM = {
  id: "opencode_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.opencode_custom",
  group: "custom",
  icon: "shuffle",
  color: "blue",
  settingsConfig: {
    slotKey: "custom",
    modelId: "",
    provider: {
      npm: "@ai-sdk/openai-compatible",
      name: "custom",
      options: { baseURL: "", apiKey: "" },
      models: {},
    },
  },
  formFields: [
    { id: "api_key", path: "provider.$slot.options.apiKey", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
    { id: "base_url", path: "provider.$slot.options.baseURL", labelKey: "pswitch.field.base_url", placeholder: "https://your-relay.example.com/v1" },
    {
      id: "model",
      path: "ADDITIVE_MODEL_POINTER",
      labelKey: "pswitch.field.default_model",
      placeholder: "",
      hintKey: "pswitch.field.additive_model_hint",
    },
  ],
};

const OPENCLAW_KIMI = {
  id: "openclaw_kimi",
  name: "Kimi",
  group: "community",
  icon: "moon",
  color: "indigo",
  websiteUrl: "https://platform.kimi.com",
  endpointCandidates: ["https://api.moonshot.cn/v1"],
  settingsConfig: {
    slotKey: "kimi",
    modelId: "kimi/kimi-k2.7-code",
    provider: {
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "",
      api: "openai-completions",
      models: [
        { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextWindow: 262144 },
        { id: "kimi-k3", name: "Kimi K3", contextWindow: 1048576 },
      ],
    },
  },
  formFields: [
    { id: "api_key", path: "models.providers.$slot.apiKey", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
    { id: "base_url", path: "models.providers.$slot.baseUrl", labelKey: "pswitch.field.base_url", placeholder: "https://api.moonshot.cn/v1" },
  ],
};

const OPENCLAW_DEEPSEEK = {
  id: "openclaw_deepseek",
  name: "DeepSeek",
  group: "community",
  icon: "waves",
  color: "blue",
  websiteUrl: "https://platform.deepseek.com",
  endpointCandidates: ["https://api.deepseek.com/v1"],
  settingsConfig: {
    slotKey: "deepseek",
    modelId: "deepseek/deepseek-chat",
    provider: {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      api: "openai-completions",
      models: [
        { id: "deepseek-chat", name: "DeepSeek Chat" },
        { id: "deepseek-reasoner", name: "DeepSeek Reasoner", reasoning: true },
      ],
    },
  },
  formFields: [
    { id: "api_key", path: "models.providers.$slot.apiKey", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
    { id: "base_url", path: "models.providers.$slot.baseUrl", labelKey: "pswitch.field.base_url", placeholder: "https://api.deepseek.com/v1" },
  ],
};

const OPENCLAW_CUSTOM = {
  id: "openclaw_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.openclaw_custom",
  group: "custom",
  icon: "shuffle",
  color: "blue",
  settingsConfig: {
    slotKey: "custom",
    modelId: "",
    provider: {
      baseUrl: "",
      apiKey: "",
      api: "openai-completions",
      models: [],
    },
  },
  formFields: [
    { id: "api_key", path: "models.providers.$slot.apiKey", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
    { id: "base_url", path: "models.providers.$slot.baseUrl", labelKey: "pswitch.field.base_url", placeholder: "https://your-relay.example.com/v1" },
    {
      id: "model",
      path: "ADDITIVE_MODEL_POINTER",
      labelKey: "pswitch.field.default_model",
      placeholder: "",
      hintKey: "pswitch.field.additive_model_hint",
    },
  ],
};

const MCODE_MINIMAX = {
  id: "mcode_minimax",
  name: "MiniMax Official",
  nameKey: "pswitch.preset.mcode_minimax",
  // Community (not official): MiniMax Code has no login flow — the official
  // service still authenticates by Console API key, and the key/endpoint
  // fields must stay visible in the add dialog.
  group: "community",
  icon: "sparkles",
  color: "amber",
  websiteUrl: "https://www.minimax.io",
  endpointCandidates: ["https://api.minimax.cn/anthropic"],
  settingsConfig: {
    slotKey: "minimax",
    provider: {
      name: "MiniMax",
      kind: "custom",
      enabled: true,
      api: "anthropic-messages",
      options: {
        baseURL: "https://api.minimax.cn/anthropic",
        apiKey: "",
      },
      models: {
        "MiniMax-M3": { name: "MiniMax M3" },
      },
    },
  },
  formFields: [
    { id: "api_key", path: "custom_provider.$slot.options.apiKey", labelKey: "pswitch.field.api_key", placeholder: "ey-…", secret: true },
    { id: "base_url", path: "custom_provider.$slot.options.baseURL", labelKey: "pswitch.field.base_url", placeholder: "https://api.minimax.cn/anthropic" },
  ],
};

const MCODE_CUSTOM = {
  id: "mcode_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.mcode_custom",
  group: "custom",
  icon: "shuffle",
  color: "blue",
  settingsConfig: {
    slotKey: "custom",
    provider: {
      name: "custom",
      kind: "custom",
      enabled: true,
      api: "anthropic-messages",
      options: { baseURL: "", apiKey: "" },
      models: {},
    },
  },
  formFields: [
    { id: "api_key", path: "custom_provider.$slot.options.apiKey", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
    { id: "base_url", path: "custom_provider.$slot.options.baseURL", labelKey: "pswitch.field.base_url", placeholder: "https://your-relay.example.com" },
  ],
};

const PRESETS = {
  claude: [CLAUDE_OFFICIAL, CLAUDE_KIMI, CLAUDE_DEEPSEEK, CLAUDE_MODELSCOPE, CLAUDE_CUSTOM],
  codex: [CODEX_OFFICIAL, CODEX_CUSTOM],
  gemini: [GEMINI_OFFICIAL, GEMINI_CUSTOM],
  opencode: [OPENCODE_KIMI, OPENCODE_DEEPSEEK, OPENCODE_MODELSCOPE, OPENCODE_CUSTOM],
  openclaw: [OPENCLAW_KIMI, OPENCLAW_DEEPSEEK, OPENCLAW_CUSTOM],
  mcode: [MCODE_MINIMAX, MCODE_CUSTOM],
};

function listPresets(app) {
  return PRESETS[app] || [];
}

function getPreset(app, presetId) {
  return listPresets(app).find((preset) => preset.id === presetId) || null;
}

// Fields used by the edit dialog for providers not created from a known
// preset (or created before presets carried formFields): the per-app default
// field set, matching what the custom templates own.
function defaultFormFields(app) {
  const custom = PRESETS[app]?.find((preset) => preset.group === "custom");
  return custom ? custom.formFields : [];
}

module.exports = { listPresets, getPreset, defaultFormFields, PRESETS };
