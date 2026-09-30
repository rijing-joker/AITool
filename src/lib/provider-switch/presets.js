// Built-in provider presets, ported from cc-switch's src/config/*ProviderPresets.ts
// (official + generic custom templates only — the partner/promotion catalog
// is upstream-specific and intentionally not carried over).
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
// dashboard's avatar palette.

const CLAUDE_OFFICIAL = {
  id: "claude_official",
  name: "Anthropic Official",
  nameKey: "pswitch.preset.claude_official",
  hintKey: "pswitch.hint.claude_official",
  category: "official",
  icon: "sparkles",
  color: "orange",
  websiteUrl: "https://www.anthropic.com/claude-code",
  // Official plan: authenticated by the Claude login / OAuth token on the
  // machine, so the template carries no credentials (cc-switch does the same).
  settingsConfig: { env: {} },
  formFields: [],
};

const CLAUDE_CUSTOM = {
  id: "claude_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.claude_custom",
  category: "custom",
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
  category: "official",
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
  category: "custom",
  icon: "shuffle",
  color: "blue",
  settingsConfig: {
    auth: null,
    config: {
      model: "",
      model_provider: "custom",
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
  category: "official",
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
  category: "custom",
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
  claude: [CLAUDE_OFFICIAL, CLAUDE_CUSTOM],
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
  const custom = PRESETS[app]?.find((preset) => preset.category === "custom");
  return custom ? custom.formFields : [];
}

module.exports = { listPresets, getPreset, defaultFormFields, PRESETS };
