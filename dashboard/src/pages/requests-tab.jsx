import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Brain, ChevronLeft, ChevronRight, Columns3, Database, Download, RefreshCw, RotateCcw, Settings2, TriangleAlert, Zap } from "lucide-react";
import { copy } from "../lib/copy";
import { formatCostUsd } from "../lib/cost-format";
import { Card } from "../ui/components";
import { UsageHeatmap } from "./usage-heatmap";
import { ModalFrame } from "../ui/components/ModalFrame";
import { showToast } from "../ui/components/Toast";
import { useVisiblePolling } from "../hooks/use-visible-polling";
import { sendBudgetAlerts } from "../lib/budget-alerts";
import { getLocalApiAuthHeaders } from "../lib/local-api-auth";
import {
  managementApi,
  effectiveProviderKey,
  providerGroupKeys,
  providerGroupsApi,
  providerHeadersFromRecord,
  providerLoadDefinitions,
  providerModelType,
  replayRecordViaCore,
  rowFromRecord,
} from "../lib/easy-providers";

// ---------------------------------------------------------------------------
// Requests tab (请求记录) — interaction ported from EasyCLIProxyAPI's
// UsageEventsView (d5c82f8) onto the local usage store: a compact per-request
// event log with grouped token/cache/latency cells, resizable + hideable
// columns, top scrollbar sync, footer pagination with a page-size selector and
// per-page CSV export. Column layout persists in localStorage.
// ---------------------------------------------------------------------------

const compactTokens = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fullTokens = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function formatTokens(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return compactTokens.format(value);
}

function formatCount(value) {
  return fullTokens.format(Number(value) || 0);
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}

// easy c24bb15: tint a duration green below 15s, amber below 30s, red beyond —
// slow upstreams surface at a glance without reading the numbers.
function durationTone(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms >= 30_000) return "text-red-600 dark:text-red-400";
  if (ms >= 15_000) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

function formatSpeed(outputTokens, latencyMs) {
  if (!Number.isFinite(outputTokens) || !Number.isFinite(latencyMs) || outputTokens <= 0 || latencyMs <= 0) return "—";
  const speed = outputTokens / (latencyMs / 1000);
  return Number.isFinite(speed) && speed > 0 ? `${speed.toFixed(1)} t/s` : "—";
}

function formatCacheRate(inputTokens, cacheReadTokens) {
  if (!Number.isFinite(inputTokens) || inputTokens <= 0 || !Number.isFinite(cacheReadTokens) || cacheReadTokens <= 0) return "—";
  return `${(Math.min(cacheReadTokens, inputTokens) / inputTokens * 100).toFixed(2)}%`;
}

function formatClock(timestamp) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return String(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatDay(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" });
}

// ---------------------------------------------------------------------------
// Event columns
// ---------------------------------------------------------------------------

const EVENT_COLUMNS = [
  { key: "time", labelKey: "proxy.requests.time", defaultWidth: 96, minWidth: 76 },
  { key: "key", labelKey: "proxy.requests.col.key", defaultWidth: 124, minWidth: 96 },
  { key: "source", labelKey: "proxy.requests.col.source", defaultWidth: 150, minWidth: 110 },
  { key: "model", labelKey: "proxy.requests.model", defaultWidth: 168, minWidth: 110 },
  { key: "effort", labelKey: "proxy.requests.col.effort", defaultWidth: 78, minWidth: 64 },
  { key: "result", labelKey: "proxy.requests.status", defaultWidth: 96, minWidth: 72 },
  { key: "request", labelKey: "proxy.requests.col.request", defaultWidth: 112, minWidth: 88 },
  { key: "latency", labelKey: "proxy.requests.latency", defaultWidth: 116, minWidth: 96, align: "center" },
  { key: "speed", labelKey: "proxy.requests.col.speed", defaultWidth: 88, minWidth: 72 },
  { key: "total", labelKey: "proxy.requests.tokens", defaultWidth: 148, minWidth: 116 },
  { key: "cache", labelKey: "proxy.requests.col.cache", defaultWidth: 132, minWidth: 100 },
  { key: "cost", labelKey: "proxy.requests.col.cost", defaultWidth: 96, minWidth: 72 },
  { key: "provider", labelKey: "proxy.requests.provider", defaultWidth: 110, minWidth: 88 },
  { key: "input", labelKey: "proxy.requests.detail.input", defaultWidth: 84, minWidth: 60 },
  { key: "output", labelKey: "proxy.requests.detail.output", defaultWidth: 84, minWidth: 60 },
  { key: "reasoning", labelKey: "proxy.requests.detail.reasoning", defaultWidth: 84, minWidth: 60 },
  { key: "cacheRate", labelKey: "proxy.requests.col.cacheRate", defaultWidth: 92, minWidth: 72 },
  { key: "ttft", labelKey: "proxy.requests.col.ttft", defaultWidth: 92, minWidth: 76, align: "center" },
  { key: "replay", labelKey: "proxy.requests.col.replay", defaultWidth: 96, minWidth: 76 },
];

const DEFAULT_VISIBLE_COLUMNS = [
  "time", "key", "source", "model", "result", "request", "latency", "speed", "total", "cache", "cost", "provider", "replay",
];

// Defaults before the cost column joined. Seeds the migration marker so only
// newly-added defaults one-time-merge into a saved layout — columns the user
// deliberately hid (from the old defaults) stay hidden.
const PREVIOUS_DEFAULT_VISIBLE_COLUMNS = [
  "time", "key", "source", "model", "result", "request", "latency", "speed", "total", "cache", "provider",
];

const WIDTHS_STORAGE_KEY = "aitool.usage-events-col-widths.v1";
const VISIBLE_STORAGE_KEY = "aitool.usage-events-visible-cols.v1";
// Defaults already offered to the saved layout; lets later-added columns (e.g.
// cost) start visible once without re-appearing after the user hides them.
const MIGRATED_DEFAULTS_STORAGE_KEY = "aitool.usage-events-migrated-defaults.v1";
const MAX_COLUMN_WIDTH = 800;

// Display density (easy 1d64a45): a fixed row height turns the log into a
// uniform grid for scanning; off keeps rows auto-sized around their content.
const ROW_HEIGHT_ENABLED_STORAGE_KEY = "aitool.usage-events-row-height-enabled.v1";
const ROW_HEIGHT_STORAGE_KEY = "aitool.usage-events-row-height.v1";
const DEFAULT_ROW_HEIGHT = 68;
const MIN_ROW_HEIGHT = 48;
const MAX_ROW_HEIGHT = 140;

const PAGE_SIZE_STORAGE_KEY = "aitool.usage-events-page-size.v1";
const PAGE_SIZES = [20, 50, 100, 200];

const clampRowHeight = (value) => Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, Math.round(value)));

function loadRowHeightEnabled() {
  try { return localStorage.getItem(ROW_HEIGHT_ENABLED_STORAGE_KEY) === "true"; } catch { return false; }
}

function loadRowHeight() {
  try {
    const value = Number(localStorage.getItem(ROW_HEIGHT_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? clampRowHeight(value) : DEFAULT_ROW_HEIGHT;
  } catch { return DEFAULT_ROW_HEIGHT; }
}

function loadPageSize() {
  try {
    const value = Number(localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    return PAGE_SIZES.includes(value) ? value : 50;
  } catch { return 50; }
}

const allColumnKeys = () => EVENT_COLUMNS.map((column) => column.key);

function persistMigratedDefaults(keys) {
  try { localStorage.setItem(MIGRATED_DEFAULTS_STORAGE_KEY, JSON.stringify([...new Set(keys)])); } catch {}
}

function loadVisibleColumns() {
  try {
    const raw = localStorage.getItem(VISIBLE_STORAGE_KEY);
    if (!raw) {
      persistMigratedDefaults(DEFAULT_VISIBLE_COLUMNS);
      return [...DEFAULT_VISIBLE_COLUMNS];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      persistMigratedDefaults(DEFAULT_VISIBLE_COLUMNS);
      return [...DEFAULT_VISIBLE_COLUMNS];
    }
    const known = new Set(allColumnKeys());
    const saved = [...new Set(parsed)].filter((key) => typeof key === "string" && known.has(key));
    if (saved.length === 0) {
      persistMigratedDefaults(DEFAULT_VISIBLE_COLUMNS);
      return [...DEFAULT_VISIBLE_COLUMNS];
    }
    let migrated = null;
    try { migrated = JSON.parse(localStorage.getItem(MIGRATED_DEFAULTS_STORAGE_KEY) || "null"); } catch {}
    const migratedSet = new Set(Array.isArray(migrated) && migrated.length > 0 ? migrated : PREVIOUS_DEFAULT_VISIBLE_COLUMNS);
    for (const key of DEFAULT_VISIBLE_COLUMNS) {
      if (!migratedSet.has(key) && !saved.includes(key)) saved.push(key);
    }
    persistMigratedDefaults([...DEFAULT_VISIBLE_COLUMNS, ...migratedSet]);
    return saved;
  } catch {
    return [...DEFAULT_VISIBLE_COLUMNS];
  }
}

function loadColumnWidths() {
  const defaults = {};
  for (const column of EVENT_COLUMNS) defaults[column.key] = column.defaultWidth;
  try {
    const raw = localStorage.getItem(WIDTHS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaults;
    for (const column of EVENT_COLUMNS) {
      const value = Number(parsed[column.key]);
      if (Number.isFinite(value) && value >= column.minWidth) {
        defaults[column.key] = Math.min(MAX_COLUMN_WIDTH, Math.round(value));
      }
    }
  } catch {}
  return defaults;
}

// ---------------------------------------------------------------------------
// Horizontal scrollbar synced with the table below it (easy's TableTopScrollbar)
// ---------------------------------------------------------------------------

function TableTopScrollbar({ tableWrapRef }) {
  const scrollbarRef = useRef(null);
  const trackRef = useRef(null);

  useEffect(() => {
    const scrollbar = scrollbarRef.current;
    const track = trackRef.current;
    const tableWrap = tableWrapRef.current;
    if (!scrollbar || !track || !tableWrap) return;

    // Remember applied positions instead of locking a whole frame so delayed
    // programmatic scrolls don't drop newer drag input on either surface.
    let lastScrollbarLeft = scrollbar.scrollLeft;
    let lastTableLeft = tableWrap.scrollLeft;

    const syncTable = () => {
      const left = scrollbar.scrollLeft;
      if (left === lastScrollbarLeft) return;
      lastScrollbarLeft = left;
      tableWrap.scrollLeft = left;
      lastTableLeft = tableWrap.scrollLeft;
    };
    const syncScrollbar = () => {
      const left = tableWrap.scrollLeft;
      if (left === lastTableLeft) return;
      lastTableLeft = left;
      scrollbar.scrollLeft = left;
      lastScrollbarLeft = scrollbar.scrollLeft;
    };
    const updateLayout = () => {
      const clientWidth = tableWrap.clientWidth;
      const maxScroll = Math.max(0, tableWrap.scrollWidth - clientWidth);
      const left = Math.min(tableWrap.scrollLeft, maxScroll);
      scrollbar.classList.toggle("hidden", maxScroll <= 1);
      track.style.width = `${(scrollbar.clientWidth || clientWidth) + maxScroll}px`;
      tableWrap.scrollLeft = left;
      scrollbar.scrollLeft = left;
      lastTableLeft = tableWrap.scrollLeft;
      lastScrollbarLeft = scrollbar.scrollLeft;
    };

    updateLayout();
    scrollbar.addEventListener("scroll", syncTable, { passive: true });
    tableWrap.addEventListener("scroll", syncScrollbar, { passive: true });
    const observer = new ResizeObserver(updateLayout);
    observer.observe(tableWrap);
    observer.observe(scrollbar);
    if (tableWrap.firstElementChild) observer.observe(tableWrap.firstElementChild);
    return () => {
      scrollbar.removeEventListener("scroll", syncTable);
      tableWrap.removeEventListener("scroll", syncScrollbar);
      observer.disconnect();
    };
  }, [tableWrapRef]);

  return (
    <div ref={scrollbarRef} aria-hidden="true" className="overflow-x-auto overflow-y-hidden">
      <div ref={trackRef} style={{ height: "1px" }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

function MetricRow({ icon: Icon, tone, title, label, value }) {
  return (
    <span className={`inline-flex max-w-full items-center gap-1 text-[11px] tabular-nums ${tone}`} title={title}>
      <Icon size={11} aria-hidden="true" className="shrink-0" />
      <span className="truncate">{formatTokens(value)}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

// Per-record one-click retest: rebuilds a minimal same-protocol request and
// sends it through the core's api-call with the record's auth index. The row
// shows the upstream status + latency; the body excerpt rides on the title.
function ReplayCell({ record, onReplay, state }) {
  const eligible = Boolean((record.id ?? record.request_id)
    && String(record.auth_index || record.authIndex || "").trim()
    && String(record.response_model || record.model || "").trim());
  if (!eligible) return <td className="px-2 py-2" />;
  const running = state?.status === "running";
  const title = running
    ? copy("proxy.requests.replay.running")
    : state?.status === "done"
      ? `${copy("proxy.requests.replay.result", { status: state.statusCode ?? "?" })} ${state.bodyExcerpt || ""}`.trim()
      : state?.status === "error"
        ? `${copy("proxy.requests.replay.failed")}: ${state.error || ""}`
        : copy("proxy.requests.replay.action");
  return (
    <td className="px-2 py-2 align-top">
      {running ? (
        <span className="inline-flex items-center gap-1 text-xs text-oai-gray-400" role="status">
          <RefreshCw size={11} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {copy("proxy.requests.replay.running")}
        </span>
      ) : state?.status === "done" ? (
        <span
          className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
            (state.statusCode ?? 0) >= 200 && (state.statusCode ?? 0) < 300
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400"
          }`}
          title={title}
        >
          {state.statusCode ?? "?"} · {(state.latencyMs / 1000).toFixed(1)}s
        </span>
      ) : state?.status === "error" ? (
        <span className="inline-flex items-center rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:bg-red-950/40 dark:text-red-400" title={title}>
          {copy("proxy.requests.replay.failed")}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onReplay(record)}
          title={title}
          aria-label={copy("proxy.requests.replay.action")}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-gray-600 dark:hover:bg-oai-gray-800 dark:hover:text-oai-gray-300"
        >
          <Zap size={10} aria-hidden="true" />
          {copy("proxy.requests.replay.action")}
        </button>
      )}
    </td>
  );
}

function EventCell({ record, column, onReplay, replayState, showDate }) {
  const tokens = record.tokens ?? {};
  switch (column.key) {
    case "time":
      return (
        <td className="px-2 py-2 align-top" title={record.timestamp || undefined}>
          <span className="block whitespace-nowrap font-medium tabular-nums">{formatClock(record.timestamp)}</span>
          {showDate === false ? null : (
            <span className="block whitespace-nowrap text-[10px] tabular-nums text-oai-gray-500 dark:text-oai-gray-400">{formatDay(record.timestamp)}</span>
          )}
        </td>
      );
    case "key":
      return (
        <td className="max-w-0 px-2 py-2 align-top">
          <span className="block truncate font-mono text-xs" title={record.api_key_display || undefined}>{record.api_key_display || "—"}</span>
          {record.api_key_hash ? (
            <span className="block truncate font-mono text-[10px] text-oai-gray-500 dark:text-oai-gray-400" title={record.api_key_hash}>{record.api_key_hash.slice(0, 12)}</span>
          ) : null}
        </td>
      );
    case "source":
      return (
        <td className="max-w-0 px-2 py-2 align-top" title={record.source || undefined}>
          <span className="inline-flex max-w-full items-center gap-1 text-xs">
            <Zap size={11} aria-hidden="true" className="shrink-0 text-oai-gray-400" />
            <span className="truncate">{record.source || "—"}</span>
          </span>
        </td>
      );
    case "model": {
      const requested = record.model || record.alias || "—";
      const responseModel = String(record.response_model || "").trim();
      const substituted = responseModel !== "" && responseModel !== requested;
      return (
        <td className="max-w-0 px-2 py-2 align-top font-mono text-xs">
          <span className="block truncate" title={requested}>{requested}</span>
          {substituted ? (
            <span className="mt-0.5 block truncate rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" title={copy("proxy.requests.substituted_hint")}>
              {responseModel}
            </span>
          ) : record.alias && record.alias !== record.model ? (
            <span className="mt-0.5 block truncate text-[10px] text-oai-gray-500 dark:text-oai-gray-400" title={record.model}>{record.model}</span>
          ) : null}
        </td>
      );
    }
    case "effort":
      return (
        <td className="max-w-0 px-2 py-2 align-top text-xs" title={record.reasoning_effort || "auto"}>
          <span className="block truncate">{record.reasoning_effort || "auto"}</span>
        </td>
      );
    case "request":
      return (
        <td className="max-w-0 px-2 py-2 align-top font-mono text-xs" title={record.endpoint || undefined}>
          <span className="block truncate">{record.endpoint || "—"}</span>
        </td>
      );
    case "provider":
      return (
        <td className="max-w-0 px-2 py-2 align-top" title={record.provider || undefined}>
          <span className="inline-block max-w-full truncate rounded-md bg-oai-gray-100 px-1.5 py-0.5 text-xs dark:bg-oai-gray-800">{record.provider || "—"}</span>
        </td>
      );
    case "result": {
      const state = record.canceled ? "canceled" : record.failed ? "failed" : "success";
      const detail = [record.failure_status > 0 ? `HTTP ${record.failure_status}` : "", String(record.failure_body || "").trim()].filter(Boolean).join(" · ");
      const label = state === "canceled" ? copy("proxy.requests.canceled") : state === "failed" ? (record.failure_status ? `HTTP ${record.failure_status}` : copy("proxy.requests.failed")) : copy("proxy.requests.ok");
      const tone = state === "failed"
        ? "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400"
        : state === "canceled"
          ? "bg-oai-gray-100 text-oai-gray-500 dark:bg-oai-gray-800 dark:text-oai-gray-400"
          : "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400";
      return (
        <td className="max-w-0 px-2 py-2 align-top" title={detail || label}>
          <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${tone}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${state === "failed" ? "bg-red-500" : state === "canceled" ? "bg-oai-gray-400" : "bg-emerald-500"}`} />
            <span className="truncate">{label}</span>
          </span>
          {state === "failed" && detail ? <span className="mt-0.5 block truncate text-[10px] text-oai-gray-500 dark:text-oai-gray-400" title={detail}>{detail}</span> : null}
        </td>
      );
    }
    case "latency": {
      const latencyTone = durationTone(record.latencyMs);
      const ttftTone = durationTone(record.ttftMs);
      return (
        <td className={`px-2 py-2 align-top ${column.align === "center" ? "text-center" : ""}`} title={`${record.latencyMs ?? 0} ms`}>
          <span className={`inline-block whitespace-nowrap text-xs font-medium tabular-nums ${latencyTone}`}>{formatDuration(record.latencyMs)}</span>
          <span
            className={`block whitespace-nowrap text-[10px] tabular-nums ${ttftTone || "text-oai-gray-500 dark:text-oai-gray-400"}`}
            title={record.ttftMs != null ? `${record.ttftMs} ms` : undefined}
          >
            TTFT {record.ttftMs == null ? "—" : formatDuration(record.ttftMs)}
          </span>
        </td>
      );
    }
    case "ttft":
      return (
        <td className={`px-2 py-2 align-top text-xs tabular-nums ${column.align === "center" ? "text-center" : ""} ${durationTone(record.ttftMs)}`} title={record.ttftMs != null ? `${record.ttftMs} ms` : undefined}>
          {record.ttftMs == null ? "—" : formatDuration(record.ttftMs)}
        </td>
      );
    case "speed":
      return (
        <td className="px-2 py-2 align-top text-xs tabular-nums" title={formatSpeed(tokens.outputTokens, record.latencyMs)}>
          {formatSpeed(tokens.outputTokens, record.latencyMs)}
        </td>
      );
    case "cacheRate":
      return (
        <td className="px-2 py-2 align-top text-xs tabular-nums" title={formatCacheRate(tokens.inputTokens, tokens.cacheReadTokens)}>
          {formatCacheRate(tokens.inputTokens, tokens.cacheReadTokens)}
        </td>
      );
    case "total":
      return (
        <td className="px-2 py-2 align-top" title={`${formatCount(tokens.totalTokens)} tokens`}>
          <span className="block text-xs font-semibold tabular-nums">{formatTokens(tokens.totalTokens)}</span>
          <span className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
            <MetricRow icon={ArrowUp} tone="text-oai-gray-500 dark:text-oai-gray-400" title={`${copy("proxy.requests.detail.input")}: ${formatCount(tokens.inputTokens)}`} label={copy("proxy.requests.detail.input")} value={tokens.inputTokens} />
            <MetricRow icon={ArrowDown} tone="text-oai-gray-500 dark:text-oai-gray-400" title={`${copy("proxy.requests.detail.output")}: ${formatCount(tokens.outputTokens)}`} label={copy("proxy.requests.detail.output")} value={tokens.outputTokens} />
            {tokens.reasoningTokens > 0 ? (
              <MetricRow icon={Brain} tone="text-violet-600 dark:text-violet-400" title={`${copy("proxy.requests.detail.reasoning")}: ${formatCount(tokens.reasoningTokens)}`} label={copy("proxy.requests.detail.reasoning")} value={tokens.reasoningTokens} />
            ) : null}
          </span>
        </td>
      );
    case "cache":
      return (
        <td className="px-2 py-2 align-top" title={`${copy("proxy.requests.detail.cacheRead")}: ${formatCount(tokens.cacheReadTokens)} / ${copy("proxy.requests.detail.cacheCreation")}: ${formatCount(tokens.cacheCreationTokens)}`}>
          <span className="block text-xs font-semibold tabular-nums">{formatCacheRate(tokens.inputTokens, tokens.cacheReadTokens)}</span>
          <span className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
            <MetricRow icon={Database} tone="text-sky-600 dark:text-sky-400" title={`${copy("proxy.requests.detail.cacheRead")}: ${formatCount(tokens.cacheReadTokens)}`} label={copy("proxy.requests.detail.cacheRead")} value={tokens.cacheReadTokens} />
            {tokens.cacheCreationTokens > 0 ? (
              <MetricRow icon={Database} tone="text-amber-600 dark:text-amber-400" title={`${copy("proxy.requests.detail.cacheCreation")}: ${formatCount(tokens.cacheCreationTokens)}`} label={copy("proxy.requests.detail.cacheCreation")} value={tokens.cacheCreationTokens} />
            ) : null}
          </span>
        </td>
      );
    case "cost": {
      const costText = formatCostUsd(record.costUsd) ?? "—";
      return (
        <td className="px-2 py-2 align-top text-xs tabular-nums" title={record.costUsd != null ? `$${record.costUsd.toFixed(6)}` : undefined}>
          {costText}
        </td>
      );
    }
    case "input":
      return <td className="px-2 py-2 align-top text-xs tabular-nums" title={`${formatCount(tokens.inputTokens)} tokens`}>{formatTokens(tokens.inputTokens)}</td>;
    case "output":
      return <td className="px-2 py-2 align-top text-xs tabular-nums" title={`${formatCount(tokens.outputTokens)} tokens`}>{formatTokens(tokens.outputTokens)}</td>;
    case "reasoning":
      return <td className="px-2 py-2 align-top text-xs tabular-nums" title={`${formatCount(tokens.reasoningTokens)} tokens`}>{formatTokens(tokens.reasoningTokens)}</td>;
    case "replay":
      return <ReplayCell record={record} onReplay={onReplay} state={replayState} />;
    default:
      return <td className="px-2 py-2" />;
  }
}

// ---------------------------------------------------------------------------
// Column settings dialog
// ---------------------------------------------------------------------------

function ColumnSettingsDialog({ open, onClose, draft, onToggle, onSelectAll, onApply, draftRowHeightEnabled, onRowHeightToggle, draftRowHeight, onRowHeightChange }) {
  return (
    <ModalFrame open={open} onClose={onClose} label={copy("proxy.requests.col_settings")}>
      <div className="flex items-center justify-between border-b border-oai-gray-100 px-5 py-3.5 dark:border-oai-gray-800">
        <h2 className="text-sm font-semibold">{copy("proxy.requests.col_settings")}</h2>
        <button type="button" onClick={onClose} aria-label={copy("proxy.upstream.common.close")} className="rounded-lg p-1.5 text-oai-gray-500 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800">
          <span aria-hidden="true" className="text-base leading-none">×</span>
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 overflow-y-auto px-5 py-4 sm:grid-cols-3">
        {EVENT_COLUMNS.map((column) => {
          const checked = draft.includes(column.key);
          return (
            <label key={column.key} className="flex min-h-8 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={checked}
                disabled={checked && draft.length === 1}
                onChange={() => onToggle(column.key)}
                className="h-4 w-4 accent-oai-brand-600"
              />
              <span className="truncate">{copy(column.labelKey)}</span>
            </label>
          );
        })}
      </div>
      <div className="border-t border-oai-gray-100 px-5 py-4 dark:border-oai-gray-800">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{copy("proxy.requests.row_height.title")}</p>
            <p className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.requests.row_height.description")}</p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draftRowHeightEnabled}
              onChange={() => onRowHeightToggle()}
              aria-label={copy("proxy.requests.row_height.title")}
              className="h-4 w-4 accent-oai-brand-600"
            />
            {copy(draftRowHeightEnabled ? "proxy.requests.row_height.on" : "proxy.requests.row_height.off")}
          </label>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <input
            type="range"
            min={MIN_ROW_HEIGHT}
            max={MAX_ROW_HEIGHT}
            step={1}
            value={draftRowHeight}
            disabled={!draftRowHeightEnabled}
            onChange={(event) => onRowHeightChange(Number(event.currentTarget.value))}
            aria-label={copy("proxy.requests.row_height.slider")}
            className="h-1.5 min-w-0 flex-1 accent-oai-brand-600 disabled:opacity-40"
          />
          <output className="w-12 shrink-0 text-right text-xs tabular-nums">{draftRowHeight}px</output>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-oai-gray-100 px-5 py-3 text-xs text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400">
        <span>{copy("proxy.requests.col_selected", { selected: draft.length, total: EVENT_COLUMNS.length })}</span>
        <button type="button" onClick={onSelectAll} className="min-h-10 px-2 font-medium text-oai-brand-600 sm:min-h-0 dark:text-oai-brand-400">{copy("proxy.requests.col_select_all")}</button>
      </div>
      <div className="flex justify-end gap-2 border-t border-oai-gray-100 px-5 py-3 dark:border-oai-gray-800">
        <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-oai-gray-200 px-3 text-sm font-medium hover:bg-oai-gray-50 sm:min-h-0 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800">{copy("shared.action.cancel")}</button>
        <button type="button" onClick={onApply} className="min-h-10 rounded-lg bg-oai-black px-3 text-sm font-medium text-white hover:bg-oai-gray-800 sm:min-h-0 dark:bg-white dark:text-oai-black dark:hover:bg-oai-gray-200">{copy("shared.action.apply")}</button>
      </div>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------------------
// Main tab
// ---------------------------------------------------------------------------

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

function exportCsv(records, page) {
  const headers = ["id", "request_id", "timestamp", "api_key_display", "api_key_hash", "source", "provider", "model", "alias", "response_model", "reasoning_effort", "endpoint", "failed", "canceled", "failure_status", "failure_body", "latency_ms", "ttft_ms", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_creation_tokens", "total_tokens", "estimated_cost_usd"];
  const cell = (value) => {
    const text = value == null ? "" : String(value);
    // Guard against CSV injection the same way the upstream port does.
    const safe = /^[\s\0]*[=+@-]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = records.map((record) => [
    record.id, record.request_id, record.timestamp, record.api_key_display, record.api_key_hash,
    record.source, record.provider, record.model, record.alias, record.response_model,
    record.reasoning_effort, record.endpoint, record.failed, record.canceled,
    record.failure_status, record.failure_body, record.latencyMs, record.ttftMs,
    record.tokens?.inputTokens, record.tokens?.outputTokens, record.tokens?.reasoningTokens,
    record.tokens?.cacheReadTokens, record.tokens?.cacheCreationTokens, record.tokens?.totalTokens,
    record.costUsd,
  ]);
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `usage-events-page-${page + 1}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function BudgetEditDialog({ draft, setDraft, saving, onClose, onSave }) {
  // Read currentTarget synchronously — React nulls it before a setState
  // updater runs, and StrictMode replays updaters.
  const field = (key) => ({
    value: draft[key],
    onChange: (event) => {
      const { value } = event.currentTarget;
      setDraft((current) => ({ ...current, [key]: value }));
    },
    inputMode: "decimal",
    "aria-label": copy(`budget.edit.${key === "daily" ? "daily" : key === "monthly" ? "monthly" : "threshold"}`),
    className: "h-10 w-32 rounded-lg border border-oai-gray-200 bg-transparent px-2 text-sm tabular-nums dark:border-oai-gray-700",
  });
  return (
    <ModalFrame open onClose={onClose} label={copy("budget.edit.title")}>
      <div className="flex items-center justify-between border-b border-oai-gray-100 px-5 py-3.5 dark:border-oai-gray-800">
        <h2 className="text-sm font-semibold">{copy("budget.edit.title")}</h2>
        <button type="button" onClick={onClose} aria-label={copy("proxy.upstream.common.close")} className="rounded-lg p-1.5 text-oai-gray-500 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800">
          <span aria-hidden="true" className="text-base leading-none">×</span>
        </button>
      </div>
      <div className="space-y-3 px-5 py-4 text-sm">
        <label className="flex min-h-8 items-center gap-2">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => {
              const { checked } = event.currentTarget;
              setDraft((current) => ({ ...current, enabled: checked }));
            }}
            className="h-4 w-4 accent-oai-brand-600"
          />
          {copy("budget.edit.enable")}
        </label>
        <div className="flex items-center justify-between gap-4">
          <span>{copy("budget.edit.daily")}</span>
          <input {...field("daily")} />
        </div>
        <div className="flex items-center justify-between gap-4">
          <span>{copy("budget.edit.monthly")}</span>
          <input {...field("monthly")} />
        </div>
        <div className="flex items-center justify-between gap-4">
          <span>{copy("budget.edit.threshold")}</span>
          <input {...field("threshold")} />
        </div>
        <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("budget.edit.hint")}</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-oai-gray-100 px-5 py-3 dark:border-oai-gray-800">
        <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-oai-gray-200 px-3 font-medium hover:bg-oai-gray-50 sm:min-h-0 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800">{copy("shared.action.cancel")}</button>
        <button type="button" onClick={onSave} disabled={saving} className="min-h-10 rounded-lg bg-oai-black px-3 font-medium text-white hover:bg-oai-gray-800 disabled:opacity-50 sm:min-h-0 dark:bg-white dark:text-oai-black dark:hover:bg-oai-gray-200">{copy("shared.action.save")}</button>
      </div>
    </ModalFrame>
  );
}

// Budget + burn-rate strip: polls /api/proxy/budget (60s), surfaces threshold
// alerts as a banner and native/web notifications, and edits the budget
// settings persisted in the proxy settings.json.
function BudgetBar() {
  const [budget, setBudget] = useState(null);
  const [pricingAvailable, setPricingAvailable] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (signal) => {
    try {
      const data = await fetch("/api/proxy/budget", { cache: "no-store", signal }).then((response) => response.json());
      if (signal.aborted) return true;
      if (data?.ok) {
        setBudget(data.budget);
        setPricingAvailable(data.pricingAvailable !== false);
        sendBudgetAlerts(data.budget);
      }
    } catch { /* offline or server restarting; the poll retries */ }
    return true;
  }, []);
  const refreshBudget = useVisiblePolling(load, 60_000);

  const openEdit = () => {
    const source = budget?.budgets ?? {};
    setDraft({
      enabled: source.enabled === true,
      daily: source.dailyLimitUsd ? String(source.dailyLimitUsd) : "",
      monthly: source.monthlyLimitUsd ? String(source.monthlyLimitUsd) : "",
      threshold: String(source.alertThresholdPct || 80),
    });
    setEditOpen(true);
  };

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const headers = await getLocalApiAuthHeaders();
      const response = await fetch("/api/proxy/budget", {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          budgets: {
            enabled: draft.enabled,
            dailyLimitUsd: Number(draft.daily) || 0,
            monthlyLimitUsd: Number(draft.monthly) || 0,
            alertThresholdPct: Number(draft.threshold) || 80,
          },
        }),
      });
      const data = await response.json().catch(() => null);
      if (!data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      showToast({ title: copy("budget.saved"), type: "success" });
      setEditOpen(false);
      refreshBudget();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      showToast({ title: `${copy("budget.save_failed")}: ${detail}`, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const config = budget?.budgets ?? null;
  const windows = config?.enabled && budget
    ? [budget.daily && { which: "daily", ...budget.daily }, budget.monthly && { which: "monthly", ...budget.monthly }].filter(Boolean)
    : [];
  const alerted = windows.filter((entry) => entry.level === "warning" || entry.level === "exceeded");
  const exceeded = alerted.some((entry) => entry.level === "exceeded");

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {config?.enabled && budget ? (
            <>
              <span className="tabular-nums">{copy("budget.banner.today", { value: formatCostUsd(budget.todayUsd) ?? "$0" })}</span>
              <span className="tabular-nums">{copy("budget.banner.month", { value: formatCostUsd(budget.monthUsd) ?? "$0" })}</span>
              <span
                className="tabular-nums"
                title={copy("budget.banner.burn_hint", { value: formatCostUsd(budget.burn?.projectedTodayUsd) ?? "—" })}
              >
                {copy("budget.banner.burn", { value: formatCostUsd(budget.burn?.lastHourUsd) ?? "$0" })}
              </span>
              {!pricingAvailable ? <span>{copy("budget.banner.pricing_missing")}</span> : null}
            </>
          ) : null}
        </div>
        <button
          type="button"
          onClick={openEdit}
          disabled={budget === null}
          title={copy("budget.edit.title")}
          aria-label={copy("budget.edit.title")}
          className="inline-flex h-10 sm:h-8 items-center gap-1.5 rounded-lg border border-oai-gray-200 px-2.5 font-medium hover:bg-oai-gray-50 disabled:opacity-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800"
        >
          <Settings2 size={13} aria-hidden="true" />
          <span className="hidden sm:inline">{copy("budget.edit.title")}</span>
        </button>
      </div>
      {alerted.length > 0 ? (
        <div
          role="alert"
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-xs font-medium ${
            exceeded
              ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
              : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
          }`}
        >
          {alerted.map((entry) => (
            <span key={entry.which} className="tabular-nums">
              {copy(`budget.banner.${entry.which}_${entry.level === "exceeded" ? "exceeded" : "warning"}`, { pct: entry.pct })}
            </span>
          ))}
        </div>
      ) : null}
      {editOpen && draft ? (
        <BudgetEditDialog draft={draft} setDraft={setDraft} saving={saving} onClose={() => setEditOpen(false)} onSave={save} />
      ) : null}
    </div>
  );
}

export function RequestsTab() {
  const [records, setRecords] = useState(null);
  const [stats, setStats] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(loadPageSize);
  const [range, setRange] = useState("24h");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [result, setResult] = useState("all");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState({ model: "", provider: "" });

  const [widths, setWidths] = useState(loadColumnWidths);
  const widthsRef = useRef(widths);
  const [visibleColumns, setVisibleColumns] = useState(loadVisibleColumns);
  const [columnDialogOpen, setColumnDialogOpen] = useState(false);
  const [draftColumns, setDraftColumns] = useState(visibleColumns);
  const [rowHeightEnabled, setRowHeightEnabled] = useState(loadRowHeightEnabled);
  const [rowHeight, setRowHeight] = useState(loadRowHeight);
  const [draftRowHeightEnabled, setDraftRowHeightEnabled] = useState(rowHeightEnabled);
  const [draftRowHeight, setDraftRowHeight] = useState(rowHeight);
  const [resizingCol, setResizingCol] = useState(null);
  const tableWrapRef = useRef(null);
  const resizeCleanupRef = useRef(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const listId = useId();
  useEffect(() => {
    const timer = setTimeout(() => { setPage(0); setQuery((previous) => previous.model === model.trim() && previous.provider === provider.trim() ? previous : { model: model.trim(), provider: provider.trim() }); }, 300);
    return () => clearTimeout(timer);
  }, [model, provider]);
  const searchPending = model.trim() !== query.model || provider.trim() !== query.provider;
  const invalidRange = range === "custom" && (!customStart || !customEnd || !Number.isFinite(Date.parse(customStart)) || !Number.isFinite(Date.parse(customEnd)) || Date.parse(customStart) >= Date.parse(customEnd));
  const filtered = !!model || !!provider || result !== "all" || range !== "24h";
  const clearFilters = () => { setModel(""); setProvider(""); setQuery({ model: "", provider: "" }); setResult("all"); setRange("24h"); setPage(0); };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Page/pageSize-only loads skip the stats recompute: the filtered
  // aggregation is independent of the slice (easy ffdc53c "refresh filter
  // options only on range change", adapted — stats ride the records
  // response here). Filter-scope changes and polls (neither scope nor slice
  // changed) always recompute. A filter change that also resets the page
  // still recomputes because the scope differs.
  const lastLoadedRef = useRef(null);

  const load = useCallback(async (signal) => {
    if (invalidRange || searchPending) { setLoading(false); return false; }
    const scopeKey = JSON.stringify([result, query.model, query.provider, range, customStart, customEnd]);
    const previous = lastLoadedRef.current;
    const scopeChanged = !previous || previous.scopeKey !== scopeKey;
    const sliceChanged = previous && (previous.page !== page || previous.pageSize !== pageSize);
    const includeStats = scopeChanged || !sliceChanged ? "1" : "0";
    lastLoadedRef.current = { scopeKey, page, pageSize };
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        includeStats,
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
      if (data.stats) setStats(data.stats);
      setError(null);
      return true;
    } catch (e) {
      if (signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [page, pageSize, result, query, range, customStart, customEnd, invalidRange, searchPending]);

  const refreshRecords = useVisiblePolling(load, 10_000);

  // Request replay: provider group rows (base-url / protocol lookup) are
  // fetched fresh per retest — local requests are cheap and group configs
  // change without this tab knowing.
  const [replayStates, setReplayStates] = useState({});
  const loadProviderRows = useCallback(async () => {
    const responses = await Promise.allSettled(
      providerLoadDefinitions.map(async (definition) => ({
        section: definition.section,
        records: await providerGroupsApi.get(definition.section),
      })),
    );
    return responses.flatMap((result) => (result.status === "fulfilled"
      ? result.value.records.flatMap((record, index) => {
          const keys = providerGroupKeys(record);
          const records = Array.isArray(record.keys)
            ? keys.map((key) => effectiveProviderKey(record, key))
            : [record];
          return records.map((entry) => rowFromRecord(result.value.section, entry, index));
        })
      : []));
  }, []);

  const handleReplay = useCallback(async (record) => {
    const id = record.id ?? record.request_id;
    if (!id || replayStates[id]?.status === "running") return;
    setReplayStates((current) => ({ ...current, [id]: { status: "running" } }));
    try {
      const rows = await loadProviderRows();
      const authIndex = String(record.auth_index || record.authIndex || "").trim();
      const row = rows.find((candidate) => String(candidate.authIndex || "").trim() === authIndex);
      if (!row) {
        setReplayStates((current) => ({ ...current, [id]: { status: "error", error: copy("proxy.requests.replay.no_credential") } }));
        return;
      }
      const result = await replayRecordViaCore(record, row);
      if (!result.ok) {
        setReplayStates((current) => ({ ...current, [id]: { status: "error", error: result.error || "failed" } }));
        return;
      }
      setReplayStates((current) => ({
        ...current,
        [id]: {
          status: "done",
          statusCode: result.statusCode,
          latencyMs: result.latencyMs,
          bodyExcerpt: result.bodyExcerpt || "",
        },
      }));
    } catch (error) {
      setReplayStates((current) => ({ ...current, [id]: { status: "error", error: error instanceof Error ? error.message : String(error) } }));
    }
  }, [loadProviderRows, replayStates]);

  const refresh = async () => {
    if (await refreshRecords()) showToast({ title: copy("proxy.requests.refreshed"), type: "success" });
  };

  const persistWidths = (next) => {
    widthsRef.current = next;
    setWidths(next);
    try { localStorage.setItem(WIDTHS_STORAGE_KEY, JSON.stringify(next)); } catch {}
  };

  const resetAllWidths = () => {
    const defaults = {};
    for (const column of EVENT_COLUMNS) defaults[column.key] = column.defaultWidth;
    persistWidths(defaults);
  };

  const resetSingleColumn = (key) => {
    const column = EVENT_COLUMNS.find((entry) => entry.key === key);
    if (!column) return;
    persistWidths({ ...widthsRef.current, [key]: column.defaultWidth });
  };

  const handleResizeKeyDown = (key, event) => {
    const column = EVENT_COLUMNS.find((entry) => entry.key === key);
    if (!column) return;
    const step = event.shiftKey ? 25 : 10;
    const current = widthsRef.current[key] ?? column.defaultWidth;
    const next = event.key === "Home"
      ? column.defaultWidth
      : event.key === "ArrowLeft"
        ? Math.max(column.minWidth, current - step)
        : event.key === "ArrowRight"
          ? Math.min(MAX_COLUMN_WIDTH, current + step)
          : null;
    if (next === null) return;
    event.preventDefault();
    persistWidths({ ...widthsRef.current, [key]: next });
  };

  const handleResizeStart = (key, event) => {
    event.preventDefault();
    event.stopPropagation();
    const column = EVENT_COLUMNS.find((entry) => entry.key === key);
    const minWidth = column?.minWidth ?? 50;
    const startX = event.clientX;
    const startWidth = widthsRef.current[key] ?? column?.defaultWidth ?? 100;
    // Paint straight into the table DOM and commit state once on release —
    // a setState per pointermove re-renders the whole table per frame
    // (easy ffdc53c).
    const table = event.currentTarget.closest("table");
    const colElement = table?.querySelector(`col[data-column="${key}"]`) ?? null;
    const header = event.currentTarget.closest("th");
    setResizingCol(key);
    document.body.classList.add("table-col-resizing");
    let currentWidth = startWidth;
    let frame = 0;

    const paintWidth = (nextWidth) => {
      widthsRef.current = { ...widthsRef.current, [key]: nextWidth };
      if (colElement) colElement.style.width = `${nextWidth}px`;
      if (header) header.style.width = `${nextWidth}px`;
      if (table) {
        const total = columns.reduce((sum, entry) => sum + (widthsRef.current[entry.key] ?? entry.defaultWidth), 0);
        table.style.width = `${total}px`;
      }
    };

    const onPointerMove = (moveEvent) => {
      currentWidth = Math.min(MAX_COLUMN_WIDTH, Math.max(minWidth, Math.round(startWidth + moveEvent.clientX - startX)));
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        paintWidth(currentWidth);
      });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      if (frame) window.cancelAnimationFrame(frame);
      document.body.classList.remove("table-col-resizing");
      resizeCleanupRef.current = null;
    };
    const onPointerUp = () => {
      paintWidth(currentWidth);
      cleanup();
      setResizingCol(null);
      const next = widthsRef.current;
      setWidths(next);
      try { localStorage.setItem(WIDTHS_STORAGE_KEY, JSON.stringify(next)); } catch {}
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    resizeCleanupRef.current = cleanup;
  };

  const columns = EVENT_COLUMNS.filter((column) => visibleColumns.includes(column.key));
  const widthsCustomized = EVENT_COLUMNS.some((column) => widths[column.key] !== column.defaultWidth);
  const tableWidth = columns.reduce((sum, column) => sum + (widthsRef.current[column.key] ?? widths[column.key] ?? column.defaultWidth), 0);
  const startRecord = total > 0 ? page * pageSize + 1 : 0;
  const endRecord = Math.min((page + 1) * pageSize, total);

  const applyColumns = () => {
    const next = draftColumns.length > 0 ? draftColumns : allColumnKeys();
    setVisibleColumns(next);
    try { localStorage.setItem(VISIBLE_STORAGE_KEY, JSON.stringify(next)); } catch {}
    setRowHeightEnabled(draftRowHeightEnabled);
    setRowHeight(draftRowHeight);
    try {
      localStorage.setItem(ROW_HEIGHT_ENABLED_STORAGE_KEY, String(draftRowHeightEnabled));
      localStorage.setItem(ROW_HEIGHT_STORAGE_KEY, String(draftRowHeight));
    } catch {}
    setColumnDialogOpen(false);
  };

  const changePageSize = (size) => {
    setPageSize(size);
    try { localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(size)); } catch {}
  };

  const toggleDraftColumn = (key) => {
    setDraftColumns((current) => {
      if (current.includes(key)) return current.length > 1 ? current.filter((entry) => entry !== key) : current;
      return EVENT_COLUMNS.filter((column) => current.includes(column.key) || column.key === key).map((column) => column.key);
    });
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
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">
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
      <BudgetBar />
      {stats ? (
        <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
          <StatTile label={copy("proxy.metric.requests")} value={fullTokens.format(stats.total_requests)} />
          <StatTile label={copy("proxy.requests.filter.ok")} value={fullTokens.format(stats.success_count)} tone="text-emerald-600 dark:text-emerald-400" />
          <StatTile label={copy("proxy.requests.filter.failed")} value={fullTokens.format(stats.failure_count)} tone="text-red-600 dark:text-red-400" />
          <StatTile label={copy("proxy.requests.canceled")} value={fullTokens.format(stats.canceled_count)} />
          <StatTile label={copy("proxy.requests.tokens")} value={formatTokens(stats.total_tokens)} />
          {stats.total_cost_usd != null ? (
            <StatTile label={copy("proxy.requests.cost")} value={formatCostUsd(stats.total_cost_usd) ?? "—"} />
          ) : null}
          <StatTile
            label={copy("proxy.metric.top_model")}
            value={stats.models?.[0]?.model || "—"}
          />
        </div>
      ) : null}

      <UsageHeatmap />

      <Card className="overflow-hidden" bodyClassName="!p-0">
        {records === null ? (
          <div className="px-5 py-8 text-center text-sm text-oai-gray-400">{error || (invalidRange ? copy("proxy.requests.range.invalid") : copy("proxy.loading"))}</div>
        ) : records.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <TriangleAlert className="mx-auto h-8 w-8 text-oai-gray-300 dark:text-oai-gray-600" />
            <p className="mt-3 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy(filtered ? "proxy.requests.no_matches" : "proxy.requests.empty")}</p>
          </div>
        ) : (
          <>
            <div ref={tableWrapRef} className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" tabIndex={0} role="region" aria-label={copy("proxy.requests.subtitle", { total: fullTokens.format(total) })}>
              <table
                className={`border-separate border-spacing-0 text-sm ${rowHeightEnabled ? "[&_td]:h-[var(--usage-row-height,68px)]" : ""}`}
                style={{
                  width: `${tableWidth}px`,
                  ...(rowHeightEnabled ? { "--usage-row-height": `${rowHeight}px` } : {}),
                }}
              >
                <colgroup>
                  {columns.map((column) => <col key={column.key} data-column={column.key} style={{ width: `${widthsRef.current[column.key] ?? widths[column.key] ?? column.defaultWidth}px` }} />)}
                </colgroup>
                <thead>
                  <tr>
                    {columns.map((column) => {
                      const label = copy(column.labelKey);
                      return (
                        <th key={column.key} className={`relative border-b border-oai-gray-200 bg-oai-gray-50/60 px-2 py-2.5 ${column.align === "center" ? "text-center" : "text-left"} text-xs font-semibold text-oai-gray-500 dark:border-oai-gray-800 dark:bg-oai-gray-800/40 dark:text-oai-gray-400`} style={{ width: `${widthsRef.current[column.key] ?? widths[column.key] ?? column.defaultWidth}px` }}>
                          <span className="block truncate" title={label}>{label}</span>
                          <div
                            role="separator"
                            tabIndex={0}
                            aria-label={`${label}: ${copy("proxy.requests.resize_hint")}`}
                            aria-orientation="vertical"
                            aria-valuemin={column.minWidth}
                            aria-valuemax={MAX_COLUMN_WIDTH}
                            aria-valuenow={widthsRef.current[column.key] ?? widths[column.key] ?? column.defaultWidth}
                            onPointerDown={(event) => handleResizeStart(column.key, event)}
                            onDoubleClick={() => resetSingleColumn(column.key)}
                            onKeyDown={(event) => handleResizeKeyDown(column.key, event)}
                            title={copy("proxy.requests.resize_hint")}
                            className={`absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none select-none bg-transparent hover:bg-oai-brand-500/40 focus-visible:bg-oai-brand-500/60 focus-visible:outline-none ${resizingCol === column.key ? "bg-oai-brand-500/60" : ""}`}
                          />
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {records.map((record, index) => {
                    const previousRecord = records[index - 1];
                    const showDate = index === 0 || !previousRecord || formatDay(previousRecord.timestamp) !== formatDay(record.timestamp);
                    return (
                      <tr key={record.id ?? record.request_id ?? `${record.timestamp}-${index}`} className="odd:bg-white even:bg-oai-gray-50/40 dark:odd:bg-transparent dark:even:bg-oai-gray-900/30">
                        {columns.map((column) => <EventCell key={column.key} record={record} column={column} onReplay={(target) => void handleReplay(target)} replayState={replayStates[record.id ?? record.request_id]} showDate={showDate} />)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <TableTopScrollbar tableWrapRef={tableWrapRef} />
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-oai-gray-100 dark:border-oai-gray-800 px-4 sm:px-5 py-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="tabular-nums">{copy("proxy.requests.range_summary", { start: startRecord, end: endRecord, total: fullTokens.format(total) })}</span>
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => { setDraftColumns(visibleColumns); setDraftRowHeightEnabled(rowHeightEnabled); setDraftRowHeight(rowHeight); setColumnDialogOpen(true); }}
                title={copy("proxy.requests.col_settings")}
                aria-label={copy("proxy.requests.col_settings")}
                className="inline-flex h-10 sm:h-8 items-center gap-1.5 rounded-lg border border-oai-gray-200 px-2.5 font-medium hover:bg-oai-gray-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800"
              >
                <Columns3 size={13} aria-hidden="true" />
                <span className="hidden sm:inline">{copy("proxy.requests.col_settings")}</span>
              </button>
              {widthsCustomized ? (
                <button
                  type="button"
                  onClick={resetAllWidths}
                  title={copy("proxy.requests.col_reset")}
                  aria-label={copy("proxy.requests.col_reset")}
                  className="inline-flex h-10 sm:h-8 w-10 sm:w-8 items-center justify-center rounded-lg border border-oai-gray-200 text-oai-gray-500 hover:bg-oai-gray-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800"
                >
                  <RotateCcw size={13} aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                disabled={loading || !records?.length}
                onClick={() => exportCsv(records ?? [], page)}
                title={copy("proxy.requests.export_hint")}
                className="inline-flex h-10 sm:h-8 items-center gap-1.5 rounded-lg border border-oai-gray-200 px-2.5 font-medium hover:bg-oai-gray-50 disabled:opacity-40 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800"
              >
                <Download size={13} aria-hidden="true" />
                <span className="hidden sm:inline">{copy("proxy.requests.export")}</span>
              </button>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <select
              aria-label={copy("proxy.requests.page_size", { size: pageSize })}
              value={pageSize}
              disabled={loading}
              onChange={(event) => {
                setPage(0);
                changePageSize(Number(event.currentTarget.value));
              }}
              className="h-8 rounded-lg border border-oai-gray-200 bg-transparent px-1.5 text-xs dark:border-oai-gray-700"
            >
              {[20, 50, 100, 200].map((size) => (
                <option key={size} value={size}>{copy("proxy.requests.page_size", { size })}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0}
              className="inline-flex h-8 items-center gap-0.5 rounded-md px-2 py-1 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-40"
            >
              <ChevronLeft size={13} aria-hidden="true" /> {copy("proxy.requests.prev")}
            </button>
            <span className="tabular-nums">{page + 1} / {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
              disabled={page >= totalPages - 1}
              className="inline-flex h-8 items-center gap-0.5 rounded-md px-2 py-1 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-40"
            >
              {copy("proxy.requests.next")} <ChevronRight size={13} aria-hidden="true" />
            </button>
          </div>
        </div>
      </Card>

      <ColumnSettingsDialog
        open={columnDialogOpen}
        onClose={() => setColumnDialogOpen(false)}
        draft={draftColumns}
        onToggle={toggleDraftColumn}
        onSelectAll={() => setDraftColumns(allColumnKeys())}
        onApply={applyColumns}
        draftRowHeightEnabled={draftRowHeightEnabled}
        onRowHeightToggle={() => setDraftRowHeightEnabled((current) => !current)}
        draftRowHeight={draftRowHeight}
        onRowHeightChange={setDraftRowHeight}
      />
    </div>
  );
}
