import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Copy as CopyIcon,
  Globe,
  KeyRound,
  PauseCircle,
  PlayCircle,
  Server,
  Shuffle,
  Upload,
  Users,
  Zap,
} from "lucide-react";
import { copy } from "../lib/copy";
import { proxyApi } from "../lib/proxy-api";
import { UpstreamsTab } from "./upstreams-tab";
import { AuthFilesTab } from "./auth-files-tab";
import { ModelAliasesTab } from "./model-aliases-tab";
import { KeysTab } from "./keys-tab";
import { RequestsTab } from "./requests-tab";
import { SettingsTab } from "./settings-tab";

// AiTool proxy management — the CLIProxyAPI control surface, styled after the
// TokenTracker dashboard design language (oai palette, card list, status dots).
// One route with seven tabs. Except for Overview, every tab is an interaction
// port of the matching EasyCLIProxyAPI page: upstreams = ApiAccessPage,
// credentials = AuthFileManagementPage, aliases = ThinkingAliasesPage, keys =
// ConfigPanel's key list, requests = UsageRecordsPage, settings = ConfigPanel.

const TABS = [
  { id: "overview", labelKey: "proxy.tab.overview", icon: Activity },
  { id: "upstreams", labelKey: "proxy.tab.upstreams", icon: Globe },
  { id: "providers", labelKey: "proxy.tab.providers", icon: Users },
  { id: "keys", labelKey: "proxy.tab.keys", icon: KeyRound },
  { id: "aliases", labelKey: "proxy.tab.aliases", icon: Shuffle },
  { id: "requests", labelKey: "proxy.tab.requests", icon: Zap },
  { id: "settings", labelKey: "proxy.tab.settings", icon: Server },
];

function formatTime(timestamp) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return timestamp;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function StatusDot({ state }) {
  const color =
    state === "ok"
      ? "bg-oai-brand-500"
      : state === "warn"
        ? "bg-oai-amber-500"
        : state === "error"
          ? "bg-red-500"
          : "bg-oai-gray-300 dark:bg-oai-gray-600";
  return (
    <span className="relative flex h-2 w-2" aria-hidden>
      {state === "ok" || state === "error" ? (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${color}`} />
      ) : null}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

function Card({ children, className = "" }) {
  return (
    <div
      className={`rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-4 sm:p-5 ${className}`}
    >
      {children}
    </div>
  );
}

const compactTokens = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fullTokens = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function formatTokens(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return compactTokens.format(value);
}

function formatLatency(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return `${Math.round(ms)} ms`;
}

function MetricTile({ label, value, hint }) {
  return (
    <Card>
      <p className="text-xs font-semibold tracking-wide text-oai-gray-500 dark:text-oai-gray-400">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">{hint}</p> : null}
    </Card>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copy("proxy.action.copy")}
      title={copy("proxy.action.copy")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          /* clipboard unavailable — feedback still shows the attempt */
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-oai-brand-600" /> : <CopyIcon className="h-3.5 w-3.5" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function OverviewTab({ status, onRefresh }) {
  const [overview, setOverview] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadOverview = useCallback(async () => {
    try {
      const data = await proxyApi.overview();
      setOverview(data.overview);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    const timer = setInterval(() => void loadOverview(), 10_000);
    return () => clearInterval(timer);
  }, [loadOverview]);

  const toggleCore = useCallback(async () => {
    if (!status) return;
    setActionBusy(true);
    setError(null);
    try {
      if (status.core.running) await proxyApi.stop();
      else await proxyApi.start();
      onRefresh();
      void loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  }, [status, onRefresh, loadOverview]);

  const running = status?.core.running ?? false;
  const endpoint = status ? `http://${status.core.host}:${status.core.port}` : "";
  const timeline = overview?.timeline ?? [];
  const timelinePeak = Math.max(1, ...timeline.map((point) => point.total_tokens));

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <StatusDot state={running ? "ok" : "idle"} />
              <span className="text-base font-semibold">
                {running ? copy("proxy.state.running") : copy("proxy.state.stopped")}
              </span>
              {status?.core.version ? (
                <span className="rounded-md bg-oai-gray-100 dark:bg-oai-gray-800 px-1.5 py-0.5 text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">
                  v{status.core.version}
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-sm text-oai-gray-500 dark:text-oai-gray-400">
              {status?.core.installed ? copy("proxy.core.installed_hint") : copy("proxy.core.missing_hint")}
            </p>
            {running ? (
              <div className="mt-2.5 flex items-center gap-1.5 text-sm">
                <span className="text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.core.endpoint")}:</span>
                <code className="rounded bg-oai-gray-100 dark:bg-oai-gray-800 px-1.5 py-0.5 font-mono text-xs">{endpoint}</code>
                <CopyButton text={endpoint} />
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {!status?.core.installed ? (
              <button
                type="button"
                onClick={async () => {
                  setActionBusy(true);
                  setError(null);
                  try {
                    await proxyApi.install();
                    onRefresh();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setActionBusy(false);
                  }
                }}
                disabled={actionBusy}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-oai-brand-600 px-3.5 text-sm font-medium text-white transition-colors hover:bg-oai-brand-700 disabled:opacity-50"
              >
                <Upload className="h-4 w-4" />
                {copy("proxy.action.install_core")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void toggleCore()}
                disabled={actionBusy}
                className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                  running ? "bg-red-600 hover:bg-red-700" : "bg-oai-brand-600 hover:bg-oai-brand-700"
                }`}
              >
                {running ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
                {running ? copy("proxy.action.stop") : copy("proxy.action.start")}
              </button>
            )}
          </div>
        </div>
        {status ? (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">
            <span>
              {copy("proxy.bridge.label")}:{" "}
              <span className={status.bridge.running ? "text-oai-brand-600 dark:text-oai-brand-400 font-medium" : ""}>
                {status.bridge.running
                  ? copy("proxy.bridge.streaming")
                  : status.bridge.connecting
                    ? copy("proxy.bridge.connecting")
                    : copy("proxy.bridge.idle")}
              </span>
            </span>
            {status.bridge.lastEventAt ? (
              <span>
                {copy("proxy.bridge.last_event")}: {formatTime(status.bridge.lastEventAt)}
              </span>
            ) : null}
            {status.core.managementAuthError ? (
              <span className="text-amber-600 dark:text-amber-400">{copy("proxy.management.auth_error")}</span>
            ) : null}
          </div>
        ) : null}
      </Card>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <MetricTile label={copy("proxy.metric.requests")} value={fullTokens.format(overview?.total_requests ?? 0)} />
        <MetricTile
          label={copy("proxy.metric.success_rate")}
          value={overview?.success_rate != null ? `${overview.success_rate}%` : "—"}
        />
        <MetricTile label={copy("proxy.metric.rpm")} value={overview ? overview.rpm.toFixed(1) : "—"} />
        <MetricTile label={copy("proxy.metric.tpm")} value={formatTokens(overview?.tpm)} />
        <MetricTile label={copy("proxy.metric.avg_latency")} value={formatLatency(overview?.average_latency_ms)} />
      </div>

      {timeline.length > 0 ? (
        <Card>
          <p className="text-xs font-semibold tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
            {copy("proxy.metric.timeline_24h")}
          </p>
          <div className="mt-3 flex h-20 items-end gap-[3px]">
            {timeline.map((point) => {
              const height = Math.max(
                point.total_tokens > 0 ? 6 : 2,
                Math.round((point.total_tokens / timelinePeak) * 100),
              );
              return (
                <div
                  key={point.hour_start}
                  title={`${point.hour_start} — ${fullTokens.format(point.total_tokens)} ${copy("proxy.tokens_short")}, ${point.requests} ${copy("proxy.requests_short")}`}
                  className="flex-1 rounded-sm bg-oai-brand-500/80 dark:bg-oai-brand-500/70"
                  style={{ height: `${height}%`, opacity: point.total_tokens > 0 ? 1 : 0.25 }}
                />
              );
            })}
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <p className="text-xs font-semibold tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
            {copy("proxy.metric.by_model")}
          </p>
          {overview?.models.length ? (
            <ul className="mt-3 divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
              {overview.models.slice(0, 8).map((model) => (
                <li key={model.model} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="truncate font-mono text-xs">{model.model}</span>
                  <span className="shrink-0 tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
                    {formatTokens(model.total_tokens)} · {model.requests}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-oai-gray-400">{copy("proxy.empty.no_usage")}</p>
          )}
        </Card>
        <Card>
          <p className="text-xs font-semibold tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
            {copy("proxy.metric.by_provider")}
          </p>
          {overview?.providers.length ? (
            <ul className="mt-3 divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
              {overview.providers.slice(0, 8).map((provider) => (
                <li key={provider.provider} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="truncate capitalize">{provider.provider}</span>
                  <span className="shrink-0 tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
                    {provider.requests}
                    {provider.failures > 0 ? <span className="ml-1.5 text-red-500">{provider.failures} ✕</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-oai-gray-400">{copy("proxy.empty.no_usage")}</p>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export function ProxyPage() {
  const [tab, setTab] = useState(() => {
    const hash = typeof window !== "undefined" ? window.location.hash.replace("#", "") : "";
    return TABS.some((entry) => entry.id === hash) ? hash : "overview";
  });
  const [status, setStatus] = useState(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await proxyApi.status());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 15_000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  const selectTab = useCallback((next) => {
    setTab(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${next}`);
    }
  }, []);

  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mb-6">
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-oai-black dark:text-white mb-3">
              {copy("nav.proxy")}
            </h1>
            <p className="text-oai-gray-500 dark:text-oai-gray-400 text-sm sm:text-base">
              {copy("proxy.page.subtitle")}
            </p>
          </div>

          <div
            role="tablist"
            aria-label={copy("nav.proxy")}
            className="mb-6 inline-flex max-w-full flex-wrap rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-oai-gray-50 dark:bg-oai-gray-800/60 p-1"
          >
            {TABS.map(({ id, labelKey, icon: Icon }) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                type="button"
                onClick={() => selectTab(id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 ${
                  tab === id
                    ? "bg-white dark:bg-oai-gray-900 shadow-oai-sm text-oai-black dark:text-white"
                    : "text-oai-gray-500 hover:text-oai-black dark:hover:text-white"
                }`}
              >
                <Icon className="h-4 w-4" />
                {copy(labelKey)}
              </button>
            ))}
          </div>

          {tab === "overview" ? <OverviewTab status={status} onRefresh={refreshStatus} /> : null}
          {tab === "upstreams" ? <UpstreamsTab /> : null}
          {tab === "providers" ? <AuthFilesTab onDirty={refreshStatus} /> : null}
          {tab === "keys" ? <KeysTab status={status} /> : null}
          {tab === "aliases" ? <ModelAliasesTab /> : null}
          {tab === "requests" ? <RequestsTab /> : null}
          {tab === "settings" ? <SettingsTab status={status} onRefresh={refreshStatus} /> : null}
        </div>
      </main>
    </div>
  );
}

export default ProxyPage;
