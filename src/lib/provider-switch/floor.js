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
const CODEX_FLOOR_AGENTS = ["default_subagent_model", "default_subagent_reasoning_effort"];

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

// Legacy Codex row shapes that predate the managed [model_providers.custom]
// table (cc-switch live/project/codex.rs third_party_route): a top-level
// address key with no selector, the built-in "openai" selector, or a reserved
// id table. Codex ignores a top-level base_url/openai_base_url, so switching
// such a row as-is strands the CLI on the built-in OpenAI route and the
// editor shows no request address (cc-switch 84457b510, #8039). Normalized
// rows fold the address into model_providers.custom and select it. Idempotent
// and pure: applied at the store boundary on every read/write.
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeCodexConfig(config) {
  if (!isPlainObject(config)) return config;
  const providers = isPlainObject(config.model_providers) ? config.model_providers : null;
  const selector = typeof config.model_provider === "string" ? config.model_provider.trim() : "";

  // A reserved built-in id carrying its own row table: Codex refuses to load
  // the file wholesale, so the table is rewritten as custom (wire_api forced
  // to responses, matching upstream).
  if (selector === "openai" && providers && isPlainObject(providers.openai)) {
    const next = { ...config, model_provider: "custom" };
    const table = { ...providers.openai, wire_api: "responses" };
    next.model_providers = { ...providers, custom: table };
    delete next.model_providers.openai;
    return next;
  }

  // A real selector wins: the legacy top-level address keys are ignored by
  // Codex either way and stay untouched (upstream: built_in_route(id)).
  if (selector && selector !== "openai") return config;

  // openai_base_url is the older legacy shape and wins over base_url; with
  // the "openai" selector only openai_base_url redirects (upstream keeps
  // base_url for the selector-less shape only).
  const legacyUrl = selector === "openai"
    ? nonEmptyString(config.openai_base_url)
    : nonEmptyString(config.openai_base_url) || nonEmptyString(config.base_url);
  if (!legacyUrl) return config;

  const existing = providers && isPlainObject(providers.custom) ? providers.custom : {};
  const table = { ...existing };
  if (!nonEmptyString(table.name)) table.name = "Custom";
  table.base_url = legacyUrl;
  // The row's own wire_api reflects what protocol the relay speaks; keep it
  // when present (upstream's save path carries it), default responses.
  if (!nonEmptyString(table.wire_api)) {
    table.wire_api = nonEmptyString(config.wire_api) || "responses";
  }
  const next = { ...config, model_provider: "custom" };
  next.model_providers = { ...(providers || {}), custom: table };
  delete next.openai_base_url;
  delete next.base_url;
  delete next.wire_api;
  return next;
}

module.exports = {
  CLAUDE_PROTOCOL_SELECTORS,
  CLAUDE_FLOOR_ENV_PREFIXES,
  CLAUDE_FLOOR_ENV_KEYS,
  CLAUDE_EXCLUSIVE_ENV,
  CLAUDE_FLOOR_TOP,
  CODEX_FLOOR_TOP,
  CODEX_FLOOR_AGENTS,
  CODEX_PROVIDER_TABLE,
  isClaudeFloorEnv,
  isClaudeProjectedEnv,
  isClaudeFloorTop,
  isCodexFloorTop,
  isGeminiFloorEnv,
  normalizeCodexConfig,
};
