const VERIFIED_FREE_IDS = Object.freeze([
  "big-pickle", "beam-free", "cat-jam-free", "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free", "ll-alpha-free", "longcat-2.5-preview-free",
  "mimo-v2.6-flash-free", "muse-spark-1.3-contributor-free",
  "nemotron-3.5-lightning-free", "nemotron-3.5-super-vl-free", "space-bunny-free",
]);
// Community adapter measured accepted usage at this floor (Zen Free 0.1.18).
const CONTEXT_FLOOR = { "deepseek-v4.1-flash-free": 258624 };
const POLICY_URL = "https://opencode.ai/docs/zen/";
const TTL_MS = 60 * 60 * 1000;

function selectModels(live, metadata) {
  const provider = metadata?.opencode;
  const available = new Set((live?.data || []).map((m) => m.id));
  return Object.values(provider?.models || {}).filter((m) => {
    const npm = m.provider?.npm || provider.npm;
    return VERIFIED_FREE_IDS.includes(m.id) && available.has(m.id) && m.status !== "deprecated"
      && m.cost?.input === 0 && m.cost?.output === 0
      && Object.entries(m.cost).every(([key, value]) => !["cache_read", "cache_write"].includes(key) || value === 0)
      && !m.cost.tiers?.length && !m.cost.context_over_200k
      && ["@ai-sdk/openai-compatible", "@ai-sdk/openai"].includes(npm)
      && m.modalities?.output?.includes("text") && m.tool_call === true;
  }).map((m) => ({
    id: m.id, name: m.name || m.id,
    contextWindow: Math.max(Number(m.limit?.context) || 0, CONTEXT_FLOOR[m.id] || 0) || null,
    maxOutputTokens: Number(m.limit?.output) > 0 ? m.limit.output : null,
    contextSource: CONTEXT_FLOOR[m.id] && Number(m.limit?.context) < CONTEXT_FLOOR[m.id] ? "reviewed-zen-floor" : "models.dev",
    protocol: (m.provider?.npm || provider.npm) === "@ai-sdk/openai" ? "responses" : "chat",
    policy: m.id.startsWith("muse-") ? "training" : m.id.startsWith("mimo-") ? "improvement"
      : /^(deepseek-|glm-)/.test(m.id) ? "no_training" : "review",
    policyUrl: POLICY_URL,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function createCatalog({ fetchImpl = fetch, now = Date.now } = {}) {
  let models = [], updatedAt = null, lastError = null, pending = null, attemptedAt = null;
  async function refresh(force = false) {
    if (pending) return pending;
    if (!force && attemptedAt !== null && now() - attemptedAt < (lastError ? 60_000 : TTL_MS)) return snapshot();
    attemptedAt = now();
    pending = (async () => {
      try {
        const data = await Promise.all([
          "https://opencode.ai/inference/v1/models", "https://models.dev/api.json",
        ].map(async (url) => {
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
          if (!res.ok) throw new Error(`catalog_http_${res.status}`);
          return res.json();
        }));
        if (!Array.isArray(data[0]?.data) || !data[1]?.opencode?.models) throw new Error("catalog_invalid");
        models = selectModels(...data);
        updatedAt = new Date(now()).toISOString();
        lastError = null;
      } catch {
        // Never authorize inference from stale data after a failed refresh.
        lastError = "catalog_unavailable";
      }
      return snapshot();
    })();
    try { return await pending; } finally { pending = null; }
  }
  function snapshot() { return { models, updatedAt, lastError }; }
  async function resolve(id) {
    await refresh();
    return !lastError && models.find((m) => m.id === id);
  }
  return { refresh, snapshot, resolve };
}
module.exports = { createCatalog, selectModels, VERIFIED_FREE_IDS, POLICY_URL };
