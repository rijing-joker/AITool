// Codex model catalog (cc-switch's generated model-catalog): config.toml's
// `model_catalog_json` points at a JSON file whose `models` entries populate
// Codex's /model menu — display names, context windows, per-model reasoning
// levels. The base entry template is a port of cc-switch's
// resources/codex_native_responses_template.json (MIT): Codex's catalog
// parser treats `base_instructions` as required, so every entry carries the
// neutral identity default the template ships.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

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

// --- official GPT entry mirroring (cc-switch c6255cc) ------------------------
// Once model_catalog_json is set Codex only knows the models in that file, so
// a relay's GPT row built from the neutral template would lose the model's own
// harness prompt, freeform apply_patch and reasoning levels. Rows that hit
// Codex's bundled official list mirror that entry verbatim instead; row
// overrides do not apply. The list comes from the local Codex CLI
// (`codex debug models --bundled`) with a vendored gpt-5.5 entry
// (resources/gpt5_5-template.json, MIT, from cc-switch) as offline fallback.

const CODEX_PARSER_REQUIRED_FIELDS = ["supports_reasoning_summaries", "supports_parallel_tool_calls"];

const CODEX_CLI_CANDIDATES = [
  "codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  "/home/linuxbrew/.linuxbrew/bin/codex",
];

let officialModelsCache = null;
let officialModelsOverride = null;

// The vendored fallback: the real gpt-5.5 entry with its harness prompt.
function staticOfficialModel() {
  try {
    const row = JSON.parse(
      fs.readFileSync(path.join(__dirname, "resources", "gpt5_5-template.json"), "utf8"),
    );
    if (!row || typeof row !== "object") return null;
    if (!String(row.slug || "").trim() || typeof row.base_instructions !== "string") return null;
    return row;
  } catch {
    return null;
  }
}

// Codex's catalog parser rejects rows missing required fields; older builds'
// bundled lists can lack the flags and rows can rely on the prompt template.
function normalizeOfficialRows(rows) {
  const base = staticOfficialModel();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    if (!String(row.slug || "").trim()) continue;
    const entry = { ...row };
    for (const field of CODEX_PARSER_REQUIRED_FIELDS) {
      if (!(field in entry) && base && field in base) entry[field] = base[field];
    }
    if (typeof entry.base_instructions !== "string") {
      const template = entry.model_messages && typeof entry.model_messages === "object"
        ? entry.model_messages.instructions_template
        : undefined;
      if (typeof template === "string") entry.base_instructions = template;
    }
    if (typeof entry.base_instructions !== "string") continue;
    out.push(entry);
  }
  return out;
}

function bundledOfficialModels() {
  for (const candidate of CODEX_CLI_CANDIDATES) {
    let stdout;
    try {
      stdout = execFileSync(candidate, ["debug", "models", "--bundled"], {
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    let catalog = null;
    try {
      catalog = JSON.parse(stdout.toString("utf8"));
    } catch {
      continue;
    }
    const models = catalog && typeof catalog === "object" ? catalog.models : null;
    if (!Array.isArray(models) || models.length === 0) continue;
    const rows = normalizeOfficialRows(models);
    if (rows.length > 0) return rows;
  }
  return null;
}

// Resolved once per process (the CLI probe blocks; Codex upgrades then need a
// serve restart, same trade-off as cc-switch's OnceCell).
function codexOpenaiOfficialModels() {
  if (officialModelsOverride !== null) return officialModelsOverride;
  if (!officialModelsCache) {
    const rows = bundledOfficialModels();
    const fallback = staticOfficialModel();
    officialModelsCache = { value: rows || (fallback ? [fallback] : []) };
  }
  return officialModelsCache.value;
}

// Tests: pass [] to disable mirroring deterministically, or fixture rows.
function setCodexOfficialModelsForTests(rows) {
  officialModelsOverride = Array.isArray(rows) ? rows : null;
}

// Codex's own lookup rule (codex-rs models-manager): longest case-sensitive
// slug prefix, else strip ONE simple namespace segment ("openai/gpt-5.5").
function findCodexOfficialModel(model, candidates) {
  const longestPrefix = (text) => {
    let best = null;
    let bestLength = -1;
    for (const candidate of candidates) {
      const slug = candidate && typeof candidate === "object" ? candidate.slug : undefined;
      if (typeof slug !== "string" || !slug.length) continue;
      if (text.startsWith(slug) && slug.length > bestLength) {
        best = candidate;
        bestLength = slug.length;
      }
    }
    return best;
  };
  const hit = longestPrefix(model);
  if (hit) return hit;
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const namespace = model.slice(0, slash);
  const suffix = model.slice(slash + 1);
  if (suffix.includes("/") || !/^[A-Za-z0-9_-]+$/.test(namespace)) return null;
  return longestPrefix(suffix);
}

// The mirrored row: official values win over row overrides; only fields owned
// by the official account or backend are reset. (Direct-write is
// native-responses only, so there is no ProxyChat image-detail tweak.)
function codexOfficialModelEntry(official, model, priority) {
  const entry = JSON.parse(JSON.stringify(official && typeof official === "object" ? official : {}));
  if (!entry || typeof entry !== "object") return {};
  // A prefixed/namespace hit ("gpt-5.5-high") must not steal the official
  // display name.
  if (entry.slug !== model) entry.display_name = model;
  entry.slug = model;
  entry.priority = 1000 + priority;
  entry.visibility = "list";
  entry.service_tiers = [];
  entry.additional_speed_tiers = [];
  entry.availability_nux = null;
  entry.upgrade = null;
  entry.use_responses_lite = false;
  return entry;
}

// A catalog row is a pure mirror when everything import keeps (display name,
// window, modalities, parallel tool calls) matches a fresh mirror; such rows
// collapse to their bare model name on import instead of storing the official
// blob as if the user had typed it.
function isCodexOfficialMirror(entry, model, official) {
  const expected = codexOfficialModelEntry(official, model, 0);
  // Deep comparison: input_modalities is an array (Rust's Value == is deep).
  return ["display_name", "context_window", "input_modalities", "supports_parallel_tool_calls"]
    .every((key) => JSON.stringify(entry[key]) === JSON.stringify(expected[key]));
}

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
// Rows hitting the official list mirror that entry (their own overrides do
// not apply); the rest come from the neutral template.
function buildCodexCatalog(models, officialModels) {
  const official = officialModels !== undefined ? officialModels || [] : codexOpenaiOfficialModels();
  const entries = [];
  for (const row of Array.isArray(models) ? models : []) {
    const slug = String((row && row.model) || "").trim();
    if (!slug) continue;
    const found = findCodexOfficialModel(slug, official);
    if (found) {
      entries.push(codexOfficialModelEntry(found, slug, entries.length));
      continue;
    }
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
    // Per-model system prompt (EasyCLIProxyAPI 2b49fe6): written to
    // base_instructions and mirrored into model_messages.instructions_template
    // (Codex clients may prefer the template). Template rows only — official
    // mirrors stay pure by design.
    const baseInstructions = String((row && row.baseInstructions) || "").trim();
    if (baseInstructions) {
      entry.base_instructions = baseInstructions;
      entry.model_messages = { ...(entry.model_messages || {}), instructions_template: baseInstructions };
    }
  }
  return `${JSON.stringify({ models: entries }, null, 2)}\n`;
}

// Reverse-parse a catalog file (import-from-live): back into provider meta
// rows. Entries without a slug are dropped; unknown shapes fail soft to [].
// Rows that are pure official mirrors collapse to their bare model name so
// the official blob is not stored as user input.
function parseCodexCatalog(text, officialModels) {
  if (typeof text !== "string" || !text.trim()) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const models = parsed && typeof parsed === "object" ? parsed.models : null;
  if (!Array.isArray(models)) return [];
  const official = officialModels !== undefined ? officialModels || [] : codexOpenaiOfficialModels();
  const rows = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const slug = String(entry.slug || "").trim();
    if (!slug) continue;
    const hasOwnPrompt = entry.model_messages
      && typeof entry.model_messages === "object"
      && typeof entry.model_messages.instructions_template === "string";
    if (official.length > 0 && hasOwnPrompt) {
      const found = findCodexOfficialModel(slug, official);
      if (found && isCodexOfficialMirror(entry, slug, found)) {
        rows.push({ model: slug.slice(0, 200) });
        continue;
      }
    }
    const row = {
      model: slug.slice(0, 200),
      displayName: String(entry.display_name || "").trim().slice(0, 200),
      contextWindow:
        Number.isFinite(entry.context_window) && entry.context_window > 0 ? String(Math.floor(entry.context_window)) : "",
    };
    const instructions =
      typeof entry.base_instructions === "string" && entry.base_instructions.trim()
        ? entry.base_instructions
        : entry.model_messages && typeof entry.model_messages === "object"
          ? entry.model_messages.instructions_template
          : undefined;
    if (typeof instructions === "string" && instructions.trim()) {
      row.baseInstructions = instructions;
    }
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
  findCodexOfficialModel,
  codexOpenaiOfficialModels,
  setCodexOfficialModelsForTests,
};
