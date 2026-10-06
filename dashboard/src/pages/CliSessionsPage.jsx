import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain, Download, Wrench, ArrowLeft, Coins, History, RefreshCw, Search, Timer, User } from "lucide-react";
import { copy } from "../lib/copy";
import { formatCostUsd } from "../lib/cost-format";
import { Input } from "../ui/components";
import { exportSessionMarkdown } from "../lib/session-export";
import { LocalOnlyNotice } from "../components/LocalOnlyNotice.jsx";
import { isLocalDashboardHost } from "../lib/host-mode";
import { isMockEnabled } from "../lib/mock-data";

// CLI session history (cc-switch session_manager port, minimal reader):
// left column lists the session logs found on disk per app, right pane shows
// the plain transcript (user / assistant / tool rows). Reads go through the
// local API, which clamps every path to the app's own session roots.

const IS_LOCAL_HOST = isLocalDashboardHost();

const APP_LABELS = {
  claude: () => "Claude Code",
  codex: () => "Codex",
  gemini: () => "Gemini CLI",
};

function formatTime(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString([], {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function formatUsageTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return compactNumber.format(value);
}

function formatUsageDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function relativeFrom(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff) || diff < 0) return null;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return copy("clisessions.time.now");
  if (minutes < 60) return copy("clisessions.time.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return copy("clisessions.time.hours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return copy("clisessions.time.days", { count: days });
  return null;
}

const ROLE_STYLES = {
  user: {
    chip: "bg-oai-brand-50 text-oai-brand-600 dark:bg-oai-brand-950/50 dark:text-oai-brand-400",
    bubble: "bg-oai-gray-50 dark:bg-oai-gray-800/60",
  },
  assistant: {
    chip: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400",
    bubble: "bg-white dark:bg-oai-gray-900",
  },
  tool: {
    chip: "bg-oai-gray-100 text-oai-gray-500 dark:bg-oai-gray-800 dark:text-oai-gray-400",
    bubble: "bg-oai-gray-50/60 dark:bg-oai-gray-800/30",
  },
  unknown: {
    chip: "bg-oai-gray-100 text-oai-gray-500 dark:bg-oai-gray-800 dark:text-oai-gray-400",
    bubble: "bg-white dark:bg-oai-gray-900",
  },
};

function roleKey(role) {
  return ROLE_STYLES[role] ? role : "unknown";
}

// Reader-header usage chips (cc-switch 31e5ae3): total tokens, active span and
// the models.dev-estimated cost, when the server could price the session.
function UsageChips({ usage }) {
  if (!usage || typeof usage !== "object") return null;
  const chips = [];
  const tokens = formatUsageTokens(usage.totalTokens);
  if (tokens != null) {
    chips.push({ key: "tokens", icon: Coins, label: copy("clisessions.usage.tokens"), value: tokens, title: String(usage.totalTokens) });
  }
  const duration = formatUsageDuration(usage.durationMs);
  if (duration != null) {
    chips.push({ key: "duration", icon: Timer, label: copy("clisessions.usage.duration"), value: duration, title: `${Math.round(usage.durationMs / 1000)}s` });
  }
  const cost = formatCostUsd(usage.estimatedCostUsd);
  if (cost != null) {
    chips.push({ key: "cost", label: copy("clisessions.usage.cost"), value: cost, title: usage.model ? `$${usage.estimatedCostUsd.toFixed(6)} · ${usage.model}` : undefined });
  }
  if (chips.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
      {chips.map((chip) => (
        <span key={chip.key} className="inline-flex items-center gap-1" title={chip.title}>
          {chip.icon ? <chip.icon size={11} aria-hidden="true" /> : null}
          <span className="hidden sm:inline">{chip.label}</span>
          <span className="font-medium text-oai-gray-700 dark:text-oai-gray-300">{chip.value}</span>
        </span>
      ))}
    </div>
  );
}

// Split text into plain and hit segments for search highlighting (cc-switch
// 4ca7f47/b23c9d5: a find hit inside a collapsed block also OPENS it).
function highlightSegments(text, query) {
  if (!query) return null;
  const segments = [];
  const lower = String(text ?? "").toLowerCase();
  const needle = query.toLowerCase();
  let index = 0;
  for (;;) {
    const hit = lower.indexOf(needle, index);
    if (hit < 0) {
      if (index < text.length) segments.push({ text: text.slice(index), hit: false });
      break;
    }
    if (hit > index) segments.push({ text: text.slice(index, hit), hit: false });
    segments.push({ text: text.slice(hit, hit + needle.length), hit: true });
    index = hit + needle.length;
  }
  return segments;
}

function HighlightedText({ text, query }) {
  const segments = highlightSegments(text, query);
  if (!segments) { return text; }
  const parts = segments.map((segment, index) => {
    if (segment.hit) { return <mark key={index} className="rounded-sm bg-amber-200 px-0.5 text-oai-black dark:bg-amber-500/40 dark:text-white">{segment.text}</mark>; }
    return <React.Fragment key={index}>{segment.text}</React.Fragment>;
  });
  return parts;
}

function textHits(text, query) {
  return !!query && String(text ?? "").toLowerCase().includes(query);
}

function compactTokenCount(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}

// Structured transcript row: content text, collapsible tool calls with their
// input payloads, and a per-message token chip where the source attributes
// usage to the message (claude/gemini).
function TranscriptRow({ message, query = "" }) {
  const style = ROLE_STYLES[roleKey(message.role)];
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  const up = compactTokenCount(message.usage?.inputTokens);
  const down = compactTokenCount(message.usage?.outputTokens);
  const thinking = String(message.thinking ?? "");
  const thinkingOpen = textHits(thinking, query);
  return (
    <div className={`rounded-xl border border-oai-gray-100 p-3 dark:border-oai-gray-800 ${style.bubble}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${style.chip}`}>
          {message.role === "user" ? <User size={11} aria-hidden="true" /> : null}
          {copy(`clisessions.role.${roleKey(message.role)}`)}
        </span>
        {message.ts != null ? (
          <span className="tabular-nums text-oai-gray-400">{formatTime(message.ts)}</span>
        ) : null}
        {up || down ? (
          <span className="ml-auto shrink-0 tabular-nums text-[10px] text-oai-gray-400" title={copy("clisessions.msg_tokens", { up: message.usage?.inputTokens ?? 0, down: message.usage?.outputTokens ?? 0 })}>
            {up ? `↑${up}` : ""}{up && down ? " " : ""}{down ? `↓${down}` : ""}
          </span>
        ) : null}
      </div>
      {message.content ? (
        <p className={`mt-1.5 break-words whitespace-pre-wrap text-sm leading-6 ${message.role === "tool" || message.role === "unknown" ? "font-mono text-xs leading-5" : ""}`}>
          <HighlightedText text={message.content} query={query} />
        </p>
      ) : null}
      {thinking ? (
        <details open={thinkingOpen} className="mt-1.5 rounded-lg border border-oai-gray-200 bg-oai-gray-50/60 px-2 py-1 dark:border-oai-gray-700 dark:bg-oai-gray-800/40">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">
            <Brain size={11} aria-hidden="true" />
            {copy("clisessions.thinking")}
          </summary>
          <pre className="mt-1.5 max-h-56 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] italic leading-5 text-oai-gray-500 dark:text-oai-gray-400"><HighlightedText text={thinking} query={query} /></pre>
        </details>
      ) : null}
      {toolCalls.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {toolCalls.map((call, index) => {
            const payload = call.input ?? call.args ?? (call.arguments ? (() => { try { return JSON.parse(call.arguments); } catch { return call.arguments; } })() : null);
            const payloadText = payload == null ? "" : typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
            const key = call.id ?? call.callId ?? `${call.name}-${index}`;
            const toolOpen = textHits(payloadText, query) || textHits(call.name, query);
            return (
              <details key={key} open={toolOpen} className="max-w-full rounded-lg border border-oai-gray-200 bg-oai-gray-50/60 px-2 py-1 dark:border-oai-gray-700 dark:bg-oai-gray-800/40">
                <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-oai-gray-600 dark:text-oai-gray-300">
                  <Wrench size={11} aria-hidden="true" />
                  <span className="truncate"><HighlightedText text={call.name} query={query} /></span>
                </summary>
                {payloadText ? (
                  <pre className="mt-1.5 max-h-56 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-oai-gray-500 dark:text-oai-gray-400"><HighlightedText text={payloadText} query={query} /></pre>
                ) : null}
              </details>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function CliSessionsPage() {
  const [apps, setApps] = useState(null);
  const [activeApp, setActiveApp] = useState("claude");
  const [sessions, setSessions] = useState(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [deferredSearch, setDeferredSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDeferredSearch(search.trim().toLowerCase()), 200);
    return () => clearTimeout(timer);
  }, [search]);

  const loadApps = useCallback(async (signal) => {
    try {
      const data = await fetch("/api/cli-sessions", { cache: "no-store", signal }).then((response) => response.json());
      if (signal.aborted) return;
      if (data?.ok) setApps(data.apps ?? []);
    } catch {
      if (!signal?.aborted) setApps([]);
    }
  }, []);

  const loadSessions = useCallback(async (app, signal) => {
    setLoading(true);
    try {
      const data = await fetch(`/api/cli-sessions/list?app=${encodeURIComponent(app)}`, { cache: "no-store", signal }).then((response) => response.json());
      if (signal.aborted) return;
      if (!data?.ok) throw new Error(data?.error || "HTTP sessions");
      setSessions(data.sessions ?? []);
      setError(null);
    } catch (e) {
      if (signal.aborted) return;
      setSessions([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadApps(controller.signal);
    return () => controller.abort();
  }, [loadApps]);

  useEffect(() => {
    const controller = new AbortController();
    setSelected(null);
    setMessages(null);
    setUsage(null);
    void loadSessions(activeApp, controller.signal);
    return () => controller.abort();
  }, [activeApp, loadSessions]);

  const openRequestIdRef = useRef(0);
  const openSession = async (session) => {
    // Stale-response guard (same pattern as loadSessions' abort checks):
    // a slow transcript read for session A must never render into the
    // panel the user already pointed at session B.
    const requestId = ++openRequestIdRef.current;
    setSelected(session);
    setMessages(null);
    setUsage(null);
    try {
      const params = new URLSearchParams({ app: activeApp, path: session.sourcePath });
      const data = await fetch(`/api/cli-sessions/read?${params}`, { cache: "no-store" }).then((response) => response.json());
      if (openRequestIdRef.current !== requestId) return;
      if (!data?.ok) throw new Error(data?.error || "HTTP transcript");
      setMessages(data.messages ?? []);
      setUsage(data.usage ?? null);
    } catch (e) {
      if (openRequestIdRef.current !== requestId) return;
      setMessages([]);
      setUsage(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const filtered = useMemo(() => {
    if (sessions === null) return [];
    if (!deferredSearch) return sessions;
    return sessions.filter((session) => {
      const haystack = `${session.title ?? ""} ${session.summary ?? ""} ${session.projectDir ?? ""}`.toLowerCase();
      return haystack.includes(deferredSearch);
    });
  }, [sessions, deferredSearch]);

  const availableApps = (apps ?? []).filter((app) => app.available);

  let listContent;
  if (sessions === null) {
    listContent = <div className="px-5 py-8 text-center text-sm text-oai-gray-400">{copy("clisessions.loading")}</div>;
  } else if (filtered.length === 0) {
    listContent = (
      <div className="rounded-xl border border-dashed border-oai-gray-200 dark:border-oai-gray-800 px-5 py-10 text-center">
        <History className="mx-auto h-8 w-8 text-oai-gray-300 dark:text-oai-gray-600" />
        <p className="mt-3 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("clisessions.empty")}</p>
      </div>
    );
  } else {
    listContent = filtered.map((session) => (
      <button
        key={session.sourcePath}
        type="button"
        onClick={() => void openSession(session)}
        className={`rounded-xl border px-3.5 py-3 text-left transition-colors ${
          selected?.sourcePath === session.sourcePath
            ? "border-oai-brand-500 bg-oai-brand-50/50 dark:bg-oai-brand-950/20"
            : "border-oai-gray-200 bg-white hover:bg-oai-gray-50 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:hover:bg-oai-gray-800/60"
        }`}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{session.title || copy("clisessions.untitled")}</span>
          {session.lastActiveAt ? (
            <span className="shrink-0 text-[10px] tabular-nums text-oai-gray-400" title={formatTime(session.lastActiveAt)}>
              {relativeFrom(session.lastActiveAt) ?? formatTime(session.lastActiveAt)}
            </span>
          ) : null}
        </span>
        {session.summary ? (
          <span className="mt-1 line-clamp-2 block text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">{session.summary}</span>
        ) : null}
        {session.projectDir ? (
          <span className="mt-1 block truncate font-mono text-[10px] text-oai-gray-400" title={session.projectDir}>{session.projectDir}</span>
        ) : null}
      </button>
    ));
  }

  const hasExportableTranscript = Array.isArray(messages) && messages.length > 0;

  let transcriptContent;
  if (!selected) {
    transcriptContent = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-16 text-center">
        <Search className="h-8 w-8 text-oai-gray-300 dark:text-oai-gray-600" />
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("clisessions.pick_hint")}</p>
      </div>
    );
  } else if (messages === null) {
    transcriptContent = <div className="px-5 py-8 text-center text-sm text-oai-gray-400">{copy("clisessions.loading")}</div>;
  } else if (messages.length === 0) {
    transcriptContent = <div className="px-5 py-8 text-center text-sm text-oai-gray-400">{copy("clisessions.empty_transcript")}</div>;
  } else {
    transcriptContent = messages.map((message, index) => <TranscriptRow key={index} message={message} query={deferredSearch} />);
  }

  if (!IS_LOCAL_HOST && !isMockEnabled()) {
    return (
      <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
        <LocalOnlyNotice />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 gap-4 text-oai-black dark:text-oai-white font-oai antialiased">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{copy("clisessions.title")}</h1>
        <p className="mt-1 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("clisessions.subtitle")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-x-auto rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-oai-gray-50 dark:bg-oai-gray-800/60 p-0.5">
          {availableApps.length === 0 && apps !== null ? (
            <span className="px-2.5 py-2 text-xs text-oai-gray-500">{copy("clisessions.no_apps")}</span>
          ) : null}
          {availableApps.map((app) => (
            <button
              key={app.id}
              type="button"
              onClick={() => {
                setActiveApp(app.id);
                setSearch("");
              }}
              aria-pressed={activeApp === app.id}
              className={`shrink-0 rounded-md px-2.5 py-2 sm:py-1 text-xs font-medium transition-colors ${
                activeApp === app.id
                  ? "bg-white dark:bg-oai-gray-900 shadow-oai-sm text-oai-black dark:text-white"
                  : "text-oai-gray-500 hover:text-oai-black dark:hover:text-white"
              }`}
            >
              {(APP_LABELS[app.id] ?? (() => app.id))()}
            </button>
          ))}
        </div>
        <Input
          aria-label={copy("clisessions.search")}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder={copy("clisessions.search")}
          className="h-10 sm:h-8 w-full sm:w-56"
        />
        <button
          type="button"
          onClick={() => void loadSessions(activeApp)}
          disabled={loading}
          aria-label={copy("clisessions.refresh")}
          title={copy("clisessions.refresh")}
          className="inline-flex h-10 sm:h-8 w-10 sm:w-8 items-center justify-center rounded-lg border border-oai-gray-200 text-oai-gray-500 hover:bg-oai-gray-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} />
        </button>
        <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400" role="status">
          {sessions !== null ? copy("clisessions.count", { count: filtered.length }) : ""}
        </span>
      </div>

      {error ? (
        <div role="alert" className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          {error}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[22rem_1fr]">
        <div className={`min-w-0 flex-col gap-2 overflow-y-auto ${selected ? "hidden lg:flex" : "flex"}`}>
          {listContent}
        </div>

        <div className={`min-w-0 flex-col rounded-xl border border-oai-gray-200 bg-white dark:border-oai-gray-800 dark:bg-oai-gray-900 ${selected ? "flex" : "hidden lg:flex"}`}>
          {selected ? (
            <>
              <div className="flex items-center gap-2 border-b border-oai-gray-100 px-4 py-3 dark:border-oai-gray-800">
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setMessages(null);
                    setUsage(null);
                  }}
                  aria-label={copy("clisessions.back")}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-oai-gray-500 hover:bg-oai-gray-100 lg:hidden dark:hover:bg-oai-gray-800"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{selected.title || copy("clisessions.untitled")}</p>
                  {selected.resumeCommand ? (
                    <p className="truncate font-mono text-[10px] text-oai-gray-400" title={selected.resumeCommand}>{selected.resumeCommand}</p>
                  ) : null}
                </div>
                <UsageChips usage={usage} />
                {hasExportableTranscript ? (
                  <button
                    type="button"
                    onClick={() => {
                      const blob = new Blob([exportSessionMarkdown(selected, messages, formatTime, roleKey)], { type: "text/markdown;charset=utf-8" });
                      const url = URL.createObjectURL(blob);
                      const anchor = document.createElement("a");
                      anchor.href = url;
                      anchor.download = `${(selected.title || selected.sourcePath.split("/").pop() || "session").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80)}.md`;
                      anchor.click();
                      URL.revokeObjectURL(url);
                    }}
                    aria-label={copy("clisessions.export")}
                    title={copy("clisessions.export")}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-oai-gray-500 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800"
                  >
                    <Download className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
              <div className="flex flex-col gap-2.5 overflow-y-auto p-4">
                {transcriptContent}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
