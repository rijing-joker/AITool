// Best-effort balance lookup for OpenAI-compatible relay stations. The
// one-api/new-api family exposes the legacy OpenAI billing endpoints
// (/dashboard/billing/subscription + /usage); official OpenAI and the other
// provider types do not, so callers treat failure as "no balance shown".

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

function billingRoots(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return [];
  const roots = trimmed.match(/\/v1$/i) ? [trimmed.slice(0, -3), trimmed] : [trimmed, `${trimmed}/v1`];
  return Array.from(new Set(roots));
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchJson(url, apiKey, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = body && typeof body === "object" && typeof body.message === "string" ? body.message : "";
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    if (!body || typeof body !== "object") throw new Error("Response is not a JSON object");
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// Resolves to { ok:true, totalUsd, usedUsd, remainingUsd, endpoint } or
// { ok:false, error }. fetchImpl is injectable for tests.
async function checkBalance({ baseUrl, apiKey, timeoutMs, fetchImpl = fetch }) {
  const key = String(apiKey || "").trim();
  if (!key) return { ok: false, error: "missing-direct-key" };
  let parsed;
  try {
    parsed = new URL(billingRoots(baseUrl)[0] || "");
  } catch (error) {
    return { ok: false, error: `Invalid balance check URL: ${error?.message || error}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Balance checks support only HTTP or HTTPS URLs" };
  }
  const waitMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const start = isoDay(new Date(Date.now() - 30 * 24 * 3600_000));
  const end = isoDay(new Date(Date.now() + 24 * 3600_000));

  let lastError = "Balance endpoint not found";
  for (const root of billingRoots(baseUrl)) {
    const subscriptionUrl = `${root}/dashboard/billing/subscription`;
    let subscription;
    try {
      subscription = await fetchJson(subscriptionUrl, key, waitMs, fetchImpl);
    } catch (error) {
      lastError = error?.message || String(error);
      continue;
    }
    const totalUsd = finiteNumber(subscription.hard_limit_usd)
      ?? finiteNumber(subscription.system_hard_limit_usd);
    if (totalUsd === null) {
      lastError = "Subscription response has no hard_limit_usd";
      continue;
    }
    let usedUsd = null;
    try {
      const usage = await fetchJson(
        `${root}/dashboard/billing/usage?start_date=${start}&end_date=${end}`,
        key,
        waitMs,
        fetchImpl,
      );
      const cents = finiteNumber(usage.total_usage);
      if (cents !== null) usedUsd = Math.max(0, cents / 100);
    } catch {}
    const remainingUsd = usedUsd === null ? null : Math.max(0, totalUsd - usedUsd);
    return { ok: true, totalUsd, ...(usedUsd === null ? {} : { usedUsd, remainingUsd }), endpoint: subscriptionUrl };
  }
  return { ok: false, error: lastError };
}

module.exports = { checkBalance };
