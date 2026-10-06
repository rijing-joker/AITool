import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";

// Per-provider quota line (cc-switch's QuotaLines / quotaRules): renders what
// is LEFT per window, quiet gray while healthy, bold under 10%, red when used
// up; a click re-queries through the server's cache. Only providers whose
// base URL matches a supported plan provider (row.quotaProvider) render.

// Click-refresh feedback (cc-switch a7d3825): a request often settles in well
// under a second, so the icon spins for at least MIN_REFRESH_SPIN_MS and then
// shows a check or a cross for REFRESH_RESULT_MS before going back to idle.
const MIN_REFRESH_SPIN_MS = 600;
const REFRESH_RESULT_MS = 1000;

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

// Precomputed so the JSX text scan never sees a bare ternary chain in braces.
function RefreshIcon({ phase, busy }) {
  if (phase === "ok") { return <Check size={12} aria-hidden="true" className="text-emerald-600 dark:text-emerald-400" />; }
  if (phase === "failed") { return <X size={12} aria-hidden="true" className="text-red-500" />; }
  return (
    <RefreshCw
      size={11}
      aria-hidden="true"
      className={phase === "spinning" || busy ? "animate-spin motion-reduce:animate-none" : ""}
    />
  );
}

export function ProviderQuotaLine({ app, provider }) {
  const [quota, setQuota] = useState(null);
  const [loading, setLoading] = useState(false);
  // idle | spinning | ok | failed — driven by explicit click-refreshes only;
  // background/mount loads keep the plain dim behavior.
  const [refreshPhase, setRefreshPhase] = useState("idle");
  const [now, setNow] = useState(() => Date.now());
  const refreshTimerRef = useRef(null);
  const providerId = provider.id;

  useEffect(() => () => clearTimeout(refreshTimerRef.current), []);

  const load = useCallback(async (nocache = false) => {
    setLoading(true);
    try {
      const response = await providerSwitchApi.getQuota(app, providerId, { nocache });
      setQuota(response.quota ?? null);
      setNow(Date.now());
      return response.quota?.ok === true;
    } catch {
      setQuota({ ok: false, provider: "", error: "network" });
      return false;
    } finally {
      setLoading(false);
    }
  }, [app, providerId]);

  const refreshPhaseRef = useRef("idle");
  const refreshClicked = useCallback(async () => {
    // Phase machine lives on a ref: StrictMode replays state updaters, so the
    // click handler itself must stay free of setState-updater side effects.
    if (refreshPhaseRef.current === "spinning") return;
    refreshPhaseRef.current = "spinning";
    setRefreshPhase("spinning");
    const startedAt = Date.now();
    const ok = await load(true);
    refreshTimerRef.current = setTimeout(() => {
      refreshPhaseRef.current = ok ? "ok" : "failed";
      setRefreshPhase(ok ? "ok" : "failed");
      refreshTimerRef.current = setTimeout(() => {
        refreshPhaseRef.current = "idle";
        setRefreshPhase("idle");
      }, REFRESH_RESULT_MS);
    }, Math.max(0, MIN_REFRESH_SPIN_MS - (Date.now() - startedAt)));
  }, [load]);

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
        onClick={() => void refreshClicked()}
        aria-disabled={refreshPhase === "spinning"}
        className="min-h-6 inline-flex items-center gap-1 font-medium text-red-600 dark:text-red-400 disabled:opacity-40"
        title={quota.error || undefined}
      >
        <RefreshCw
          size={11}
          aria-hidden="true"
          className={refreshPhase === "failed" ? "hidden" : refreshPhase === "spinning" ? "animate-spin motion-reduce:animate-none" : ""}
        />
        {refreshPhase === "failed" ? <X size={11} aria-hidden="true" /> : null}
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
          onClick={() => void refreshClicked()}
          aria-disabled={refreshPhase === "spinning"}
          aria-label={copy("pswitch.quota.refresh")}
          title={copy("pswitch.quota.refresh")}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-oai-gray-400 hover:bg-oai-gray-100 hover:text-oai-gray-600 aria-disabled:opacity-40 dark:hover:bg-oai-gray-800"
        >
          <RefreshIcon phase={refreshPhase} busy={loading} />
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
