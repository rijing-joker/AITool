import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Copy as CopyIcon,
  Globe,
  KeyRound,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Server,
  Shuffle,
  Trash2,
  Upload,
  Users,
  X,
  Zap,
} from "lucide-react";
import { copy } from "../lib/copy";
import { proxyApi } from "../lib/proxy-api";

// AiTool proxy management — the CLIProxyAPI control surface, styled after the
// TokenTracker dashboard design language (oai palette, card list, status dots).
// One route with seven tabs: lifecycle + live metrics, upstream API-key
// providers (EasyCLIProxyAPI's "API 接入"), provider auth files, client access
// keys, model aliases, per-request drill-down, and core settings.

const TABS = [
  { id: "overview", labelKey: "proxy.tab.overview", icon: Activity },
  { id: "upstreams", labelKey: "proxy.tab.upstreams", icon: Globe },
  { id: "providers", labelKey: "proxy.tab.providers", icon: Users },
  { id: "keys", labelKey: "proxy.tab.keys", icon: KeyRound },
  { id: "aliases", labelKey: "proxy.tab.aliases", icon: Shuffle },
  { id: "requests", labelKey: "proxy.tab.requests", icon: Zap },
  { id: "settings", labelKey: "proxy.tab.settings", icon: Server },
];

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

function MetricTile({ label, value, hint }) {
  return (
    <Card>
      <p className="text-xs font-semibold tracking-wide text-oai-gray-500 dark:text-oai-gray-400">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">{hint}</p> : null}
    </Card>
  );
}

function PrimaryButton({ onClick, disabled, children, tone = "brand", type = "button" }) {
  const toneClass =
    tone === "brand"
      ? "bg-oai-brand-600 hover:bg-oai-brand-700 text-white border-transparent"
      : tone === "danger"
        ? "bg-white dark:bg-oai-gray-900 hover:bg-red-50 dark:hover:bg-red-950/40 text-red-600 dark:text-red-400 border-oai-gray-200 dark:border-oai-gray-800"
        : "bg-white dark:bg-oai-gray-900 hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800 text-oai-gray-700 dark:text-oai-gray-200 border-oai-gray-200 dark:border-oai-gray-800";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50 disabled:pointer-events-none ${toneClass}`}
    >
      {children}
    </button>
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
              <PrimaryButton
                onClick={async () => {
                  setActionBusy(true);
                  try {
                    await proxyApi.install();
                    onRefresh();
                  } finally {
                    setActionBusy(false);
                  }
                }}
                disabled={actionBusy}
              >
                <Upload className="h-4 w-4" />
                {copy("proxy.action.install_core")}
              </PrimaryButton>
            ) : (
              <PrimaryButton onClick={() => void toggleCore()} disabled={actionBusy} tone={running ? "danger" : "brand"}>
                {running ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
                {running ? copy("proxy.action.stop") : copy("proxy.action.start")}
              </PrimaryButton>
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
// Providers tab (auth files)
// ---------------------------------------------------------------------------

function ProvidersTab({ onDirty }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const data = await proxyApi.authFiles();
      setFiles(Array.isArray(data.files) ? data.files : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFiles([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = useCallback(
    async (fileList) => {
      if (!fileList || fileList.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        for (const file of Array.from(fileList)) {
          const content = await file.text();
          await proxyApi.uploadAuthFile({ name: file.name, content });
        }
        await load();
        onDirty();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [load, onDirty],
  );

  const remove = useCallback(
    async (name) => {
      setBusy(true);
      try {
        await proxyApi.deleteAuthFile(name);
        await load();
        onDirty();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load, onDirty],
  );

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.providers.subtitle")}</p>
        <div className="flex items-center gap-2">
          <PrimaryButton
            onClick={async () => {
              setBusy(true);
              try {
                await proxyApi.refreshAuthFiles();
                await load();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            tone="neutral"
          >
            <RefreshCw className="h-4 w-4" />
            {copy("proxy.action.refresh_tokens")}
          </PrimaryButton>
          <PrimaryButton onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <Plus className="h-4 w-4" />
            {copy("proxy.action.upload_auth")}
          </PrimaryButton>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            className="hidden"
            onChange={(event) => void upload(event.target.files)}
          />
        </div>
      </div>

      <Card className="!p-0 overflow-hidden">
        {files === null ? (
          <div className="px-5 py-8 text-center text-sm text-oai-gray-400">{copy("proxy.loading")}</div>
        ) : files.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Users className="mx-auto h-8 w-8 text-oai-gray-300 dark:text-oai-gray-600" />
            <p className="mt-3 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.providers.empty")}</p>
            <p className="mt-1.5 text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.providers.empty_hint")}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-oai-gray-200 dark:border-oai-gray-800 text-left">
                <th className="px-4 sm:px-5 py-3 text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("proxy.providers.file")}
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("proxy.providers.provider")}
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("proxy.providers.status")}
                </th>
                <th
                  className="px-4 sm:px-5 py-3 text-right text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400"
                  aria-label={copy("proxy.providers.actions")}
                />
              </tr>
            </thead>
            <tbody className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
              {files.map((file, index) => {
                const name = String(file.name ?? file.file ?? `#${index}`);
                const disabled = Boolean(file.disabled);
                return (
                  <tr key={name} className="hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/50">
                    <td className="max-w-[280px] truncate px-4 sm:px-5 py-3 font-mono text-xs">{name}</td>
                    <td className="px-4 py-3 capitalize text-oai-gray-600 dark:text-oai-gray-300">
                      {String(file.provider ?? file.type ?? "—")}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot state={disabled ? "idle" : "ok"} />
                        <span
                          className={
                            disabled ? "text-oai-gray-400" : "text-oai-brand-600 dark:text-oai-brand-400"
                          }
                        >
                          {disabled ? copy("proxy.providers.disabled") : copy("proxy.providers.active")}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 sm:px-5 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => void remove(name)}
                        disabled={busy}
                        aria-label={copy("proxy.action.delete_auth")}
                        title={copy("proxy.action.delete_auth")}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-oai-gray-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keys tab
// ---------------------------------------------------------------------------

function KeysTab({ status }) {
  const [keys, setKeys] = useState(null);
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await proxyApi.keys();
      const list = Array.isArray(data.keys) ? data.keys : data.keys?.items || [];
      setKeys(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setKeys([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next) => {
      setBusy(true);
      try {
        await proxyApi.putKeys(next);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const port = status?.core.port ?? 8318;
  const host = status?.core.host ?? "127.0.0.1";
  const endpoints = [
    { label: "OpenAI", path: "/v1/chat/completions" },
    { label: "Anthropic", path: "/v1/messages" },
    { label: "Gemini", path: "/v1beta/models" },
  ];

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <Card>
        <p className="text-xs font-semibold tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
          {copy("proxy.keys.endpoints")}
        </p>
        <ul className="mt-3 space-y-2">
          {endpoints.map((endpoint) => {
            const url = `http://${host}:${port}${endpoint.path}`;
            return (
              <li key={endpoint.label} className="flex items-center justify-between gap-3 text-sm">
                <span className="w-20 shrink-0 text-oai-gray-500 dark:text-oai-gray-400">{endpoint.label}</span>
                <code className="min-w-0 flex-1 truncate rounded bg-oai-gray-100 dark:bg-oai-gray-800 px-2 py-1 font-mono text-xs">
                  {url}
                </code>
                <CopyButton text={url} />
              </li>
            );
          })}
        </ul>
      </Card>

      <Card className="!p-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-oai-gray-100 dark:border-oai-gray-800">
          <p className="text-sm font-semibold">{copy("proxy.keys.title")}</p>
          <span className="text-xs text-oai-gray-400">{copy("proxy.keys.count", { count: keys?.length ?? 0 })}</span>
        </div>
        <ul className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
          {keys === null ? (
            <li className="px-5 py-6 text-center text-sm text-oai-gray-400">{copy("proxy.loading")}</li>
          ) : keys.length === 0 ? (
            <li className="px-5 py-8 text-center text-sm text-oai-gray-400">{copy("proxy.keys.empty")}</li>
          ) : (
            keys.map((key, index) => (
              <li key={`${key}-${index}`} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 text-sm">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{key}</code>
                <CopyButton text={key} />
                <button
                  type="button"
                  onClick={() => void save(keys.filter((_, i) => i !== index))}
                  disabled={busy}
                  aria-label={copy("proxy.action.delete_key")}
                  title={copy("proxy.action.delete_key")}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-oai-gray-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))
          )}
        </ul>
        <form
          className="flex items-center gap-2 border-t border-oai-gray-100 dark:border-oai-gray-800 px-4 sm:px-5 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            const value = newKey.trim();
            if (!value || !keys) return;
            void save([...keys, value]);
            setNewKey("");
          }}
        >
          <input
            value={newKey}
            onChange={(event) => setNewKey(event.target.value)}
            placeholder={copy("proxy.keys.add_placeholder")}
            className="h-9 min-w-0 flex-1 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
          />
          <PrimaryButton type="submit" disabled={busy || !newKey.trim()}>
            <Plus className="h-4 w-4" />
            {copy("proxy.action.add_key")}
          </PrimaryButton>
        </form>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upstreams tab (API 接入 — upstream API-key providers)
// ---------------------------------------------------------------------------

function maskKey(key) {
  const value = String(key || "");
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function SimpleKeysSection({ section, titleKey }) {
  const [providers, setProviders] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ apiKey: "", baseUrl: "" });

  const load = useCallback(async () => {
    try {
      const data = await proxyApi.upstreamSection(section);
      setProviders(data.providers || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProviders([]);
    }
  }, [section]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next) => {
      setBusy(true);
      try {
        await proxyApi.saveUpstreamSection(section, next);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [section, load],
  );

  return (
    <Card className="!p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-oai-gray-100 dark:border-oai-gray-800">
        <p className="text-sm font-semibold">{copy(titleKey)}</p>
        <span className="text-xs text-oai-gray-400">
          {copy("proxy.keys.count", { count: providers?.length ?? 0 })}
        </span>
      </div>
      {error ? (
        <p className="px-4 sm:px-5 py-2 text-xs text-amber-600 dark:text-amber-400">{error}</p>
      ) : null}
      {providers === null ? (
        <div className="px-5 py-6 text-center text-sm text-oai-gray-400">{copy("proxy.loading")}</div>
      ) : providers.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-oai-gray-400">{copy("proxy.upstreams.empty")}</p>
      ) : (
        <ul className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
          {providers.map((provider, index) => {
            const apiKey = provider["api-key"] || "";
            const baseUrl = provider["base-url"] || "";
            return (
              <li key={`${apiKey}-${index}`} className="flex flex-wrap items-center gap-2 px-4 sm:px-5 py-3 text-sm">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{maskKey(apiKey)}</code>
                {baseUrl ? (
                  <code className="max-w-[240px] truncate rounded bg-oai-gray-100 dark:bg-oai-gray-800 px-1.5 py-0.5 font-mono text-xs text-oai-gray-500 dark:text-oai-gray-400">
                    {baseUrl}
                  </code>
                ) : null}
                <CopyButton text={apiKey} />
                <button
                  type="button"
                  onClick={() => void save(providers.filter((_, i) => i !== index))}
                  disabled={busy}
                  aria-label={copy("proxy.action.delete_key")}
                  title={copy("proxy.action.delete_key")}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-oai-gray-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-2 border-t border-oai-gray-100 dark:border-oai-gray-800 px-4 sm:px-5 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          const apiKey = draft.apiKey.trim();
          if (!apiKey || !providers) return;
          const next = [...providers, { "api-key": apiKey, ...(draft.baseUrl.trim() ? { "base-url": draft.baseUrl.trim() } : {}) }];
          void save(next);
          setDraft({ apiKey: "", baseUrl: "" });
        }}
      >
        <input
          value={draft.apiKey}
          onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
          placeholder={copy("proxy.upstreams.key_placeholder")}
          className="h-9 min-w-0 flex-1 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
        />
        <input
          value={draft.baseUrl}
          onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
          placeholder={copy("proxy.upstreams.baseurl_placeholder")}
          className="h-9 w-56 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
        />
        <PrimaryButton type="submit" disabled={busy || !draft.apiKey.trim()}>
          <Plus className="h-4 w-4" />
          {copy("proxy.action.add_key")}
        </PrimaryButton>
      </form>
    </Card>
  );
}

function OpenaiCompatSection() {
  const [providers, setProviders] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [draft, setDraft] = useState({ name: "", baseUrl: "", apiKey: "" });
  const [modelDraft, setModelDraft] = useState({ name: "", alias: "", thinking: "" });

  const load = useCallback(async () => {
    try {
      const data = await proxyApi.openaiCompat();
      setProviders(data.providers || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProviders([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next) => {
      setBusy(true);
      try {
        await proxyApi.saveOpenaiCompat(next);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  // Count how many sources share each alias across all providers — the
  // multi-source alias feature (one alias, round-robin across providers).
  const aliasSources = useMemo(() => {
    const map = new Map();
    for (const provider of providers || []) {
      for (const model of provider.models || []) {
        const alias = String(model.alias || model.name || "").trim();
        if (!alias) continue;
        map.set(alias, (map.get(alias) || 0) + 1);
      }
    }
    return map;
  }, [providers]);

  const addModel = useCallback(
    (provider) => {
      const name = modelDraft.name.trim();
      const alias = modelDraft.alias.trim() || name;
      if (!name || !provider) return;
      const thinkingLevels = modelDraft.thinking
        .split(",")
        .map((level) => level.trim())
        .filter(Boolean);
      const next = (providers || []).map((entry) =>
        entry.name === provider.name
          ? {
              ...entry,
              models: [
                ...(entry.models || []),
                {
                  name,
                  alias,
                  ...(thinkingLevels.length ? { thinking: { levels: thinkingLevels } } : {}),
                },
              ],
            }
          : entry,
      );
      void save(next);
      setModelDraft({ name: "", alias: "", thinking: "" });
    },
    [providers, modelDraft, save],
  );

  return (
    <Card className="!p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-oai-gray-100 dark:border-oai-gray-800">
        <div>
          <p className="text-sm font-semibold">{copy("proxy.upstreams.compat_title")}</p>
          <p className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {copy("proxy.upstreams.compat_hint")}
          </p>
        </div>
        <span className="text-xs text-oai-gray-400">
          {copy("proxy.keys.count", { count: providers?.length ?? 0 })}
        </span>
      </div>
      {error ? (
        <p className="px-4 sm:px-5 py-2 text-xs text-amber-600 dark:text-amber-400">{error}</p>
      ) : null}
      {providers === null ? (
        <div className="px-5 py-6 text-center text-sm text-oai-gray-400">{copy("proxy.loading")}</div>
      ) : providers.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-oai-gray-400">{copy("proxy.upstreams.empty")}</p>
      ) : (
        <ul className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
          {providers.map((provider) => {
            const isOpen = expanded === provider.name;
            const keyCount = (provider["api-key-entries"] || []).length;
            const models = provider.models || [];
            return (
              <li key={provider.name} className="px-4 sm:px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : provider.name)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="text-sm font-medium">{provider.name}</span>
                    <span className="ml-2 font-mono text-xs text-oai-gray-500 dark:text-oai-gray-400">
                      {provider["base-url"] || "—"}
                    </span>
                    <span className="ml-2 text-xs text-oai-gray-400">
                      {copy("proxy.upstreams.key_count", { count: keyCount })} · {copy("proxy.upstreams.model_count", { count: models.length })}
                    </span>
                  </button>
                  {provider.disabled ? (
                    <span className="rounded-md bg-oai-gray-100 dark:bg-oai-gray-800 px-1.5 py-0.5 text-xs text-oai-gray-500">
                      {copy("proxy.providers.disabled")}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      if (!providers) return;
                      void save(providers.filter((entry) => entry.name !== provider.name));
                    }}
                    disabled={busy}
                    aria-label={copy("proxy.upstreams.delete_provider")}
                    title={copy("proxy.upstreams.delete_provider")}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-oai-gray-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {isOpen ? (
                  <div className="mt-3 rounded-lg border border-oai-gray-100 dark:border-oai-gray-800 p-3">
                    <p className="text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                      {copy("proxy.upstreams.models_title")}
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {models.length === 0 ? (
                        <li className="text-xs text-oai-gray-400">{copy("proxy.upstreams.no_models")}</li>
                      ) : (
                        models.map((model, modelIndex) => {
                          const alias = String(model.alias || model.name);
                          const sourceCount = aliasSources.get(alias) || 0;
                          return (
                            <li key={`${model.name}-${modelIndex}`} className="flex items-center gap-2 text-xs">
                              <code className="font-mono text-oai-gray-600 dark:text-oai-gray-300">{model.name}</code>
                              <span className="text-oai-gray-400">→</span>
                              <code className="font-mono font-medium text-oai-brand-600 dark:text-oai-brand-400">{alias}</code>
                              {sourceCount > 1 ? (
                                <span
                                  title={copy("proxy.upstreams.multi_source_hint")}
                                  className="rounded bg-oai-brand-50 dark:bg-oai-brand-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-oai-brand-700 dark:text-oai-brand-300"
                                >
                                  {copy("proxy.upstreams.multi_source", { count: sourceCount })}
                                </span>
                              ) : null}
                              {(model.thinking?.levels || []).length ? (
                                <span className="text-oai-gray-400">
                                  {copy("proxy.upstreams.thinking_levels", { levels: model.thinking.levels.join("/") })}
                                </span>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => {
                                  const next = (providers || []).map((entry) =>
                                    entry.name === provider.name
                                      ? { ...entry, models: (entry.models || []).filter((_, i) => i !== modelIndex) }
                                      : entry,
                                  );
                                  void save(next);
                                }}
                                disabled={busy}
                                aria-label={copy("proxy.upstreams.delete_model")}
                                className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-oai-gray-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </li>
                          );
                        })
                      )}
                    </ul>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <input
                        value={modelDraft.name}
                        onChange={(event) => setModelDraft((current) => ({ ...current, name: event.target.value }))}
                        placeholder={copy("proxy.upstreams.model_name_placeholder")}
                        className="h-8 w-44 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-transparent px-2.5 text-xs placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
                      />
                      <span className="text-xs text-oai-gray-400">→</span>
                      <input
                        value={modelDraft.alias}
                        onChange={(event) => setModelDraft((current) => ({ ...current, alias: event.target.value }))}
                        placeholder={copy("proxy.upstreams.model_alias_placeholder")}
                        className="h-8 w-44 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-transparent px-2.5 text-xs placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
                      />
                      <input
                        value={modelDraft.thinking}
                        onChange={(event) => setModelDraft((current) => ({ ...current, thinking: event.target.value }))}
                        placeholder={copy("proxy.upstreams.thinking_placeholder")}
                        className="h-8 w-40 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-transparent px-2.5 text-xs placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
                      />
                      <PrimaryButton onClick={() => addModel(provider)} disabled={busy || !modelDraft.name.trim()}>
                        <Plus className="h-3.5 w-3.5" />
                        {copy("proxy.upstreams.add_model")}
                      </PrimaryButton>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-2 border-t border-oai-gray-100 dark:border-oai-gray-800 px-4 sm:px-5 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          const name = draft.name.trim();
          const baseUrl = draft.baseUrl.trim();
          const apiKey = draft.apiKey.trim();
          if (!name || !baseUrl || !apiKey || !providers) return;
          void save([
            ...providers,
            { name, "base-url": baseUrl, "api-key-entries": [{ "api-key": apiKey }], models: [] },
          ]);
          setDraft({ name: "", baseUrl: "", apiKey: "" });
        }}
      >
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder={copy("proxy.upstreams.provider_name_placeholder")}
          className="h-9 w-40 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
        />
        <input
          value={draft.baseUrl}
          onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
          placeholder={copy("proxy.upstreams.baseurl_placeholder")}
          className="h-9 min-w-0 flex-1 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
        />
        <input
          value={draft.apiKey}
          onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
          placeholder={copy("proxy.upstreams.key_placeholder")}
          className="h-9 w-48 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
        />
        <PrimaryButton type="submit" disabled={busy || !draft.name.trim() || !draft.baseUrl.trim() || !draft.apiKey.trim()}>
          <Plus className="h-4 w-4" />
          {copy("proxy.upstreams.add_provider")}
        </PrimaryButton>
      </form>
    </Card>
  );
}

function UpstreamsTab() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.upstreams.subtitle")}</p>
      <SimpleKeysSection section="gemini" titleKey="proxy.upstreams.gemini" />
      <SimpleKeysSection section="claude" titleKey="proxy.upstreams.claude" />
      <SimpleKeysSection section="codex" titleKey="proxy.upstreams.codex" />
      <OpenaiCompatSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aliases tab (OAuth channel model aliases)
// ---------------------------------------------------------------------------

const OAUTH_CHANNELS = ["claude", "codex", "gemini", "kimi", "xai", "meta", "vertex", "aistudio", "antigravity"];

function AliasesTab() {
  const [aliases, setAliases] = useState(null);
  const [channel, setChannel] = useState("claude");
  const [draft, setDraft] = useState({ name: "", alias: "" });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await proxyApi.oauthAliases();
      setAliases(data.aliases || {});
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAliases({});
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = aliases?.[channel] || [];

  const saveChannel = useCallback(
    async (next) => {
      setBusy(true);
      try {
        await proxyApi.saveOauthChannel(channel, next);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [channel, load],
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.aliases.subtitle")}</p>

      <div
        role="tablist"
        aria-label={copy("proxy.aliases.channels")}
        className="flex flex-wrap gap-1.5"
      >
        {OAUTH_CHANNELS.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => setChannel(entry)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 ${
              channel === entry
                ? "bg-oai-brand-600 text-white"
                : "border border-oai-gray-200 dark:border-oai-gray-800 text-oai-gray-500 hover:text-oai-black dark:hover:text-white"
            }`}
          >
            {entry}
            {(aliases?.[entry] || []).length ? (
              <span className={`ml-1 ${channel === entry ? "text-white/80" : "text-oai-gray-400"}`}>
                {(aliases[entry] || []).length}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <Card className="!p-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-oai-gray-100 dark:border-oai-gray-800">
          <p className="text-sm font-semibold capitalize">{channel}</p>
          <span className="text-xs text-oai-gray-400">{copy("proxy.keys.count", { count: current.length })}</span>
        </div>
        {aliases === null ? (
          <div className="px-5 py-6 text-center text-sm text-oai-gray-400">{copy("proxy.loading")}</div>
        ) : current.length === 0 ? (
          <p className="px-5 py-6 text-center text-sm text-oai-gray-400">{copy("proxy.aliases.empty")}</p>
        ) : (
          <ul className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
            {current.map((entry, index) => (
              <li key={`${entry.name}-${index}`} className="flex items-center gap-2 px-4 sm:px-5 py-3 text-sm">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-oai-gray-600 dark:text-oai-gray-300">
                  {entry.name}
                </code>
                <span className="text-oai-gray-400">→</span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-oai-brand-600 dark:text-oai-brand-400">
                  {entry.alias}
                </code>
                {entry.fork ? (
                  <span className="rounded bg-oai-gray-100 dark:bg-oai-gray-800 px-1.5 py-0.5 text-[10px] text-oai-gray-500">
                    fork
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => void saveChannel(current.filter((_, i) => i !== index))}
                  disabled={busy}
                  aria-label={copy("proxy.aliases.delete_alias")}
                  title={copy("proxy.aliases.delete_alias")}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-oai-gray-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-center gap-2 border-t border-oai-gray-100 dark:border-oai-gray-800 px-4 sm:px-5 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            const name = draft.name.trim();
            if (!name) return;
            const alias = draft.alias.trim() || name;
            void saveChannel([...current, { name, alias }]);
            setDraft({ name: "", alias: "" });
          }}
        >
          <input
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            placeholder={copy("proxy.aliases.name_placeholder")}
            className="h-9 min-w-0 flex-1 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
          />
          <span className="text-oai-gray-400">→</span>
          <input
            value={draft.alias}
            onChange={(event) => setDraft((current) => ({ ...current, alias: event.target.value }))}
            placeholder={copy("proxy.aliases.alias_placeholder")}
            className="h-9 min-w-0 flex-1 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
          />
          <PrimaryButton type="submit" disabled={busy || !draft.name.trim()}>
            <Plus className="h-4 w-4" />
            {copy("proxy.aliases.add_alias")}
          </PrimaryButton>
        </form>
      </Card>
      <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.aliases.hint")}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Requests tab
// ---------------------------------------------------------------------------

function RequestsTab() {
  const [records, setRecords] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [failedFilter, setFailedFilter] = useState("all");
  const [error, setError] = useState(null);
  const pageSize = 50;

  const load = useCallback(async () => {
    try {
      const data = await proxyApi.records({
        page,
        pageSize,
        failed: failedFilter === "all" ? undefined : failedFilter,
      });
      setRecords(data.records);
      setTotal(data.total);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRecords([]);
    }
  }, [page, failedFilter]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
          {copy("proxy.requests.subtitle", { total: fullTokens.format(total) })}
        </p>
        <div className="inline-flex rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-oai-gray-50 dark:bg-oai-gray-800/60 p-0.5">
          {(["all", "false", "true"]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setPage(0);
                setFailedFilter(value);
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                failedFilter === value
                  ? "bg-white dark:bg-oai-gray-900 shadow-oai-sm text-oai-black dark:text-white"
                  : "text-oai-gray-500 hover:text-oai-black dark:hover:text-white"
              }`}
            >
              {value === "all"
                ? copy("proxy.requests.filter.all")
                : value === "false"
                  ? copy("proxy.requests.filter.ok")
                  : copy("proxy.requests.filter.failed")}
            </button>
          ))}
        </div>
      </div>

      <Card className="!p-0 overflow-hidden">
        {records === null ? (
          <div className="px-5 py-8 text-center text-sm text-oai-gray-400">{copy("proxy.loading")}</div>
        ) : records.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Zap className="mx-auto h-8 w-8 text-oai-gray-300 dark:text-oai-gray-600" />
            <p className="mt-3 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.requests.empty")}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-oai-gray-200 dark:border-oai-gray-800 text-left">
                  <th className="px-4 sm:px-5 py-3 text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.time")}
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.model")}
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.response_model")}
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.provider")}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.tokens")}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.latency")}
                  </th>
                  <th className="px-4 sm:px-5 py-3 text-right text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.status")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
                {records.map((record, index) => (
                  <tr
                    key={record.id ?? `${record.timestamp}-${index}`}
                    className="hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/50"
                  >
                    <td className="whitespace-nowrap px-4 sm:px-5 py-2.5 tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
                      {formatTime(record.timestamp)}
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-2.5 font-mono text-xs">
                      {record.model || record.alias || "—"}
                    </td>
                    {(() => {
                      // issue 308 port: surface the upstream-reported model so
                      // silent model substitution is visible — amber cell when
                      // the response model differs from the requested one.
                      const requested = record.model || record.alias || "";
                      const responseModel = String(record.response_model || "").trim();
                      const substituted = responseModel !== "" && responseModel !== requested;
                      return (
                        <td
                          className={`max-w-[220px] truncate px-4 py-2.5 font-mono text-xs ${
                            substituted
                              ? "rounded bg-amber-50 dark:bg-amber-950/40 font-medium text-amber-700 dark:text-amber-300"
                              : "text-oai-gray-500 dark:text-oai-gray-400"
                          }`}
                          title={substituted ? copy("proxy.requests.substituted_hint") : undefined}
                        >
                          {responseModel || "—"}
                        </td>
                      );
                    })()}
                    <td className="px-4 py-2.5 capitalize text-oai-gray-600 dark:text-oai-gray-300">
                      {record.provider || "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                      {formatTokens(record.tokens?.totalTokens ?? 0)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
                      {formatLatency(record.latency_ms)}
                    </td>
                    <td className="whitespace-nowrap px-4 sm:px-5 py-2.5 text-right">
                      {record.failed ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-red-50 dark:bg-red-950/40 px-1.5 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                          {record.failure_status ? `HTTP ${record.failure_status}` : copy("proxy.requests.failed")}
                        </span>
                      ) : record.canceled ? (
                        <span className="text-xs text-oai-gray-400">{copy("proxy.requests.canceled")}</span>
                      ) : (
                        <span className="text-xs font-medium text-oai-brand-600 dark:text-oai-brand-400">
                          {copy("proxy.requests.ok")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > pageSize ? (
          <div className="flex items-center justify-between border-t border-oai-gray-100 dark:border-oai-gray-800 px-4 sm:px-5 py-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0}
              className="rounded-md px-2 py-1 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-40"
            >
              ← {copy("proxy.requests.prev")}
            </button>
            <span>
              {page + 1} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
              disabled={page >= totalPages - 1}
              className="rounded-md px-2 py-1 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-40"
            >
              {copy("proxy.requests.next")} →
            </button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

function SettingsTab({ status, onRefresh }) {
  const [autoStart, setAutoStart] = useState(status?.core.autoStart ?? true);
  const [yaml, setYaml] = useState(null);
  const [yamlDirty, setYamlDirty] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    proxyApi
      .configYaml()
      .then((data) => {
        if (alive) setYaml(data.yaml);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleAutoStart = useCallback(async () => {
    const next = !autoStart;
    setAutoStart(next);
    try {
      await proxyApi.setSettings({ autoStart: next });
    } catch (e) {
      setAutoStart(!next);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [autoStart]);

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-lg border border-oai-brand-200 dark:border-oai-brand-900 bg-oai-brand-50 dark:bg-oai-brand-950/40 px-3.5 py-2.5 text-sm text-oai-brand-700 dark:text-oai-brand-300">
          {notice}
        </div>
      ) : null}

      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold">{copy("proxy.settings.autostart")}</p>
            <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.settings.autostart_hint")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoStart}
            onClick={() => void toggleAutoStart()}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 ${
              autoStart ? "bg-oai-brand-600" : "bg-oai-gray-300 dark:bg-oai-gray-600"
            }`}
          >
            <span
              className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow transition-transform ${
                autoStart ? "translate-x-[24px]" : "translate-x-[3px]"
              }`}
            />
          </button>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{copy("proxy.settings.core")}</p>
            <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {status?.core.version
                ? copy("proxy.settings.core_version", { version: status.core.version })
                : copy("proxy.core.missing_hint")}
            </p>
          </div>
          <PrimaryButton
            tone="neutral"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setNotice(null);
              try {
                await proxyApi.install();
                setNotice(copy("proxy.settings.core_updated"));
                onRefresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Upload className="h-4 w-4" />
            {copy("proxy.settings.fetch_core")}
          </PrimaryButton>
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold">{copy("proxy.settings.config")}</p>
          <div className="flex items-center gap-2">
            {yamlDirty ? (
              <button
                type="button"
                onClick={() => {
                  if (yaml === null) return;
                  proxyApi
                    .configYaml()
                    .then((data) => {
                      setYaml(data.yaml);
                      setYamlDirty(false);
                    })
                    .catch(() => {});
                }}
                className="text-xs font-medium text-oai-gray-500 hover:text-oai-black dark:hover:text-white"
              >
                {copy("proxy.action.revert")}
              </button>
            ) : null}
            <PrimaryButton
              disabled={!yamlDirty || busy}
              onClick={async () => {
                if (yaml === null) return;
                setBusy(true);
                setError(null);
                try {
                  await proxyApi.putConfigYaml(yaml);
                  setYamlDirty(false);
                  setNotice(copy("proxy.settings.config_saved"));
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {copy("proxy.action.save_config")}
            </PrimaryButton>
          </div>
        </div>
        <textarea
          value={yaml ?? ""}
          onChange={(event) => {
            setYaml(event.target.value);
            setYamlDirty(true);
          }}
          spellCheck={false}
          rows={16}
          className="mt-3 w-full resize-y rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-oai-gray-50 dark:bg-oai-gray-950 p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
          placeholder={copy("proxy.settings.config")}
        />
        <p className="mt-2 text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.settings.config_hint")}</p>
      </Card>
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
          {tab === "providers" ? <ProvidersTab onDirty={refreshStatus} /> : null}
          {tab === "keys" ? <KeysTab status={status} /> : null}
          {tab === "aliases" ? <AliasesTab /> : null}
          {tab === "requests" ? <RequestsTab /> : null}
          {tab === "settings" ? <SettingsTab status={status} onRefresh={refreshStatus} /> : null}
        </div>
      </main>
    </div>
  );
}

export default ProxyPage;
