// models.dev pricing sync + per-request cost estimation (cc-switch port,
// minimal): src/lib/modelsDev.ts / src/lib/modelsDevPricing.ts for the fetch,
// flattening and id normalization, proxy/usage/calculator.rs for the formula.
//
// https://models.dev/api.json maps provider ids to their models with per-
// million USD costs. Text models with a cost are kept under a normalized id
// (vendor prefix / `:variant` suffix / `[1m]` markers stripped) so the same
// model under different provider spellings resolves to one entry; the newest
// release wins on collision.
//
// Token semantics mirror the CLIProxyAPI core executors: Claude/Anthropic
// reports fresh input tokens with independent cache fields, while OpenAI and
// Gemini report input already including cache reads (and creation) — those are
// subtracted before billing. Callers who know the semantics (session readers)
// pass inputInclusive explicitly; otherwise it is inferred from the model id.

const fsp = require("node:fs/promises");
const path = require("node:path");

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const PRICING_FETCH_TIMEOUT_MS = 15_000;
const STORE_VERSION = 1;

const NON_TEXT_MODEL_MARKERS = [
  "audio",
  "deprecated",
  "embedding",
  "image",
  "moderation",
  "realtime",
  "transcribe",
  "tts",
  "video",
];
const NON_TEXT_OUTPUT_MODALITIES = new Set(["audio", "image", "video"]);

/** Upstream formatPrice guardrail: absurd or non-finite prices mean free. */
function clampPrice(value) {
  if (!Number.isFinite(value) || value < 0 || value >= 1e12) return 0;
  return value;
}

/** Strip vendor/ prefix, :variant suffix, [1m] markers; `@` → `-`; lowercase. */
function normalizeModelId(modelId) {
  const raw = String(modelId ?? "");
  const afterSlash = raw.slice(raw.lastIndexOf("/") + 1);
  const beforeColon = afterSlash.split(":")[0] ?? "";
  let normalized = beforeColon.trim().replace(/@/g, "-").toLowerCase();
  if (normalized.endsWith("[1m]")) {
    normalized = normalized.slice(0, -4).trim();
  }
  return normalized;
}

function isTextPricingModel(modelId, model) {
  if (String(model?.status ?? "").toLowerCase() === "deprecated") return false;
  const outputModalities = Array.isArray(model?.modalities?.output)
    ? model.modalities.output.filter((modality) => typeof modality === "string").map((modality) => modality.toLowerCase())
    : null;
  if (outputModalities?.length && (!outputModalities.includes("text") || outputModalities.some((modality) => NON_TEXT_OUTPUT_MODALITIES.has(modality)))) {
    return false;
  }
  const searchableName = `${modelId} ${model?.name ?? ""}`.toLowerCase();
  return !NON_TEXT_MODEL_MARKERS.some((marker) => searchableName.includes(marker));
}

/** Flatten the models.dev payload into one entry per normalized model id. */
function flattenModelsDev(data) {
  const entries = [];
  if (data == null || typeof data !== "object") return entries;
  for (const [providerId, provider] of Object.entries(data)) {
    if (provider == null || typeof provider !== "object") continue;
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (model == null || typeof model !== "object") continue;
      if (!isTextPricingModel(modelId, model)) continue;
      const cost = model.cost;
      let input = typeof cost?.input === "number" ? cost.input : null;
      let output = typeof cost?.output === "number" ? cost.output : null;
      if (input === null && output === null) continue;
      // Upstream formatPrice clamps absurd entries to zero (free).
      input = clampPrice(input ?? 0);
      output = clampPrice(output ?? 0);
      const normalizedId = normalizeModelId(modelId);
      if (!normalizedId) continue;
      entries.push({
        normalizedId,
        providerId,
        modelId,
        modelName: String(model.name ?? modelId),
        releaseDate: typeof model.release_date === "string" ? model.release_date : "",
        input,
        output,
        cacheRead: clampPrice(typeof cost?.cache_read === "number" ? cost.cache_read : 0),
        cacheWrite: clampPrice(typeof cost?.cache_write === "number" ? cost.cache_write : 0),
      });
    }
  }
  entries.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.modelName.localeCompare(b.modelName));
  const models = new Map();
  for (const entry of entries) {
    if (!models.has(entry.normalizedId)) {
      models.set(entry.normalizedId, {
        name: entry.modelName,
        provider: entry.providerId,
        input: entry.input,
        output: entry.output,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
      });
    }
  }
  return models;
}

async function fetchModelsDevIndex({ fetchImpl = globalThis.fetch, timeoutMs = PRICING_FETCH_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(MODELS_DEV_API_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return flattenModelsDev(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Store: usage/models-dev-pricing.json, written atomically, kept in a process
// memo so records reads do not re-parse the file per request.
// ---------------------------------------------------------------------------

const storeMemo = new Map();
const inflightSyncs = new Map();
const syncFailureMemo = new Map();
// Bound the retry cadence on offline machines: the dashboard polls records
// every 10s and each poll would otherwise re-kick a models.dev fetch.
const SYNC_RETRY_DELAY_MS = 5 * 60 * 1000;

function memoKey(pricingPath) {
  return path.resolve(pricingPath);
}

async function loadPricingStore(pricingPath) {
  const key = memoKey(pricingPath);
  const memo = storeMemo.get(key);
  if (memo) return memo;
  let store = null;
  try {
    const parsed = JSON.parse(await fsp.readFile(pricingPath, "utf8"));
    if (parsed?.version === STORE_VERSION && parsed.models && typeof parsed.models === "object") {
      store = { fetchedAt: Number(parsed.fetchedAt) || 0, models: parsed.models };
    }
  } catch {
    store = null;
  }
  if (store) storeMemo.set(key, store);
  return store;
}

async function savePricingStore(pricingPath, models, fetchedAt) {
  const store = { version: STORE_VERSION, fetchedAt, models };
  await fsp.mkdir(path.dirname(pricingPath), { recursive: true });
  const tmpPath = `${pricingPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(store));
    await fsp.rename(tmpPath, pricingPath);
  } catch (error) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw error;
  }
  storeMemo.set(memoKey(pricingPath), store);
  return store;
}

/** Fetch models.dev and persist. Concurrent calls share one fetch. */
async function syncPricingStore(pricingPath, { fetchImpl } = {}) {
  const key = memoKey(pricingPath);
  const existing = inflightSyncs.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const models = await fetchModelsDevIndex({ fetchImpl });
      if (models.size === 0) throw new Error("models.dev payload contained no priced text models");
      syncFailureMemo.delete(key);
      return await savePricingStore(pricingPath, Object.fromEntries(models), Date.now());
    } catch (error) {
      syncFailureMemo.set(key, Date.now());
      throw error;
    } finally {
      inflightSyncs.delete(key);
    }
  })();
  inflightSyncs.set(key, promise);
  return promise;
}

/**
 * Load the pricing index for read paths; when the store is missing or older
 * than the TTL a background re-sync is kicked off (errors swallowed so read
 * paths degrade to the stale index). Returns models:null while nothing is on
 * disk yet.
 */
async function getPricingSnapshot(pricingPath, { fetchImpl, now = Date.now, ttlMs = PRICING_TTL_MS } = {}) {
  const store = await loadPricingStore(pricingPath);
  const age = store ? now() - store.fetchedAt : Number.POSITIVE_INFINITY;
  if (!store || age > ttlMs) {
    const key = memoKey(pricingPath);
    const lastFailedAt = syncFailureMemo.get(key) ?? 0;
    if (!inflightSyncs.has(key) && now() - lastFailedAt > SYNC_RETRY_DELAY_MS) {
      syncPricingStore(pricingPath, { fetchImpl }).catch(() => {});
    }
    return {
      models: store?.models ?? null,
      modelCount: store ? Object.keys(store.models).length : 0,
      fetchedAt: store?.fetchedAt ?? null,
      stale: true,
      syncing: inflightSyncs.has(key),
    };
  }
  return {
    models: store.models,
    modelCount: Object.keys(store.models).length,
    fetchedAt: store.fetchedAt,
    stale: false,
    syncing: false,
  };
}

async function refreshPricingSnapshot(pricingPath, { fetchImpl } = {}) {
  const store = await syncPricingStore(pricingPath, { fetchImpl });
  return {
    models: store.models,
    modelCount: Object.keys(store.models).length,
    fetchedAt: store.fetchedAt,
    stale: false,
    syncing: false,
  };
}

// ---------------------------------------------------------------------------
// Token semantics (mirror the CLIProxyAPI core executors)
// ---------------------------------------------------------------------------

function tokenNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * Whether a row's input tokens already include the cache reads/creation.
 * Upstream executor semantics: Claude/Anthropic reports fresh input with
 * independent cache fields; OpenAI and Gemini include the cached amounts in
 * input. Records carry the core's Go executor type name (e.g. "ClaudeExecutor")
 * which is the authoritative signal; the model id is the fallback heuristic.
 */
function isInputInclusive(executorType, model) {
  if (executorType && typeof executorType === "string") {
    return !/claude|anthropic/i.test(executorType);
  }
  return !/^claude/i.test(String(model ?? ""));
}

/**
 * Whether a row's reasoning tokens are reported separately from output.
 * Gemini-family upstreams report thoughts independently (they must be billed
 * at output price on top); Claude and OpenAI include reasoning in output.
 */
function isReasoningSeparate(executorType, model) {
  if (executorType && typeof executorType === "string") {
    return /gemini|aistudio|antigravity/i.test(executorType);
  }
  return /^gemini/i.test(String(model ?? ""));
}

/**
 * Cache-read tokens for a normalized row. Core rows alias cache reads into
 * `cachedTokens` for the inclusive (OpenAI/Gemini) families, so fall back to
 * it only there — on a Claude row `cachedTokens` can carry cache *creation*
 * instead, and billing it at the read rate would be wrong.
 *
 * Both the queue fold and the cost estimate must resolve this the same way:
 * the fold subtracts this amount from input and files it under
 * `cached_input_tokens`, and `computeRowCost` on the Tokens page then bills
 * the same split the Requests tab shows.
 */
function cacheReadTokensFor(tokens, { executorType, model, inputInclusive } = {}) {
  const inclusive = typeof inputInclusive === "boolean" ? inputInclusive : isInputInclusive(executorType, model);
  return tokenNumber(tokens?.cacheReadTokens) || (inclusive ? tokenNumber(tokens?.cachedTokens) : 0);
}

/** Fresh (billable) input for a normalized token row. */
function freshInputTokens(tokens, { executorType, model, inputInclusive } = {}) {
  const inclusive = typeof inputInclusive === "boolean" ? inputInclusive : isInputInclusive(executorType, model);
  const input = tokenNumber(tokens?.inputTokens);
  if (!inclusive) return input;
  const cacheRead = cacheReadTokensFor(tokens, { executorType, model, inputInclusive: inclusive });
  return Math.max(0, input - cacheRead - tokenNumber(tokens?.cacheCreationTokens));
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * Lookup candidates for a model id: the normalized id, then date-suffixed
 * snapshot ids (claude-sonnet-4-5-20250929, gpt-4o-2024-08-06) reduced to
 * their base id, then claude dot ids mapped to the dash ids models.dev uses.
 */
function pricingLookupCandidates(model) {
  const normalized = normalizeModelId(model);
  if (!normalized) return [];
  const candidates = [normalized];
  const withoutDate = normalized.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (withoutDate && !candidates.includes(withoutDate)) candidates.push(withoutDate);
  if (/^claude/.test(withoutDate)) {
    const dashed = withoutDate.replace(/(\d)\.(\d)/g, "$1-$2");
    if (dashed !== withoutDate && !candidates.includes(dashed)) candidates.push(dashed);
  }
  return candidates;
}

function findPricing(models, model) {
  if (!models || typeof models !== "object") return null;
  for (const candidate of pricingLookupCandidates(model)) {
    const pricing = models[candidate];
    if (pricing) return pricing;
  }
  return null;
}

/**
 * Estimated USD cost for one request, or null when the model is unpriced or
 * the row carries no billable tokens. `tokens` uses the normalized camelCase
 * token fields; `inputInclusive` marks rows whose input already contains the
 * cache reads/creation, `executorType` carries the core executor name — the
 * explicit flag wins, then the executor, then the model-id heuristic.
 */
function estimateCostUsd(models, model, tokens, { inputInclusive, executorType } = {}) {
  const pricing = findPricing(models, model);
  if (!pricing) return null;
  const inclusive = typeof inputInclusive === "boolean" ? inputInclusive : isInputInclusive(executorType, model);
  const inputTokens = tokenNumber(tokens?.inputTokens);
  const outputTokens = tokenNumber(tokens?.outputTokens);
  const reasoningTokens = tokenNumber(tokens?.reasoningTokens);
  // Core rows alias cache reads into cachedTokens for the inclusive families;
  // resolved by cacheReadTokensFor so the queue fold bills the same split.
  const cacheReadTokens = cacheReadTokensFor(tokens, { executorType, model, inputInclusive: inclusive });
  const cacheCreationTokens = tokenNumber(tokens?.cacheCreationTokens);
  if (inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheCreationTokens === 0) return null;
  const billableInput = inclusive
    ? Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens)
    : inputTokens;
  const billableReasoning = isReasoningSeparate(executorType, model) ? reasoningTokens : 0;
  const cost = (billableInput * pricing.input
    + (outputTokens + billableReasoning) * pricing.output
    + cacheReadTokens * pricing.cacheRead
    + cacheCreationTokens * pricing.cacheWrite) / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}

module.exports = {
  MODELS_DEV_API_URL,
  PRICING_TTL_MS,
  SYNC_RETRY_DELAY_MS,
  normalizeModelId,
  flattenModelsDev,
  fetchModelsDevIndex,
  loadPricingStore,
  syncPricingStore,
  getPricingSnapshot,
  refreshPricingSnapshot,
  isInputInclusive,
  isReasoningSeparate,
  cacheReadTokensFor,
  freshInputTokens,
  pricingLookupCandidates,
  findPricing,
  estimateCostUsd,
  // exposed for tests
  __test: {
    clearMemo() {
      storeMemo.clear();
      inflightSyncs.clear();
      syncFailureMemo.clear();
    },
  },
};
