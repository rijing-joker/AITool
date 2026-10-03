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
// `provider.$slot.…` has `$slot` substituted by the dialog with the slot key
// the row/preset is pinned under, and the sentinel `ADDITIVE_MODEL_POINTER`
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
// Additive apps (opencode / openclaw / mcode / hermes / pi / grokbuild) — see
// additive.js for the row wrapper shape. Community presets are carried from
// cc-switch's MIT-licensed per-app provider presets (affiliate parameters
// stripped, model lists trimmed to the rows these CLIs actively resolve
// today). mcode and pi have no default-model pointer — MiniMax Code and Pi
// own model selection — so their presets carry modelId only as entry
// metadata; grokbuild's pointer selects the provider table, not a model.
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
    { id: "api_key", path: "provider.$slot.apiKey", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
    { id: "base_url", path: "provider.$slot.baseUrl", labelKey: "pswitch.field.base_url", placeholder: "https://api.moonshot.cn/v1" },
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
    { id: "api_key", path: "provider.$slot.apiKey", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
    { id: "base_url", path: "provider.$slot.baseUrl", labelKey: "pswitch.field.base_url", placeholder: "https://api.deepseek.com/v1" },
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
    { id: "api_key", path: "provider.$slot.apiKey", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
    { id: "base_url", path: "provider.$slot.baseUrl", labelKey: "pswitch.field.base_url", placeholder: "https://your-relay.example.com/v1" },
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
    { id: "api_key", path: "provider.$slot.options.apiKey", labelKey: "pswitch.field.api_key", placeholder: "ey-…", secret: true },
    { id: "base_url", path: "provider.$slot.options.baseURL", labelKey: "pswitch.field.base_url", placeholder: "https://api.minimax.cn/anthropic" },
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
    { id: "api_key", path: "provider.$slot.options.apiKey", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
    { id: "base_url", path: "provider.$slot.options.baseURL", labelKey: "pswitch.field.base_url", placeholder: "https://your-relay.example.com" },
  ],
};

// ---------------------------------------------------------------------------
// Hermes (cc-switch's hermesProviderPresets, affiliate links stripped, model
// lists trimmed): providers live in ~/.hermes/config.yaml's custom_providers
// list keyed by the entry `name`, and the switch updates the top-level
// `model.default`/`model.provider` pointers (see additive.js). api_mode is
// carried per preset and editable through the YAML editor.
// ---------------------------------------------------------------------------

const HERMES_FORM_FIELDS = [
  { id: "api_key", path: "custom_providers.$slot.api_key", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
  { id: "base_url", path: "custom_providers.$slot.base_url", labelKey: "pswitch.field.base_url", placeholder: "https://your-relay.example.com/v1" },
  { id: "model", path: "custom_providers.$slot.model", labelKey: "pswitch.field.model", placeholder: "" },
];

const HERMES_NOUS = {
  id: "hermes_nous",
  name: "Nous Research",
  // Community (not official): the inference API authenticates by API key, so
  // the key/endpoint fields must stay visible in the add dialog.
  group: "community",
  icon: "sparkles",
  color: "violet",
  websiteUrl: "https://nousresearch.com",
  endpointCandidates: ["https://inference-api.nousresearch.com/v1"],
  settingsConfig: {
    slotKey: "nous",
    modelId: "Hermes-4-405B",
    provider: {
      name: "nous",
      base_url: "https://inference-api.nousresearch.com/v1",
      api_key: "",
      api_mode: "chat_completions",
      model: "Hermes-4-405B",
    },
  },
  formFields: HERMES_FORM_FIELDS,
};

const HERMES_KIMI = {
  id: "hermes_kimi",
  name: "Kimi",
  group: "community",
  icon: "moon",
  color: "indigo",
  websiteUrl: "https://platform.kimi.com",
  endpointCandidates: ["https://api.moonshot.cn/v1"],
  settingsConfig: {
    slotKey: "kimi",
    modelId: "kimi-k2.7-code",
    provider: {
      name: "kimi",
      base_url: "https://api.moonshot.cn/v1",
      api_key: "",
      api_mode: "chat_completions",
      model: "kimi-k2.7-code",
    },
  },
  formFields: HERMES_FORM_FIELDS,
};

const HERMES_DEEPSEEK = {
  id: "hermes_deepseek",
  name: "DeepSeek",
  group: "community",
  icon: "waves",
  color: "blue",
  websiteUrl: "https://platform.deepseek.com",
  endpointCandidates: ["https://api.deepseek.com"],
  settingsConfig: {
    slotKey: "deepseek",
    modelId: "deepseek-v4-pro",
    provider: {
      name: "deepseek",
      base_url: "https://api.deepseek.com",
      api_key: "",
      api_mode: "chat_completions",
      model: "deepseek-v4-pro",
    },
  },
  formFields: HERMES_FORM_FIELDS,
};

const HERMES_MODELSCOPE = {
  id: "hermes_modelscope",
  name: "ModelScope",
  group: "community",
  icon: "boxes",
  color: "violet",
  websiteUrl: "https://modelscope.cn",
  endpointCandidates: ["https://api-inference.modelscope.cn/v1"],
  settingsConfig: {
    slotKey: "modelscope",
    modelId: "ZhipuAI/GLM-5.2",
    provider: {
      name: "modelscope",
      base_url: "https://api-inference.modelscope.cn/v1",
      api_key: "",
      api_mode: "chat_completions",
      model: "ZhipuAI/GLM-5.2",
    },
  },
  formFields: HERMES_FORM_FIELDS,
};

const HERMES_CUSTOM = {
  id: "hermes_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.hermes_custom",
  group: "custom",
  icon: "shuffle",
  color: "blue",
  settingsConfig: {
    slotKey: "custom",
    modelId: "",
    provider: {
      name: "custom",
      base_url: "",
      api_key: "",
      api_mode: "chat_completions",
      model: "",
    },
  },
  formFields: HERMES_FORM_FIELDS,
};

// ---------------------------------------------------------------------------
// Pi (cc-switch's piProviderPresets, trimmed): providers are entries of
// ~/.pi/agent/models.json's `providers` dict; enabling = the entry exists.
// Pi owns defaultProvider/defaultModel itself, so there is no pointer to
// write and the model rides in the entry's models[0].id.
// ---------------------------------------------------------------------------

const PI_FORM_FIELDS = [
  { id: "api_key", path: "providers.$slot.apiKey", labelKey: "pswitch.field.api_key", placeholder: "sk-…", secret: true },
  { id: "base_url", path: "providers.$slot.baseUrl", labelKey: "pswitch.field.base_url", placeholder: "https://your-relay.example.com/v1" },
  { id: "model", path: "providers.$slot.models.0.id", labelKey: "pswitch.field.model", placeholder: "" },
];

const PI_KIMI = {
  id: "pi_kimi",
  name: "Kimi",
  group: "community",
  icon: "moon",
  color: "indigo",
  websiteUrl: "https://platform.kimi.com",
  endpointCandidates: ["https://api.moonshot.cn/v1"],
  settingsConfig: {
    slotKey: "kimi",
    modelId: "kimi-k2.7-code",
    provider: {
      name: "Kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      api: "openai-completions",
      apiKey: "",
      models: [
        { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
        { id: "kimi-k3", name: "Kimi K3", reasoning: true },
      ],
    },
  },
  formFields: PI_FORM_FIELDS,
};

const PI_DEEPSEEK = {
  id: "pi_deepseek",
  name: "DeepSeek",
  group: "community",
  icon: "waves",
  color: "blue",
  websiteUrl: "https://platform.deepseek.com",
  endpointCandidates: ["https://api.deepseek.com/v1"],
  settingsConfig: {
    slotKey: "deepseek",
    modelId: "deepseek-v4-pro",
    provider: {
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      api: "openai-completions",
      apiKey: "",
      models: [
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true },
        { id: "deepseek-flash", name: "DeepSeek Flash", reasoning: true },
      ],
    },
  },
  formFields: PI_FORM_FIELDS,
};

const PI_MODELSCOPE = {
  id: "pi_modelscope",
  name: "ModelScope",
  group: "community",
  icon: "boxes",
  color: "violet",
  websiteUrl: "https://modelscope.cn",
  endpointCandidates: ["https://api-inference.modelscope.cn/v1"],
  settingsConfig: {
    slotKey: "modelscope",
    modelId: "ZhipuAI/GLM-5.2",
    provider: {
      name: "ModelScope",
      baseUrl: "https://api-inference.modelscope.cn/v1",
      api: "openai-completions",
      apiKey: "",
      models: [{ id: "ZhipuAI/GLM-5.2", name: "GLM 5.2" }],
    },
  },
  formFields: PI_FORM_FIELDS,
};

const PI_CUSTOM = {
  id: "pi_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.pi_custom",
  group: "custom",
  icon: "shuffle",
  color: "blue",
  settingsConfig: {
    slotKey: "custom",
    modelId: "",
    provider: {
      name: "custom",
      baseUrl: "",
      api: "openai-completions",
      apiKey: "",
      models: [{ id: "" }],
    },
  },
  formFields: PI_FORM_FIELDS,
};

// ---------------------------------------------------------------------------
// Grok Build (cc-switch's grokBuildProviderPresets, trimmed): providers are
// [model."<key>"] tables in ~/.grok/config.toml and [models] default points
// at the table name. Only aggregators/relays carry grok models; api_backend
// stays "responses" (cc-switch's form pins it the same way).
// ---------------------------------------------------------------------------

const GROKBUILD_FORM_FIELDS = [
  { id: "api_key", path: "model.$slot.api_key", labelKey: "pswitch.field.api_key", placeholder: "xai-…", secret: true },
  { id: "base_url", path: "model.$slot.base_url", labelKey: "pswitch.field.base_url", placeholder: "https://your-relay.example.com/v1" },
  { id: "model", path: "model.$slot.model", labelKey: "pswitch.field.model", placeholder: "" },
];

function grokbuildWrapper(slotKey, displayName, baseUrl, model) {
  return {
    slotKey,
    modelId: model,
    provider: {
      name: displayName,
      model,
      base_url: baseUrl,
      api_key: "",
      api_backend: "responses",
      context_window: 500000,
    },
  };
}

const GROKBUILD_XAI = {
  id: "grokbuild_xai",
  name: "xAI (Grok)",
  group: "community",
  icon: "terminal",
  color: "gray",
  websiteUrl: "https://x.ai/api",
  endpointCandidates: ["https://api.x.ai/v1"],
  settingsConfig: grokbuildWrapper("xai", "xAI (Grok)", "https://api.x.ai/v1", "grok-4.5"),
  formFields: GROKBUILD_FORM_FIELDS,
};

const GROKBUILD_OPENROUTER = {
  id: "grokbuild_openrouter",
  name: "OpenRouter",
  group: "community",
  icon: "globe",
  color: "indigo",
  websiteUrl: "https://openrouter.ai",
  endpointCandidates: ["https://openrouter.ai/api/v1"],
  settingsConfig: grokbuildWrapper("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "x-ai/grok-4.5"),
  formFields: GROKBUILD_FORM_FIELDS,
};

const GROKBUILD_CUSTOM = {
  id: "grokbuild_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.grokbuild_custom",
  group: "custom",
  icon: "shuffle",
  color: "blue",
  settingsConfig: grokbuildWrapper("custom", "custom", "", ""),
  formFields: GROKBUILD_FORM_FIELDS,
};

const PRESETS = {
  claude: [CLAUDE_OFFICIAL, CLAUDE_KIMI, CLAUDE_DEEPSEEK, CLAUDE_MODELSCOPE, CLAUDE_CUSTOM],
  codex: [CODEX_OFFICIAL, CODEX_CUSTOM],
  gemini: [GEMINI_OFFICIAL, GEMINI_CUSTOM],
  opencode: [OPENCODE_KIMI, OPENCODE_DEEPSEEK, OPENCODE_MODELSCOPE, OPENCODE_CUSTOM],
  openclaw: [OPENCLAW_KIMI, OPENCLAW_DEEPSEEK, OPENCLAW_CUSTOM],
  mcode: [MCODE_MINIMAX, MCODE_CUSTOM],
  hermes: [HERMES_NOUS, HERMES_KIMI, HERMES_DEEPSEEK, HERMES_MODELSCOPE, HERMES_CUSTOM],
  pi: [PI_KIMI, PI_DEEPSEEK, PI_MODELSCOPE, PI_CUSTOM],
  grokbuild: [GROKBUILD_XAI, GROKBUILD_OPENROUTER, GROKBUILD_CUSTOM],
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
