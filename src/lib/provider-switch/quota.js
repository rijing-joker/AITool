// Provider quota queries — the Node port of cc-switch's coding_plan service
// (793e67d): detect a plan provider from the relay base URL stored on a
// provider row, then query its balance, rolling windows and subscription
// period with THAT row's API key.
//
// Only Command Code is covered, matching cc-switch's injection scope: the
// /alpha control-plane endpoints are undocumented but stable (they back the
// official CLI's /usage overlay) and the shape parsers are shared with
// src/lib/commandcode-limits.js, which reads the same API with the CLI's own
// login. The control plane always lives on the root domain — never reuse the
// provider's /provider data-plane base for /alpha calls.

const {
  COMMANDCODE_API_BASE_URL,
  deriveCommandcodePlanLabel,
  normalizeCommandcodeWindowLimits,
  resolveCommandcodeOrigin,
  fetchCommandcodeJson,
} = require("../commandcode-limits");

const QUOTA_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60_000;

// Base-URL matchers per provider. Command Code: Claude uses /provider, Codex
// /provider/v1 — the shared prefix is what matters (cc-switch's
// codingPlanProviders.ts pattern).
const QUOTA_PROVIDERS = [
  {
    id: "command_code",
    label: "Command Code",
    apps: ["claude", "codex"],
    apiBase: COMMANDCODE_API_BASE_URL,
    pattern: /api\.commandcode\.ai\/provider(?:[\/?#]|$)/i,
  },
];

function detectQuotaProvider(baseUrl, app) {
  const url = String(baseUrl || "");
  if (!url) return null;
  const provider = QUOTA_PROVIDERS.find((entry) => entry.pattern.test(url));
  if (!provider) return null;
  if (app && !provider.apps.includes(app)) return null;
  return provider;
}

// Pull (base URL, API key) out of a stored provider row. Key location differs
// per app: claude keeps the token in env, codex in auth.json's slot or as the
// provider block's experimental_bearer_token (resolveCodexAuth semantics).
function resolveProviderCredential(app, provider) {
  const settings = provider?.settingsConfig;
  if (!settings || typeof settings !== "object") return null;
  if (app === "claude") {
    const env = settings.env ?? {};
    return {
      baseUrl: String(env.ANTHROPIC_BASE_URL ?? "").trim(),
      apiKey: String(env.ANTHROPIC_AUTH_TOKEN ?? "").trim(),
    };
  }
  if (app === "codex") {
    const config = settings.config ?? {};
    const slot = String(config.model_provider ?? "custom").trim();
    const block = config.model_providers?.[slot] ?? {};
    return {
      baseUrl: String(block.base_url ?? "").trim(),
      apiKey: String(
        settings.auth?.OPENAI_API_KEY ?? block.experimental_bearer_token ?? "",
      ).trim(),
    };
  }
  return null;
}

function quotaTimeoutFetch(fetchImpl = fetch) {
  return (url, options) => fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
  });
}

// The subscription body's currentPeriodStart scopes the usage summary to the
// running billing period (cc-switch's query_command_code).
function parseCommandCodeQuota({ creditsBody, subscriptionBody, summaryBody }) {
  const creditRoot = creditsBody?.credits;
  if (!creditRoot || typeof creditRoot !== "object") {
    throw new Error("Missing 'credits' field in response");
  }
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const remaining = {
    monthly: number(creditRoot.monthlyCredits),
    purchased: number(creditRoot.purchasedCredits),
    free: number(creditRoot.freeCredits),
  };
  const totalSpent = Math.max(0, number(summaryBody?.totalCost));
  const totalPool = totalSpent + remaining.monthly + remaining.purchased + remaining.free;

  const subscription = subscriptionBody?.data ?? subscriptionBody ?? null;
  const windows = normalizeCommandcodeWindowLimits(
    creditsBody.windowLimits ?? creditRoot.windowLimits,
  );
  const tiers = [];
  if (windows) {
    if (windows.fiveHour) tiers.push({ id: "five_hour", label: "5h", ...windows.fiveHour });
    if (windows.weekly) tiers.push({ id: "weekly", label: "Weekly", ...windows.weekly });
  }
  tiers.push({
    id: "monthly",
    label: "Monthly",
    used_percent: totalPool > 0 ? Math.min(100, totalSpent / totalPool * 100) : 0,
    reset_at: subscription?.currentPeriodEnd ?? null,
  });

  return {
    plan: deriveCommandcodePlanLabel(
      subscription?.planId ?? creditRoot.planId ?? null,
    ),
    status: typeof subscription?.status === "string" ? subscription.status.trim() : null,
    tiers,
    credits: { ...remaining, spent: totalSpent },
  };
}

async function queryQuotaProvider({ provider: quotaProvider, baseUrl, apiKey, fetchImpl }) {
  const origin = resolveCommandcodeOrigin(baseUrl);
  // Resolve the org off the /alpha control plane, not the data-plane origin.
  const fetcher = async (path, params) => fetchCommandcodeJson({
    url: `${quotaProvider.apiBase}${path}${params?.length ? `?${new URLSearchParams(params)}` : ""}`,
    apiKey,
    fetchImpl: quotaTimeoutFetch(fetchImpl),
    label: path,
  });

  const whoami = await fetcher("/alpha/whoami", [["limits", "1"]]);
  const orgId = whoami?.data?.org?.id ?? whoami?.org?.id ?? null;
  const orgParams = orgId ? [["orgId", String(orgId)]] : [];

  const [creditsBody, subscriptionBody] = await Promise.all([
    fetcher("/alpha/billing/credits", orgParams),
    fetcher("/alpha/billing/subscriptions", orgParams),
  ]);
  const periodStart = subscriptionBody?.data?.currentPeriodStart;
  const summaryParams = [];
  if (typeof periodStart === "string" && periodStart) summaryParams.push(["since", periodStart]);
  if (orgId) summaryParams.push(["orgId", String(orgId)]);
  let summaryBody = null;
  try {
    summaryBody = await fetcher("/alpha/usage/summary", summaryParams);
  } catch {
    // The summary only feeds the monthly tier; a failure there degrades the
    // card instead of failing the whole query.
    summaryBody = null;
  }
  if (summaryBody === null) {
    const windows = normalizeCommandcodeWindowLimits(
      creditsBody?.windowLimits ?? creditsBody?.credits?.windowLimits,
    );
    if (!windows) throw new Error("Missing 'credits' field in response");
    return {
      plan: deriveCommandcodePlanLabel(
        subscriptionBody?.data?.planId ?? creditsBody?.credits?.planId ?? null,
      ),
      status: typeof subscriptionBody?.data?.status === "string" ? subscriptionBody.data.status.trim() : null,
      tiers: [
        ...(windows.fiveHour ? [{ id: "five_hour", label: "5h", ...windows.fiveHour }] : []),
        ...(windows.weekly ? [{ id: "weekly", label: "Weekly", ...windows.weekly }] : []),
      ],
      credits: null,
    };
  }
  return parseCommandCodeQuota({ creditsBody, subscriptionBody, summaryBody });
}

// Small TTL cache so page re-renders and multiple cards don't re-query the
// control plane (cc-switch shares one quota cache between tray and card).
const cache = new Map();

async function queryProviderQuota({ app, provider, fetchImpl, bypassCache = false, now = Date.now() } = {}) {
  const credential = resolveProviderCredential(app, provider);
  if (!credential) return { ok: false, error: "unsupported app for quota queries" };
  const quotaProvider = detectQuotaProvider(credential.baseUrl, app);
  if (!quotaProvider) return { ok: false, error: "no quota provider matches this base URL" };
  if (!credential.apiKey) return { ok: false, error: "provider row has no API key", provider: quotaProvider.id };

  const cacheKey = `${app}/${provider.id}`;
  const cached = bypassCache ? null : cache.get(cacheKey);
  if (cached && now - cached.queriedAt < CACHE_TTL_MS) {
    return { ...cached.quota, cached: true };
  }

  let quota;
  try {
    const parsed = await queryQuotaProvider({
      provider: quotaProvider,
      baseUrl: credential.baseUrl,
      apiKey: credential.apiKey,
      fetchImpl,
    });
    quota = { ok: true, provider: quotaProvider.id, credentialStatus: "valid", ...parsed };
  } catch (error) {
    const expired = error?.code === "AUTH_EXPIRED";
    quota = {
      ok: false,
      provider: quotaProvider.id,
      credentialStatus: expired ? "expired" : "error",
      error: error?.message || String(error),
    };
  }
  if (quota.ok) cache.set(cacheKey, { queriedAt: now, quota });
  return quota;
}

function clearQuotaCache() {
  cache.clear();
}

module.exports = {
  detectQuotaProvider,
  resolveProviderCredential,
  queryProviderQuota,
  clearQuotaCache,
  QUOTA_PROVIDERS,
};
