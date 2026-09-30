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
          name: "",
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
      placeholder: "sk-…",
      secret: true,
      hintKey: "pswitch.field.codex_key_hint",
    },
    {
      id: "relay_name",
      path: "config.model_providers.custom.name",
      labelKey: "pswitch.field.relay_name",
      placeholder: "",
    },
    {
      id: "base_url",
      path: "config.model_providers.custom.base_url",
      labelKey: "pswitch.field.base_url",
      placeholder: "https://your-relay.example.com/v1",
    },
    {
      id: "wire_api",
      path: "config.model_providers.custom.wire_api",
      labelKey: "pswitch.field.wire_api",
      type: "select",
      options: [
        { value: "responses", labelKey: "pswitch.field.wire_api_responses" },
        { value: "chat", labelKey: "pswitch.field.wire_api_chat" },
      ],
      hintKey: "pswitch.field.wire_api_hint",
    },
    {
      id: "reasoning_effort",
      path: "config.model_reasoning_effort",
      labelKey: "pswitch.field.reasoning_effort",
      type: "select",
      options: [
        { value: "minimal", labelKey: "pswitch.field.effort.minimal" },
        { value: "low", labelKey: "pswitch.field.effort.low" },
        { value: "medium", labelKey: "pswitch.field.effort.medium" },
        { value: "high", labelKey: "pswitch.field.effort.high" },
        { value: "xhigh", labelKey: "pswitch.field.effort.xhigh" },
        { value: "max", labelKey: "pswitch.field.effort.max" },
      ],
      hintKey: "pswitch.field.reasoning_effort_hint",
    },
    {
      id: "model",
      path: "config.model",
      labelKey: "pswitch.field.model",
      placeholder: "",
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

const PRESETS = {
  claude: [CLAUDE_OFFICIAL, CLAUDE_KIMI, CLAUDE_DEEPSEEK, CLAUDE_MODELSCOPE, CLAUDE_CUSTOM],
  codex: [CODEX_OFFICIAL, CODEX_CUSTOM],
  gemini: [GEMINI_OFFICIAL, GEMINI_CUSTOM],
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
