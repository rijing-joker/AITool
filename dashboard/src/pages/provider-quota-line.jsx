import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";

// Per-provider quota line (cc-switch's QuotaLines / quotaRules): renders what
// is LEFT per window, quiet gray while healthy, bold under 10%, red when used
// up; a click re-queries through the server's cache. Only providers whose
// base URL matches a supported plan provider (row.quotaProvider) render.

const TIER_LABEL_KEYS = {
  five_hour: "pswitch.quota.tier.five_hour",
  weekly: "pswitch.quota.tier.weekly",
  monthly: "pswitch.quota.tier.monthly",
};

function countdown(resetAt, now) {
  if (!resetAt) return null;
  const diffMs = new Date(resetAt).getTime() - now;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return null;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 24) return `${Math.floor(hours / 24)}d${hours % 24}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

// Command Code credits: monthly/purchased/free are the REMAINING pools and
// spent is the period cost, so the visible balance is the sum of the pools.
function creditsRemaining(credits) {
  if (!credits || typeof credits !== "object") return null;
  const sum = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  const total = sum(credits.monthly) + sum(credits.purchased) + sum(credits.free);
  if (total <= 0) return null;
  return Math.round(total * 10) / 10;
}

export function ProviderQuotaLine({ app, provider }) {
  const [quota, setQuota] = useState(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const providerId = provider.id;

  const load = useCallback(async (nocache = false) => {
    setLoading(true);
    try {
      const response = await providerSwitchApi.getQuota(app, providerId, { nocache });
      setQuota(response.quota ?? null);
      setNow(Date.now());
    } catch {
      setQuota({ ok: false, provider: "", error: "network" });
    } finally {
      setLoading(false);
    }
  }, [app, providerId]);

  useEffect(() => {
    if (provider.quotaProvider) void load();
  }, [load, provider.quotaProvider]);

  // Keep the reset countdowns live without re-querying the server.
  useEffect(() => {
    if (!quota?.ok) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [quota?.ok]);

  if (!provider.quotaProvider) return null;

  const tiers = quota?.ok ? quota.tiers ?? [] : [];
  const tierTone = (left) => {
    if (left <= 0) return "font-medium text-red-600 dark:text-red-400";
    if (left < 10) return "font-medium text-oai-black dark:text-white";
    return "text-oai-gray-500 dark:text-oai-gray-400";
  };

  let content;
  if (quota === null || loading) {
    content = (
      <span className="inline-flex items-center gap-1 text-oai-gray-400" role="status">
        <RefreshCw size={11} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {copy("pswitch.quota.loading")}
      </span>
    );
  } else if (!quota.ok) {
    content = (
      <button
        type="button"
        onClick={() => void load(true)}
        className="min-h-6 font-medium text-red-600 dark:text-red-400"
        title={quota.error || undefined}
      >
        {quota.credentialStatus === "expired"
          ? copy("pswitch.quota.expired")
          : copy("pswitch.quota.error")}
      </button>
    );
  } else {
    content = (
      <>
        {tiers.map((tier) => {
          const left = Math.max(0, Math.round(100 - (tier.used_percent ?? 0)));
          const reset = countdown(tier.reset_at, now);
          return (
            <span
              key={tier.id}
              className={`inline-flex items-center gap-1 tabular-nums ${tierTone(left)}`}
              title={tier.reset_at ? `${copy("pswitch.quota.reset_in", { time: reset ?? "—" })} (${new Date(tier.reset_at).toLocaleString()})` : undefined}
            >
              {copy(TIER_LABEL_KEYS[tier.id] ?? "pswitch.quota.tier.monthly")}
              {copy("pswitch.quota.left", { value: left })}
              {reset ? (
                <span className="text-oai-gray-400 dark:text-oai-gray-500">
                  · {copy("pswitch.quota.reset_in", { time: reset })}
                </span>
              ) : null}
            </span>
          );
        })}
        {creditsRemaining(quota.credits) !== null ? (
          <span
            className="inline-flex items-center gap-1 tabular-nums text-oai-gray-500 dark:text-oai-gray-400"
            title={copy("pswitch.quota.credits_breakdown", {
              monthly: quota.credits.monthly ?? 0,
              purchased: quota.credits.purchased ?? 0,
              free: quota.credits.free ?? 0,
            })}
          >
            {copy("pswitch.quota.credits", { value: creditsRemaining(quota.credits) })}
          </span>
        ) : null}
        {quota.plan ? (
          <span className="text-oai-gray-400" title={quota.status || undefined}>{quota.plan}</span>
        ) : null}
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          aria-label={copy("pswitch.quota.refresh")}
          title={copy("pswitch.quota.refresh")}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-oai-gray-400 hover:bg-oai-gray-100 hover:text-oai-gray-600 disabled:opacity-40 dark:hover:bg-oai-gray-800"
        >
          <RefreshCw size={11} aria-hidden="true" className={loading ? "animate-spin motion-reduce:animate-none" : ""} />
        </button>
      </>
    );
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-5">
      {content}
    </div>
  );
}
