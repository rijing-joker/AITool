// Codex model catalog (cc-switch's generated model-catalog): config.toml's
// `model_catalog_json` points at a JSON file whose `models` entries populate
// Codex's /model menu — display names, context windows, per-model reasoning
// levels. The base entry template is a port of cc-switch's
// resources/codex_native_responses_template.json (MIT): Codex's catalog
// parser treats `base_instructions` as required, so every entry carries the
// neutral identity default the template ships.

const CODEX_CATALOG_FILENAME = "aitool-model-catalog.json";

// Filenames we are willing to read back on import (ours plus cc-switch's, in
// case the live config was managed by cc-switch before AiTool took over).
const READABLE_CATALOG_FILENAMES = [CODEX_CATALOG_FILENAME, "cc-switch-model-catalog.json"];

const TEMPLATE = {
  slug: "aitool-model-template",
  display_name: "aitool-model-template",
  description: "aitool-model-template",
  base_instructions:
    "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.",
  default_reasoning_level: "high",
  supported_reasoning_levels: [
    { effort: "none", description: "Disable Thinking" },
    { effort: "high", description: "Enabled Thinking" },
  ],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 0,
  supports_reasoning_summaries: true,
  default_reasoning_summary: "none",
  support_verbosity: false,
  truncation_policy: { mode: "bytes", limit: 10000 },
  supports_parallel_tool_calls: false,
  supports_image_detail_original: false,
  context_window: 262144,
  max_context_window: 262144,
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ["text", "image"],
  supports_search_tool: false,
};

// Reasoning levels Codex understands, in ascending depth order (cc-switch's
// CODEX_REASONING_LEVELS). Rows are stored in this canonical order regardless
// of click order.
const CODEX_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const LEVEL_DESCRIPTIONS = {
  none: "Disable Thinking",
  minimal: "Minimal reasoning depth",
  low: "Low reasoning depth",
  medium: "Medium reasoning depth",
  high: "Extra high reasoning depth for complex problems",
  xhigh: "Maximum reasoning depth",
  max: "Maximum reasoning depth",
  ultra: "Maximum reasoning depth",
};

// Provider meta rows → catalog rows with a non-empty model slug.
function catalogRowsOf(provider) {
  const models = provider && provider.meta && provider.meta.codexCatalogModels;
  if (!Array.isArray(models)) return [];
  return models.filter((row) => row && typeof row === "object" && String(row.model || "").trim());
}

function sanitizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  const picked = levels.map((level) => String(level || "").trim()).filter((level) => CODEX_REASONING_LEVELS.includes(level));
  return CODEX_REASONING_LEVELS.filter((level) => picked.includes(level));
}

// Build the catalog file content from provider meta rows. Rows without a
// model slug are skipped; the file is only written when at least one remains.
function buildCodexCatalog(models) {
  const entries = [];
  for (const row of Array.isArray(models) ? models : []) {
    const slug = String((row && row.model) || "").trim();
    if (!slug) continue;
    const entry = JSON.parse(JSON.stringify(TEMPLATE));
    const displayName = String((row && row.displayName) || "").trim() || slug;
    const contextWindow = Number.parseInt((row && row.contextWindow) || "", 10);
    const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : TEMPLATE.context_window;
    entry.slug = slug;
    entry.display_name = displayName;
    entry.description = displayName;
    entry.context_window = window;
    entry.max_context_window = window;
    entry.priority = 1000 + entries.length;
    const levels = sanitizeLevels(row && row.reasoningLevels);
    if (levels.length > 0) {
      entry.supported_reasoning_levels = levels.map((effort) => ({
        effort,
        description: LEVEL_DESCRIPTIONS[effort] || `Reasoning effort: ${effort}`,
      }));
      const fallback = String((row && row.defaultReasoningLevel) || "").trim();
      entry.default_reasoning_level = levels.includes(fallback) ? fallback : levels[levels.length - 1];
    }
    entries.push(entry);
  }
  return `${JSON.stringify({ models: entries }, null, 2)}\n`;
}

// Reverse-parse a catalog file (import-from-live): back into provider meta
// rows. Entries without a slug are dropped; unknown shapes fail soft to [].
function parseCodexCatalog(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const models = parsed && typeof parsed === "object" ? parsed.models : null;
  if (!Array.isArray(models)) return [];
  const rows = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const slug = String(entry.slug || "").trim();
    if (!slug) continue;
    const row = {
      model: slug.slice(0, 200),
      displayName: String(entry.display_name || "").trim().slice(0, 200),
      contextWindow:
        Number.isFinite(entry.context_window) && entry.context_window > 0 ? String(Math.floor(entry.context_window)) : "",
    };
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.map((item) => (item && typeof item === "object" ? item.effort : item))
      : [];
    const clean = sanitizeLevels(levels);
    if (clean.length > 0) {
      row.reasoningLevels = clean;
      const fallback = String(entry.default_reasoning_level || "").trim();
      row.defaultReasoningLevel = clean.includes(fallback) ? fallback : clean[clean.length - 1];
    }
    rows.push(row);
  }
  return rows;
}

module.exports = {
  CODEX_CATALOG_FILENAME,
  READABLE_CATALOG_FILENAMES,
  CODEX_REASONING_LEVELS,
  catalogRowsOf,
  buildCodexCatalog,
  parseCodexCatalog,
};
