import React, { useCallback, useEffect, useId, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Zap } from "lucide-react";
import { copy } from "../lib/copy";
import { Card } from "../ui/components";
import { showToast } from "../ui/components/Toast";
import { useVisiblePolling } from "../hooks/use-visible-polling";

// ---------------------------------------------------------------------------
// Requests tab (请求记录) — interaction ported from EasyCLIProxyAPI's
// UsageRecordsPage onto the local usage store: time-range presets with a
// custom range, model/provider/result filters, aggregate stat tiles, an
// expandable per-request detail row, and auto refresh.
// ---------------------------------------------------------------------------

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
  return date.toLocaleString([], {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

const RANGES = [
  { id: "1h", ms: 60 * 60 * 1000 },
  { id: "24h", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "all", ms: null },
  { id: "custom", ms: null },
];

function rangeParams(range, customStart, customEnd) {
  const preset = RANGES.find((entry) => entry.id === range);
  if (!preset) return {};
  if (range === "custom") {
    const since = customStart ? Date.parse(customStart) : NaN;
    const until = customEnd ? Date.parse(customEnd) : NaN;
    return {
      ...(Number.isFinite(since) ? { since: new Date(since).toISOString() } : {}),
      ...(Number.isFinite(until) ? { until: new Date(until).toISOString() } : {}),
    };
  }
  if (preset.ms === null) return {};
  return { since: new Date(Date.now() - preset.ms).toISOString() };
}

function StatTile({ label, value, tone }) {
  return (
    <Card bodyClassName="!p-3">
      <p className="text-xs font-semibold tracking-wide text-oai-gray-500 dark:text-oai-gray-400">{label}</p>
      <p className={`mt-1 truncate text-lg sm:text-xl font-semibold tabular-nums tracking-tight ${tone ?? ""}`}>{value}</p>
    </Card>
  );
}

function RecordDetail({ record }) {
  const tokens = record.tokens ?? {};
  const rows = [
    ["proxy.requests.detail.input", tokens.inputTokens],
    ["proxy.requests.detail.output", tokens.outputTokens],
    ["proxy.requests.detail.reasoning", tokens.reasoningTokens],
    ["proxy.requests.detail.cacheRead", tokens.cacheReadTokens],
    ["proxy.requests.detail.cacheCreation", tokens.cacheCreationTokens],
    ["proxy.requests.detail.total", tokens.totalTokens],
  ];
  return (
    <tr className="bg-oai-gray-50 dark:bg-oai-gray-800/40">
      <td colSpan={7} className="px-4 sm:px-12 py-3">
        <dl className="grid grid-cols-2 gap-x-3 sm:gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
          {[
            ["proxy.requests.model", record.model || record.alias],
            ["proxy.requests.response_model", record.response_model],
            ["proxy.requests.provider", record.provider],
          ].map(([key, value]) => <div key={key} className="col-span-2 min-w-0"><dt className="text-oai-gray-500">{copy(key)}</dt><dd className="break-all font-mono">{value || "—"}</dd></div>)}
          {rows.map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-2">
              <dt className="text-oai-gray-500 dark:text-oai-gray-400">{copy(key)}</dt>
              <dd className="font-medium tabular-nums">{value == null ? "—" : fullTokens.format(Number(value) || 0)}</dd>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2">
            <dt className="text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.requests.latency")}</dt>
            <dd className="font-medium tabular-nums">{formatLatency(record.latencyMs)}</dd>
          </div>
          {record.failure_message ? (
            <div className="col-span-2 sm:col-span-4">
              <dt className="text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.requests.detail.failureMessage")}</dt>
              <dd className="mt-0.5 break-words font-mono text-red-600 dark:text-red-400">{record.failure_message}</dd>
            </div>
          ) : null}
        </dl>
      </td>
    </tr>
  );
}

export function RequestsTab() {
  const [records, setRecords] = useState(null);
  const [stats, setStats] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [range, setRange] = useState("24h");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [result, setResult] = useState("all");
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState({ model: "", provider: "" });
  const listId = useId();
  useEffect(() => {
    const timer = setTimeout(() => { setPage(0); setExpanded(null); setQuery((previous) => previous.model === model.trim() && previous.provider === provider.trim() ? previous : { model: model.trim(), provider: provider.trim() }); }, 300);
    return () => clearTimeout(timer);
  }, [model, provider]);
  const searchPending = model.trim() !== query.model || provider.trim() !== query.provider;
  const invalidRange = range === "custom" && (!customStart || !customEnd || !Number.isFinite(Date.parse(customStart)) || !Number.isFinite(Date.parse(customEnd)) || Date.parse(customStart) >= Date.parse(customEnd));
  const filtered = !!model || !!provider || result !== "all" || range !== "24h";
  const clearFilters = () => { setModel(""); setProvider(""); setQuery({ model: "", provider: "" }); setResult("all"); setRange("24h"); setPage(0); setExpanded(null); };
  const pageSize = 50;

  const load = useCallback(async (signal) => {
    if (invalidRange || searchPending) { setLoading(false); return false; }
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        includeStats: "1",
        result,
        ...(query.model ? { model: query.model } : {}),
        ...(query.provider ? { provider: query.provider } : {}),
        ...rangeParams(range, customStart, customEnd),
      });
      const data = await fetch(`/api/proxy/usage/records?${params}`, { cache: "no-store", signal })
        .then((response) => response.json());
      if (signal.aborted) return;
      if (!data?.ok) throw new Error(data?.error || `HTTP records`);
      setRecords(data.records);
      setTotal(data.total);
      setStats(data.stats ?? null);
      setError(null);
      return true;
    } catch (e) {
      if (signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [page, result, query, range, customStart, customEnd, invalidRange, searchPending]);

  const refreshRecords = useVisiblePolling(load, 10_000);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const refresh = async () => {
    if (await refreshRecords()) showToast({ title: copy("proxy.requests.refreshed"), type: "success" });
  };

  const rangeButton = (id) => (
    <button
      key={id}
      type="button"
      onClick={() => {
        setPage(0);
        setRange(id);
      }}
      aria-pressed={range === id}
      className={`shrink-0 rounded-md px-2.5 py-2 sm:py-1 text-xs font-medium transition-colors ${
        range === id
          ? "bg-white dark:bg-oai-gray-900 shadow-oai-sm text-oai-black dark:text-white"
          : "text-oai-gray-500 hover:text-oai-black dark:hover:text-white"
      }`}
    >
      {copy(`proxy.requests.range.${id}`)}
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <span className="min-w-0 flex-1 break-words">{records ? copy("proxy.requests.stale") : error}</span>
          <button type="button" onClick={() => void refresh()} disabled={loading || invalidRange || searchPending} className="shrink-0 font-medium">{copy("shared.action.retry")}</button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <div className="col-span-2 inline-flex w-fit max-w-full overflow-x-auto rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-oai-gray-50 dark:bg-oai-gray-800/60 p-0.5">
          {RANGES.map((entry) => rangeButton(entry.id))}
        </div>
        <input
          aria-label={copy("proxy.requests.filter.model")}
          list={`${listId}-models`}
          value={model}
          onChange={(event) => {
            setModel(event.currentTarget.value);
          }}
          placeholder={copy("proxy.requests.filter.model")}
          className="h-10 sm:h-8 min-w-0 w-full sm:w-40 rounded-lg border border-oai-gray-200 bg-transparent px-2.5 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700"
        />
        <input
          aria-label={copy("proxy.requests.filter.provider")}
          list={`${listId}-providers`}
          value={provider}
          onChange={(event) => {
            setProvider(event.currentTarget.value);
          }}
          placeholder={copy("proxy.requests.filter.provider")}
          className="h-10 sm:h-8 min-w-0 w-full sm:w-36 rounded-lg border border-oai-gray-200 bg-transparent px-2.5 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700"
        />
        <select
          aria-label={copy("proxy.requests.status")}
          value={result}
          onChange={(event) => {
            setPage(0);
            setResult(event.currentTarget.value);
          }}
          className="h-10 sm:h-8 rounded-lg border border-oai-gray-200 bg-transparent px-2 text-sm focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700"
        >
          <option value="all">{copy("proxy.requests.filter.all")}</option>
          <option value="success">{copy("proxy.requests.filter.ok")}</option>
          <option value="failed">{copy("proxy.requests.filter.failed")}</option>
          <option value="canceled">{copy("proxy.requests.canceled")}</option>
        </select>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || invalidRange || searchPending}
          title={copy("proxy.upstream.common.refresh")}
          aria-label={copy("proxy.upstream.common.refresh")}
          className="inline-flex justify-self-end h-10 w-10 sm:h-8 sm:w-8 items-center justify-center rounded-lg border border-oai-gray-200 text-oai-gray-500 hover:bg-oai-gray-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} />
        </button>
      </div>

      <datalist id={`${listId}-models`}>{(stats?.models ?? []).map((item) => <option key={item.model} value={item.model} />)}</datalist>
      <datalist id={`${listId}-providers`}>{(stats?.providers ?? []).map((item) => <option key={item.provider} value={item.provider} />)}</datalist>
      <div className="flex items-center justify-between gap-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">
        <span role="status">{loading || searchPending ? copy("proxy.loading") : copy("proxy.requests.count", { count: fullTokens.format(total) })}</span>
        {filtered ? <button type="button" className="min-h-10 px-2 font-medium text-oai-brand-600 dark:text-oai-brand-400 sm:min-h-0" onClick={clearFilters}>{copy("proxy.requests.clear_filters")}</button> : null}
      </div>
      {range === "custom" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.requests.range.start")}</span>
            <input
              type="datetime-local"
              value={customStart}
              onChange={(event) => {
                setPage(0);
                setCustomStart(event.currentTarget.value);
              }}
              className="h-10 sm:h-8 rounded-lg border border-oai-gray-200 bg-transparent px-2 text-xs dark:border-oai-gray-700"
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.requests.range.end")}</span>
            <input
              type="datetime-local"
              value={customEnd}
              onChange={(event) => {
                setPage(0);
                setCustomEnd(event.currentTarget.value);
              }}
              className="h-10 sm:h-8 rounded-lg border border-oai-gray-200 bg-transparent px-2 text-xs dark:border-oai-gray-700"
            />
          </label>
        </div>
      ) : null}

      {invalidRange ? <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{copy("proxy.requests.range.invalid")}</p> : null}
      {stats ? (
        <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
          <StatTile label={copy("proxy.metric.requests")} value={fullTokens.format(stats.total_requests)} />
          <StatTile label={copy("proxy.requests.filter.ok")} value={fullTokens.format(stats.success_count)} tone="text-emerald-600 dark:text-emerald-400" />
          <StatTile label={copy("proxy.requests.filter.failed")} value={fullTokens.format(stats.failure_count)} tone="text-red-600 dark:text-red-400" />
          <StatTile label={copy("proxy.requests.canceled")} value={fullTokens.format(stats.canceled_count)} />
          <StatTile label={copy("proxy.requests.tokens")} value={formatTokens(stats.total_tokens)} />
          <StatTile
            label={copy("proxy.metric.top_model")}
            value={stats.models?.[0]?.model || "—"}
          />
        </div>
      ) : null}

      <Card className="overflow-hidden" bodyClassName="!p-0">
        {records === null ? (
          <div className="px-5 py-8 text-center text-sm text-oai-gray-400">{error || (invalidRange ? copy("proxy.requests.range.invalid") : copy("proxy.loading"))}</div>
        ) : records.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Zap className="mx-auto h-8 w-8 text-oai-gray-300 dark:text-oai-gray-600" />
            <p className="mt-3 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy(filtered ? "proxy.requests.no_matches" : "proxy.requests.empty")}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed sm:table-auto text-sm">
              <thead>
                <tr className="border-b border-oai-gray-200 dark:border-oai-gray-800 text-left">
                  <th className="w-10 sm:w-8 px-1 py-3" aria-label={copy("proxy.requests.detail.title")} />
                  <th className="hidden sm:table-cell px-2 py-3 text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.time")}
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.model")}
                  </th>
                  <th className="hidden sm:table-cell px-4 py-3 text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.response_model")}
                  </th>
                  <th className="hidden sm:table-cell px-4 py-3 text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.provider")}
                  </th>
                  <th className="w-16 sm:w-auto px-1 sm:px-4 py-3 text-right text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.tokens")}
                  </th>
                  <th className="w-[4.5rem] sm:w-auto px-1 sm:px-5 py-3 text-right text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                    {copy("proxy.requests.status")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
                {records.map((record, index) => {
                  const key = record.id ?? `${record.timestamp}-${index}`;
                  const open = expanded === key;
                  return (
                    <React.Fragment key={key}>
                      <tr
                        className={`cursor-pointer hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/50 ${open ? "bg-oai-gray-50 dark:bg-oai-gray-800/40" : ""}`}
                        onClick={() => setExpanded(open ? null : key)}
                        aria-expanded={open}
                      >
                        <td className="p-0 text-oai-gray-400">
                          <button type="button" aria-label={copy("proxy.requests.detail.title")} aria-expanded={open}
                            onClick={(event) => { event.stopPropagation(); setExpanded(open ? null : key); }}
                            className="flex h-10 w-10 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500">
                            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                        </td>
                        <td className="hidden sm:table-cell whitespace-nowrap px-2 py-2.5 tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
                          {formatTime(record.timestamp)}
                        </td>
                        <td className="max-w-[200px] px-1 sm:px-4 py-2.5 font-mono text-xs">
                          <span className="block truncate" title={record.model || record.alias}>{record.model || record.alias || "—"}</span>
                          <span className="mt-1 block text-[10px] tabular-nums text-oai-gray-500 sm:hidden">{formatTime(record.timestamp)}</span>
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
                              className={`hidden sm:table-cell max-w-[200px] truncate px-4 py-2.5 font-mono text-xs ${
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
                        <td className="hidden sm:table-cell px-4 py-2.5 capitalize text-oai-gray-600 dark:text-oai-gray-300">
                          {record.provider || "—"}
                        </td>
                        <td className="whitespace-nowrap px-1 sm:px-4 py-2.5 text-right tabular-nums">
                          {formatTokens(record.tokens?.totalTokens ?? 0)}
                        </td>
                        <td className="px-1 sm:px-5 py-2.5 text-right break-words">
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
                      {open ? <RecordDetail record={record} /> : null}
                    </React.Fragment>
                  );
                })}
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
              className="min-h-10 rounded-md px-2 py-1 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-40"
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
              className="min-h-10 rounded-md px-2 py-1 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-40"
            >
              {copy("proxy.requests.next")} →
            </button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
