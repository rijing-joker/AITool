import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  Copy,
  Download,
  List,
  MoreHorizontal,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { copy } from "../lib/copy";
import { exportSessionMarkdown } from "../lib/session-export";
import {
  formatTime,
  MessageContent,
  ProcessStep,
  roleKey,
  textHits,
  UsageChips,
} from "./cli-session-content";
import {
  buildSessionTurns,
  isChangeStep,
  isFailedStep,
  readPreference,
  SESSION_PREFS,
  sessionAppLabel,
  sessionIconButton,
  stepText,
  turnPreview,
  turnText,
  writePreference,
} from "./cli-sessions-model";

function SessionTurn({ turn, index, filter, expandAll, query, onCopy }) {
  const [override, setOverride] = useState(null);
  useEffect(() => setOverride(null), [expandAll]);
  const steps =
    filter === "changes" ? turn.steps.filter(isChangeStep) : turn.steps;
  const forced = steps.some((step) => {
    return textHits(stepText(step), query);
  });
  const open = forced || (override ?? expandAll);
  const failures = steps.filter(isFailedStep).length;
  return (
    <section
      data-turn-key={turn.key}
      aria-label={copy("clisessions.turn", { count: index + 1 })}
      className="mx-auto w-full max-w-4xl space-y-4 border-b border-oai-gray-100 px-4 py-6 dark:border-oai-gray-800/70 sm:px-8"
    >
      {turn.question ? (
        <MessageContent message={turn.question} query={query} onCopy={onCopy} />
      ) : null}
      {filter === "changes" ? (
        <div className="space-y-1">
          {steps.map((step) => (
            <ProcessStep
              key={step.key}
              step={step}
              query={query}
              onCopy={onCopy}
            />
          ))}
        </div>
      ) : null}
      {filter === "all" && steps.length !== 0 ? (
        <div>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOverride(!open)}
            className="flex min-h-10 items-center gap-2 text-xs text-oai-gray-500 hover:text-oai-brand-600"
          >
            <ChevronRight size={14} className={open ? "rotate-90" : ""} />
            {copy("clisessions.process", { count: steps.length })}
            {failures !== 0 ? (
              <span className="text-red-500">
                {copy("clisessions.process_failed", { count: failures })}
              </span>
            ) : null}
          </button>
          {open ? (
            <div className="space-y-1 border-l border-oai-gray-200 pl-2 dark:border-oai-gray-700">
              {steps.map((step) => (
                <ProcessStep
                  key={step.key}
                  step={step}
                  query={query}
                  onCopy={onCopy}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {turn.final && filter !== "changes" ? (
        <MessageContent message={turn.final} query={query} onCopy={onCopy} />
      ) : null}
    </section>
  );
}

export function SessionReader({
  session,
  messages,
  usage,
  error,
  onBack,
  onReload,
  onCopy,
}) {
  const titleRef = useRef(null);
  const searchRef = useRef(null);
  const scrollRef = useRef(null);
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase());
  const [filter, setFilter] = useState("all");
  const [expandAll, setExpandAll] = useState(
    () => readPreference(SESSION_PREFS.processes, false) === true,
  );
  const [outline, setOutline] = useState(
    () => readPreference(SESSION_PREFS.outline, false) === true,
  );
  const [activeTurn, setActiveTurn] = useState(null);
  const [hitIndex, setHitIndex] = useState(0);
  const turns = useMemo(() => buildSessionTurns(messages ?? []), [messages]);
  const effectiveFilter = query ? "all" : filter;
  const visibleTurns = useMemo(
    () =>
      turns
        .map((turn, index) => ({ turn, index }))
        .filter(
          ({ turn }) =>
            effectiveFilter !== "changes" || turn.steps.some(isChangeStep),
        ),
    [turns, effectiveFilter],
  );
  const hits = useMemo(
    () =>
      query ? turns.filter((turn) => textHits(turnText(turn), query)) : [],
    [turns, query],
  );
  const virtual = visibleTurns.length > 60;
  const virtualizer = useVirtualizer({
    count: virtual ? visibleTurns.length : 0,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => visibleTurns[index].turn.key,
    estimateSize: () => 320,
    overscan: 3,
  });
  const jumpTo = useCallback(
    (key) => {
      const index = visibleTurns.findIndex(({ turn }) => {
        return turn.key === key;
      });
      if (index < 0) return;
      setActiveTurn(key);
      if (virtual) virtualizer.scrollToIndex(index, { align: "start" });
      else
        scrollRef.current
          ?.querySelector(`[data-turn-key="${key}"]`)
          ?.scrollIntoView?.({ block: "start" });
    },
    [visibleTurns, virtual, virtualizer],
  );
  const stepHit = (direction) => {
    if (!hits.length) return;
    const next = (hitIndex + direction + hits.length) % hits.length;
    setHitIndex(next);
    jumpTo(hits[next].key);
  };
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    setHitIndex(0);
    if (hits.length) jumpTo(hits[0].key);
  }, [hits, jumpTo]);
  useEffect(() => {
    const handleKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (event.key === "Escape") {
        if (search) {
          setSearch("");
          searchRef.current?.focus();
        } else onBack();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [search, onBack]);
  const exportMarkdown = () => {
    const blob = new Blob(
      [exportSessionMarkdown(session, messages, formatTime, roleKey)],
      { type: "text/markdown;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(session.title || session.sessionId || "session").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const renderTurn = ({ turn, index }) => {
    return (
      <SessionTurn
        key={turn.key}
        turn={turn}
        index={index}
        filter={effectiveFilter}
        expandAll={expandAll}
        query={query}
        onCopy={onCopy}
      />
    );
  };

  let readerContent;
  if (error) {
    readerContent = (
      <p role="alert" className="p-6 text-sm text-red-600">
        {error}
      </p>
    );
  } else if (messages === null) {
    readerContent = (
      <p className="p-6 text-sm text-oai-gray-400">
        {copy("clisessions.loading")}
      </p>
    );
  } else if (visibleTurns.length === 0) {
    readerContent = (
      <p className="p-6 text-sm text-oai-gray-400">
        {copy(
          effectiveFilter === "changes" && messages.length
            ? "clisessions.no_changes"
            : "clisessions.empty_transcript",
        )}
      </p>
    );
  } else if (virtual) {
    readerContent = (
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {renderTurn(visibleTurns[item.index])}
          </div>
        ))}
      </div>
    );
  } else {
    readerContent = visibleTurns.map(renderTurn);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-oai-gray-200 px-3 py-3 dark:border-oai-gray-800 sm:px-5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={copy("clisessions.back")}
            title={copy("clisessions.back")}
            className={sessionIconButton}
            onClick={onBack}
          >
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0 flex-1">
            <h1
              ref={titleRef}
              tabIndex={-1}
              className="truncate text-base font-semibold outline-none"
            >
              {session.title || copy("clisessions.untitled")}
            </h1>
            <p className="mt-0.5 text-[11px] text-oai-gray-400">
              {sessionAppLabel(session.appId)} ·{" "}
              {formatTime(session.lastActiveAt ?? session.createdAt)}
            </p>
          </div>
          <button
            type="button"
            aria-label={copy("clisessions.reload")}
            title={copy("clisessions.reload")}
            onClick={onReload}
            disabled={messages === null}
            className={sessionIconButton}
          >
            <RefreshCw
              size={15}
              className={
                messages === null
                  ? "animate-spin motion-reduce:animate-none"
                  : ""
              }
            />
          </button>
          <details className="relative">
            <summary
              aria-label={copy("clisessions.details")}
              title={copy("clisessions.details")}
              className={`${sessionIconButton} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
            >
              <MoreHorizontal size={18} />
            </summary>
            <div className="absolute right-0 top-full z-20 w-56 rounded-lg border border-oai-gray-200 bg-oai-white p-1 shadow-lg dark:border-oai-gray-700 dark:bg-oai-gray-900">
              {[
                ["copy_resume", session.resumeCommand],
                ["copy_id", session.sessionId],
                ["copy_path", session.sourcePath],
              ]
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={(event) => {
                      onCopy(value);
                      event.currentTarget.closest("details").open = false;
                    }}
                    className="flex min-h-10 w-full items-center gap-2 rounded px-3 text-left text-xs hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800"
                  >
                    <Copy size={13} />
                    {copy(`clisessions.${label}`)}
                  </button>
                ))}
            </div>
          </details>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 px-2 text-[11px] text-oai-gray-400">
          <span className="min-w-0 flex-1 truncate" title={session.projectDir}>
            {session.projectDir || copy("clisessions.unknown_project")}
          </span>
          <span>{copy("clisessions.turn_count", { count: turns.length })}</span>
          <UsageChips usage={usage} />
        </div>
      </header>
      <div className="shrink-0 space-y-2 border-b border-oai-gray-100 px-4 py-2 dark:border-oai-gray-800 sm:px-6">
        <div className="flex items-center gap-1 overflow-x-auto">
          <div className="mr-auto inline-flex shrink-0 rounded-lg bg-oai-gray-100 p-0.5 dark:bg-oai-gray-800">
            {["all", "conversation", "changes"].map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={effectiveFilter === value}
                onClick={() => {
                  setSearch("");
                  setFilter(value);
                }}
                className={`min-h-10 rounded-md px-3 text-xs ${effectiveFilter === value ? "bg-oai-white shadow-sm dark:bg-oai-gray-700" : "text-oai-gray-500"}`}
              >
                {copy(`clisessions.filter.${value}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-pressed={expandAll}
            onClick={() => {
              setExpandAll(!expandAll);
              writePreference(SESSION_PREFS.processes, !expandAll);
            }}
            className="min-h-10 shrink-0 px-2 text-xs text-oai-gray-500"
          >
            {copy(
              expandAll
                ? "clisessions.collapse_processes"
                : "clisessions.expand_processes",
            )}
          </button>
          <button
            type="button"
            aria-label={copy("clisessions.outline")}
            title={copy("clisessions.outline")}
            aria-pressed={outline}
            onClick={() => {
              setOutline(!outline);
              writePreference(SESSION_PREFS.outline, !outline);
            }}
            className={sessionIconButton}
          >
            <List size={16} />
          </button>
          <button
            type="button"
            aria-label={copy("clisessions.export")}
            title={copy("clisessions.export")}
            disabled={!messages?.length || Boolean(error)}
            onClick={exportMarkdown}
            className={sessionIconButton}
          >
            <Download size={16} />
          </button>
        </div>
        <div className="flex items-center gap-1" role="search">
          <Search size={14} className="shrink-0 text-oai-gray-400" />
          <input
            ref={searchRef}
            aria-label={copy("clisessions.find")}
            placeholder={copy("clisessions.find")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                stepHit(event.shiftKey ? -1 : 1);
              }
            }}
            className="h-10 min-w-0 flex-1 rounded-md border border-oai-gray-300 bg-oai-white px-3 text-sm outline-none focus:border-oai-brand-500 dark:border-oai-gray-700 dark:bg-oai-gray-900"
          />
          {query ? (
            <>
              <span
                role="status"
                className="max-w-28 text-[10px] tabular-nums text-oai-gray-400"
              >
                {copy("clisessions.find_count", {
                  current: hits.length ? hitIndex + 1 : 0,
                  count: hits.length,
                })}
              </span>
              <button
                type="button"
                aria-label={copy("clisessions.find_previous")}
                onClick={() => stepHit(-1)}
                disabled={!hits.length}
                className={sessionIconButton}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                aria-label={copy("clisessions.find_next")}
                onClick={() => stepHit(1)}
                disabled={!hits.length}
                className={sessionIconButton}
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                aria-label={copy("clisessions.find_clear")}
                onClick={() => setSearch("")}
                className={sessionIconButton}
              >
                <X size={14} />
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        >
          {readerContent}
        </div>
        {outline && !error ? (
          <nav
            aria-label={copy("clisessions.outline")}
            className="absolute bottom-0 right-0 top-0 z-10 w-56 max-w-[85%] shrink-0 overflow-y-auto border-l border-oai-gray-200 bg-oai-white p-3 shadow-lg dark:border-oai-gray-800 dark:bg-oai-gray-900 md:static md:shadow-none"
          >
            <p className="mb-2 px-2 py-1 text-xs font-medium text-oai-gray-500">
              {copy("clisessions.outline")}
            </p>
            {visibleTurns.map(({ turn, index }) => (
              <button
                key={turn.key}
                type="button"
                aria-current={activeTurn === turn.key ? "location" : undefined}
                onClick={() => {
                  jumpTo(turn.key);
                  if (window.matchMedia("(max-width: 767px)").matches)
                    setOutline(false);
                }}
                className={`mb-1 flex min-h-10 w-full gap-2 rounded-lg px-2 py-2 text-left text-xs ${activeTurn === turn.key ? "bg-oai-brand-50 text-oai-brand-700 dark:bg-oai-brand-950/40 dark:text-oai-brand-300" : "text-oai-gray-500 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800"}`}
              >
                <span className="tabular-nums text-oai-gray-400">
                  {index + 1}
                </span>
                <span className="line-clamp-2 break-words">
                  {turnPreview(turn) ||
                    copy("clisessions.turn", { count: index + 1 })}
                </span>
              </button>
            ))}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
