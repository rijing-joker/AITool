// Built-in provider presets, ported from cc-switch's src/config/*ProviderPresets.ts
// (official + generic custom templates only — the partner/promotion catalog
// is upstream-specific and intentionally not carried over).
//
// Presets are templates: the dashboard's add-provider dialog copies one into
// the editor. `name` is the English fallback; `nameKey` resolves through the
// dashboard copy registry when present.

const CLAUDE_OFFICIAL = {
  id: "claude_official",
  name: "Anthropic Official",
  nameKey: "pswitch.preset.claude_official",
  category: "official",
  settingsConfig: {
    env: {
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    },
  },
};

const CLAUDE_CUSTOM = {
  id: "claude_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.claude_custom",
  category: "custom",
  settingsConfig: {
    env: {
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "https://your-relay.example.com",
      ANTHROPIC_MODEL: "",
    },
  },
};

const CODEX_OFFICIAL = {
  id: "codex_official",
  name: "OpenAI Official (ChatGPT Login)",
  nameKey: "pswitch.preset.codex_official",
  category: "official",
  settingsConfig: {
    auth: null,
    config: {},
  },
};

const CODEX_CUSTOM = {
  id: "codex_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.codex_custom",
  category: "custom",
  settingsConfig: {
    auth: null,
    config: {
      model: "",
      model_provider: "custom",
      model_providers: {
        custom: {
          name: "Custom Relay",
          base_url: "https://your-relay.example.com/v1",
          wire_api: "responses",
        },
      },
    },
  },
};

const GEMINI_OFFICIAL = {
  id: "gemini_official",
  name: "Google Official",
  nameKey: "pswitch.preset.gemini_official",
  category: "official",
  settingsConfig: {
    env: {
      GEMINI_API_KEY: "",
    },
  },
};

const GEMINI_CUSTOM = {
  id: "gemini_custom",
  name: "Custom Relay",
  nameKey: "pswitch.preset.gemini_custom",
  category: "custom",
  settingsConfig: {
    env: {
      GEMINI_API_KEY: "",
      GOOGLE_GEMINI_BASE_URL: "https://your-relay.example.com",
    },
  },
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

module.exports = { listPresets, getPreset, PRESETS };
