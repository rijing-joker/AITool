// Key-field ("floor") tables, ported from cc-switch's src-tauri/src/live/floor.rs.
//
// Key fields answer four questions: where requests go, what authenticates
// them, which model name is used, and which protocol is spoken. They belong
// entirely to the provider: switching clears the previous provider's values
// and writes the target's. Every other key belongs to the user or the client
// tool — the projection never writes or deletes those.
//
// Prefix matching is only used where a whole prefix is connection/auth related
// (ANTHROPIC_*, AWS_*, VERTEX_REGION_*, GOOGLE_*). A missed key degrades to
// "user key, left untouched", which is the safe failure direction.

// Claude Code protocol selectors. CLAUDE_CODE_USE_ cannot be prefix-matched:
// the same prefix also carries provider-unrelated feature flags such as
// USE_POWERSHELL_TOOL / USE_NATIVE_FILE_SEARCH, so these are enumerated.
const CLAUDE_PROTOCOL_SELECTORS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
];

// env prefixes that are entirely connection/auth related.
const CLAUDE_FLOOR_ENV_PREFIXES = ["ANTHROPIC_", "AWS_", "VERTEX_REGION_"];

// env key fields besides the selectors.
const CLAUDE_FLOOR_ENV_KEYS = [
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
];

const CLAUDE_EXCLUSIVE_ENV = [
  // Upstreams like AtlasCloud/Soshow reject experimental beta headers.
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  // Strict schema validators (DeepSeek) 400 on the Artifact tool.
  "CLAUDE_CODE_DISABLE_ARTIFACT",
  // Tool search only works when the upstream forwards tool_reference blocks.
  "ENABLE_TOOL_SEARCH",
  // Compatibility options documented for proxies/gateways/third parties.
  "CLAUDE_CODE_DISABLE_THINKING",
  "DISABLE_INTERLEAVED_THINKING",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "CLAUDE_CODE_EXTRA_BODY",
  "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
  // Claude Code 2.1.281 auto-mode classifier only works on official
  // endpoints; gateway sessions need this at 0 or they get blocked.
  "CLAUDE_CODE_AUTO_MODE_SERVER",
  // Window values dictated by the upstream model.
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
];

const CLAUDE_FLOOR_TOP = [
  "apiKeyHelper",
  "apiBaseUrl",
  "primaryModel",
  "smallFastModel",
  "apiKey",
  "model",
  "fallbackModel",
  "modelOverrides",
  "advisorModel",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
];

function isClaudeFloorEnv(key) {
  return (
    CLAUDE_FLOOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    CLAUDE_PROTOCOL_SELECTORS.includes(key) ||
    CLAUDE_FLOOR_ENV_KEYS.includes(key) ||
    (key.startsWith("CLAUDE_CODE_SKIP_") && key.endsWith("_AUTH"))
  );
}

// Exclusive fields are provider-carried but not floor: users may also set
// them globally. They are projected when a preset carries them and removed
// on switch-away only when the value still matches what the previous
// provider wrote.
function isClaudeProjectedEnv(key) {
  return isClaudeFloorEnv(key) || CLAUDE_EXCLUSIVE_ENV.includes(key);
}

function isClaudeFloorTop(key) {
  return CLAUDE_FLOOR_TOP.includes(key);
}

// Codex config.toml top-level key fields. [model_providers.custom] is owned
// wholesale by the switcher (see CODEX_PROVIDER_TABLE below).
const CODEX_FLOOR_TOP = [
  "model_provider",
  "openai_base_url",
  "model",
  "review_model",
  "model_reasoning_effort",
  "plan_mode_reasoning_effort",
  "disable_response_storage",
  "model_catalog_json",
  "experimental_bearer_token",
  "base_url",
  "wire_api",
];

// The provider table the switcher writes into Codex live config.
const CODEX_PROVIDER_TABLE = "model_providers.custom";

function isCodexFloorTop(key) {
  return CODEX_FLOOR_TOP.includes(key);
}

// Gemini CLI .env key fields. GOOGLE_* is entirely connection/auth related;
// GEMINI_* cannot be prefix-matched (GEMINI_CLI_HOME, GEMINI_SANDBOX,
// telemetry switches etc. are provider-unrelated).
function isGeminiFloorEnv(key) {
  return (
    key.startsWith("GOOGLE_") ||
    [
      "GEMINI_API_KEY",
      "GEMINI_MODEL",
      "GEMINI_API_KEY_AUTH_MECHANISM",
      "GEMINI_CLI_CUSTOM_HEADERS",
      "GEMINI_DEFAULT_AUTH_TYPE",
      "GEMINI_CLI_USE_COMPUTE_ADC",
      "CODE_ASSIST_ENDPOINT",
      "CODE_ASSIST_API_VERSION",
    ].includes(key)
  );
}

module.exports = {
  CLAUDE_PROTOCOL_SELECTORS,
  CLAUDE_FLOOR_ENV_PREFIXES,
  CLAUDE_FLOOR_ENV_KEYS,
  CLAUDE_EXCLUSIVE_ENV,
  CLAUDE_FLOOR_TOP,
  CODEX_FLOOR_TOP,
  CODEX_PROVIDER_TABLE,
  isClaudeFloorEnv,
  isClaudeProjectedEnv,
  isClaudeFloorTop,
  isCodexFloorTop,
  isGeminiFloorEnv,
};
