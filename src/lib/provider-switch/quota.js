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
// /provider/v1 — the shared path prefix is what matters (cc-switch's
// codingPlanProviders.ts pattern).
//
// Matching is on the parsed hostname, never a substring of the whole URL: a
// detected row gets its own API key sent to the provider's control plane, so
// `https://relay.example/api.commandcode.ai/provider` (marker in the PATH)
// must not be mistaken for Command Code and leak the key to a host the user
// never pointed that row at.
const QUOTA_PROVIDERS = [
  { id: "zhipu", label: "Zhipu GLM", apps: ["claude", "codex", "gemini"], hostname: "open.bigmodel.cn", pathPrefix: "/" },
  { id: "zhipu_en", label: "Z.ai", apps: ["claude", "codex", "gemini"], hostname: "api.z.ai", pathPrefix: "/" },
  { id: "volcengine", label: "Volcengine", apps: ["claude", "codex", "gemini"], hostname: "volces.com", pathPrefix: "/" },
  {
    id: "command_code",
    label: "Command Code",
    apps: ["claude", "codex"],
    apiBase: COMMANDCODE_API_BASE_URL,
    hostname: "api.commandcode.ai",
    pathPrefix: "/provider",
  },
];

// Exact host, or a subdomain of it — `api.commandcode.ai.evil.example` shares
// the prefix but is a different registrable domain, so the dot matters.
function hostMatches(hostname, expected) {
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

function pathMatches(pathname, prefix) {
  return prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function detectQuotaProvider(baseUrl, app) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const provider = QUOTA_PROVIDERS.find((entry) =>
    hostMatches(hostname, entry.hostname) && pathMatches(pathname, entry.pathPrefix));
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
      apiKey: String(env.ANTHROPIC_AUTH_TOKEN ?? "").trim()
        || String(env.ANTHROPIC_API_KEY ?? "").trim(),
    };
  }
  if (app === "codex") {
    const config = settings.config ?? {};
    const slot = String(config.model_provider ?? "custom").trim();
    const block = config.model_providers?.[slot] ?? {};
    return {
      baseUrl: String(block.base_url ?? "").trim(),
      // Same resolution order and empty-string semantics as codexRowKey in
      // targets.js: auth key → route-table bearer → top-level config bearer.
      apiKey: String(
        settings.auth?.OPENAI_API_KEY ||
        block.experimental_bearer_token ||
        config.experimental_bearer_token ||
        "",
      ).trim(),
    };
  }
  if (app === "gemini") {
    const env = settings.env ?? {};
    return {
      baseUrl: String(env.GOOGLE_GEMINI_BASE_URL ?? "").trim(),
      apiKey: String(env.GEMINI_API_KEY ?? "").trim(),
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

// ---------------------------------------------------------------------------
// Balance probing (cc-switch services/balance.rs): DeepSeek, StepFun,
// SiliconFlow (cn + en), OpenRouter and Novita AI expose a small account
// balance endpoint keyed by the same API key the relay uses. Detection is on
// the hostname (upstream substring-matches the whole URL; hostname matching
// keeps the module's marker-in-path rule so a row pointing at
// https://relay.example/api.deepseek.com/... never leaks its key).
// ---------------------------------------------------------------------------

const BALANCE_PROVIDERS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    hostname: "api.deepseek.com",
    url: "https://api.deepseek.com/user/balance",
    unit: "CNY",
  },
  {
    id: "stepfun",
    label: "StepFun",
    hostname: "api.stepfun.ai",
    altHostnames: ["api.stepfun.com"],
    url: "https://api.stepfun.com/v1/accounts",
    unit: "CNY",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    hostname: "api.siliconflow.cn",
    url: "https://api.siliconflow.cn/v1/user/info",
    unit: "CNY",
  },
  {
    id: "siliconflow_en",
    label: "SiliconFlow (EN)",
    hostname: "api.siliconflow.com",
    url: "https://api.siliconflow.com/v1/user/info",
    unit: "USD",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    hostname: "openrouter.ai",
    url: "https://openrouter.ai/api/v1/credits",
    unit: "USD",
  },
  {
    id: "novita",
    label: "Novita AI",
    hostname: "api.novita.ai",
    url: "https://api.novita.ai/v3/user/balance",
    unit: "USD",
  },
];

// JSON number or numeric string (upstream parse_f64_field).
function balanceNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function hostContains(hostname, expected) {
  // Exact host or a subdomain of it — `api.deepseek.com.evil.example` shares
  // the prefix but is a different registrable domain, so the dot matters
  // (same rule as the coding-plan hostMatches).
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

function detectBalanceProvider(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  return BALANCE_PROVIDERS.find((entry) =>
    hostContains(hostname, entry.hostname) ||
    (entry.altHostnames || []).some((alt) => hostContains(hostname, alt))) || null;
}

// Parse a vendor-specific body into the unified balance line. Returns null
// when the shape is unrecognizable (deterministic failure).
function parseBalanceBody(entry, body) {
  if (entry.id === "deepseek") {
    const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
    const lines = infos.map((info) => ({
      label: entry.label,
      remaining: balanceNumber(info?.total_balance) ?? 0,
      total: null,
      used: null,
      unit: String(info?.currency ?? entry.unit),
      isValid: body?.is_available !== false,
      invalidMessage: body?.is_available === false ? "Account unavailable" : null,
    }));
    return lines.length > 0 ? lines : null;
  }
  if (entry.id === "stepfun") {
    const remaining = balanceNumber(body?.balance);
    if (remaining === null) return null;
    return [{ label: entry.label, remaining, total: null, used: null, unit: entry.unit, isValid: true, invalidMessage: null }];
  }
  if (entry.id === "siliconflow" || entry.id === "siliconflow_en") {
    const data = body?.data && typeof body.data === "object" ? body.data : null;
    if (!data) return null;
    const remaining = balanceNumber(data.totalBalance);
    if (remaining === null) return null;
    return [{ label: entry.label, remaining, total: null, used: null, unit: entry.unit, isValid: true, invalidMessage: null }];
  }
  if (entry.id === "openrouter") {
    const data = body?.data && typeof body.data === "object" ? body.data : body;
    const total = balanceNumber(data?.total_credits);
    const used = balanceNumber(data?.total_usage);
    if (total === null || used === null) return null;
    const remaining = total - used;
    if (!Number.isFinite(remaining)) return null;
    return [{
      label: entry.label,
      remaining,
      total,
      used,
      unit: entry.unit,
      // Account credit is independent of key validity; free models can still
      // work with a zero balance (cc-switch 96d636ca).
      isValid: true,
      invalidMessage: null,
    }];
  }
  if (entry.id === "novita") {
    const available = balanceNumber(body?.availableBalance);
    if (available === null) return null;
    // Novita reports in 0.0001 USD units.
    const remaining = available / 10000;
    return [{
      label: entry.label,
      remaining,
      total: null,
      used: null,
      unit: entry.unit,
      isValid: remaining > 0,
      invalidMessage: remaining <= 0 ? "No balance remaining" : null,
    }];
  }
  return null;
}

async function queryBalanceProvider({ entry, apiKey, fetchImpl }) {
  const fetcher = quotaTimeoutFetch(fetchImpl);
  let response;
  try {
    response = await fetcher(entry.url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
  } catch (error) {
    // Transient transport failure — surface the message, no deterministic state.
    throw new Error(`Network error: ${error?.message || String(error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error(`Authentication failed (HTTP ${response.status})`);
    error.code = "AUTH_EXPIRED";
    throw error;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`API error (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`Failed to parse response: ${error?.message || String(error)}`);
  }
  const balances = parseBalanceBody(entry, body);
  if (!balances) throw new Error("Unrecognized balance response shape");
  return balances;
}

// Balance query with the same cache/error semantics as queryProviderQuota:
// deterministic failures come back as ok:false with credentialStatus, and
// successful answers are cached for the page's polling cadence.
async function queryProviderBalance({ app, provider, fetchImpl, bypassCache = false, now = Date.now() } = {}) {
  const credential = resolveProviderCredential(app, provider);
  if (!credential) return { ok: false, error: "unsupported app for balance queries" };
  const entry = detectBalanceProvider(credential.baseUrl);
  if (!entry) return { ok: false, error: "no balance provider matches this base URL" };
  if (!credential.apiKey) return { ok: false, error: "provider row has no API key", provider: entry.id };

  const cacheKey = `balance/${app}/${provider.id}`;
  const cached = bypassCache ? null : cache.get(cacheKey);
  if (cached && now - cached.queriedAt < CACHE_TTL_MS) {
    return { ...cached.quota, cached: true };
  }

  let quota;
  try {
    const balances = await queryBalanceProvider({ entry, apiKey: credential.apiKey, fetchImpl });
    quota = { ok: true, kind: "balance", provider: entry.id, credentialStatus: "valid", balances };
  } catch (error) {
    const expired = error?.code === "AUTH_EXPIRED";
    quota = {
      ok: false,
      kind: "balance",
      provider: entry.id,
      credentialStatus: expired ? "expired" : "error",
      error: error?.message || String(error),
    };
  }
  if (quota.ok) cache.set(cacheKey, { queriedAt: now, quota });
  return quota;
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

async function queryQuotaProvider({ provider: quotaProvider, baseUrl, apiKey, fetchImpl, row }) {
  // Validate the row's base URL (https / loopback-only) even though the
  // /alpha calls below go to the fixed control-plane host.
  resolveCommandcodeOrigin(baseUrl);
  if (quotaProvider.id === "volcengine") return require("./plan-quota").volc({ baseUrl, provider: row, fetchImpl });
  if (["zhipu", "zhipu_en"].includes(quotaProvider.id)) return require("./plan-quota").zhipu({ baseUrl, apiKey, fetchImpl });
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
      row: provider,
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
  queryProviderBalance,
  detectBalanceProvider,
  parseBalanceBody,
  clearQuotaCache,
  QUOTA_PROVIDERS,
  BALANCE_PROVIDERS,
};
