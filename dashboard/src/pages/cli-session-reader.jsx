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
import { mergeProcessSteps, toolCategory, toolPath } from "./cli-session-tools";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon";
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

function SessionTurn({ turn, index, filter, expandAll, query, onCopy, session }) {
  const [override, setOverride] = useState(null);
  useEffect(() => setOverride(null), [expandAll]);
  const steps =
    filter === "changes" ? turn.steps.filter(isChangeStep) : turn.steps;
  const forced = steps.some((step) => {
    return textHits(stepText(step), query);
  });
  const open = forced || (override ?? (expandAll || !turn.final));
  const commands = steps.filter(
    (step) => toolCategory(step.call) === "command",
  ).length;
  const duration = steps.reduce(
    (total, step) => total + (step.durationMs || 0),
    0,
  );
  const files = new Set(
    steps
      .filter(isChangeStep)
      .flatMap(
        (step) =>
          step.call?.patch?.files?.map((file) => {
            return file.path;
          }) || [toolPath(step.call)],
      )
      .filter(Boolean),
  ).size;
  const failures = steps.filter(isFailedStep).length;
  return (
    <section
      data-turn-key={turn.key}
      aria-label={copy("clisessions.turn", { count: index + 1 })}
      className="mx-auto w-full max-w-4xl space-y-3 border-b border-oai-gray-100 px-4 py-5 dark:border-oai-gray-800/70 sm:px-8"
    >
      {turn.question ? (
        <div data-turn-part="question">
          <MessageContent
            message={turn.question}
            query={query}
            onCopy={onCopy}
          />
        </div>
      ) : null}
      {filter === "changes" ? (
        <div className="space-y-1">
          {steps.map((step) => (
            <ProcessStep
              key={step.key}
              step={step}
              query={query}
              onCopy={onCopy}
              projectDir={session.projectDir}
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
            className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-oai-gray-600 hover:text-oai-brand-600 dark:text-oai-gray-400 dark:hover:text-oai-brand-400"
          >
            <ChevronRight size={14} className={open ? "rotate-90" : ""} />
            {copy("clisessions.process", { count: steps.length })}
            {commands ? (
              <span>
                {copy("clisessions.process_commands", { count: commands })}
              </span>
            ) : null}
            {files ? (
              <span>{copy("clisessions.process_files", { count: files })}</span>
            ) : null}
            {0 < duration ? (
              <span className="tabular-nums">
                {(duration / 1000).toFixed(1)}s
              </span>
            ) : null}
            {failures !== 0 ? (
              <span className="text-red-700 dark:text-red-400">
                {copy("clisessions.process_failed", { count: failures })}
              </span>
            ) : null}
          </button>
          {open || failures ? (
            <div className="space-y-1 border-l border-oai-gray-200 pl-2 dark:border-oai-gray-700">
              {mergeProcessSteps(open ? steps : steps.filter(isFailedStep)).map((step) => (
                <ProcessStep
                  key={step.key}
                  step={step}
                  query={query}
                  onCopy={onCopy}
                  projectDir={session.projectDir}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {!turn.final && filter !== "changes" ? (
        <p className="text-xs text-oai-gray-600 dark:text-oai-gray-400">
          {copy("clisessions.no_final")}
        </p>
      ) : null}
      {turn.final && filter !== "changes" ? (
        <div data-turn-part="answer">
          <MessageContent message={turn.final} query={query} onCopy={onCopy} appId={session.appId} />
        </div>
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
  onLoadFull,
  preview = false,
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
  const jumpFrame = useRef(null);
  const jumping = useRef(false);
  const [hitIndex, setHitIndex] = useState(0);
  const [fullBusy, setFullBusy] = useState(false);
  const [fullError, setFullError] = useState(false);
  const completeQuery = preview ? "" : query;
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
      completeQuery ? turns.filter((turn) => textHits(turnText(turn), completeQuery)) : [],
    [turns, completeQuery],
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
    (key, part = "question", find = false) => {
      const index = visibleTurns.findIndex(({ turn }) => {
        return turn.key === key;
      });
      if (index < 0) return;
      cancelAnimationFrame(jumpFrame.current);
      jumping.current = true;
      setActiveTurn(key);
      if (virtual) virtualizer.scrollToIndex(index, { align: "start" });
      let attempts = 0;
      const locate = () => {
        const root = scrollRef.current;
        const section = root?.querySelector(`[data-turn-key="${key}"]`);
        // A truncated summary can contain a clipped mark. Prefer the full
        // message/argument/output block so a reported match becomes readable.
        const marks = find ? [...(section?.querySelectorAll("[data-session-hit]") || [])] : [];
        const mark = marks.find(hit => !hit.closest("summary")) || marks[0];
        const target =
          mark ||
          section?.querySelector(`[data-turn-part="${part}"]`) ||
          section;
        if (target && (!find || mark || attempts >= 15)) {
          // Nested output/code panes scroll first, then the reader. Keep the
          // surrounding page fixed and preserve horizontal code scroll.
          let parent = target.parentElement;
          while (parent && parent !== root) {
            const style = getComputedStyle(parent);
            if (
              /(auto|scroll)/.test(style.overflowY) &&
              parent.scrollHeight > parent.clientHeight
            ) {
              parent.scrollTop +=
                target.getBoundingClientRect().top -
                parent.getBoundingClientRect().top -
                parent.clientHeight / 3;
            }
            parent = parent.parentElement;
          }
          if (root)
            root.scrollTop +=
              target.getBoundingClientRect().top -
              root.getBoundingClientRect().top -
              (find ? 72 : 16);
        }
        // Disclosure mounting and virtual measurements settle over several
        // frames. Retry while the target appears, then correct the final offset.
        if (++attempts < 18) jumpFrame.current = requestAnimationFrame(locate);
        else jumping.current = false;
      };
      jumpFrame.current = requestAnimationFrame(locate);
    },
    [visibleTurns, virtual, virtualizer],
  );
  useEffect(() => () => cancelAnimationFrame(jumpFrame.current), []);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let frame;
    setActiveTurn((current) => current ?? visibleTurns[0]?.turn.key ?? null);
    const cancelJump = () => {
      cancelAnimationFrame(jumpFrame.current);
      jumping.current = false;
    };
    root.addEventListener("wheel", cancelJump, { passive: true });
    root.addEventListener("touchstart", cancelJump, { passive: true });
    const update = () => {
      if (jumping.current) return;
      const top = root.getBoundingClientRect().top + 80;
      const sections = [...root.querySelectorAll("[data-turn-key]")];
      const current = sections.find(
        (section) => section.getBoundingClientRect().bottom > top,
      );
      if (current) setActiveTurn(current.dataset.turnKey);
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("wheel", cancelJump);
      root.removeEventListener("touchstart", cancelJump);
      cancelAnimationFrame(frame);
    };
  }, [visibleTurns, messages]);
  const stepHit = (direction) => {
    if (!hits.length) return;
    const next = (hitIndex + direction + hits.length) % hits.length;
    setHitIndex(next);
    jumpTo(hits[next].key, "question", true);
  };
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    setHitIndex(0);
    if (hits.length) jumpTo(hits[0].key, "question", true);
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
  const requestFull = async () => {
    setFullBusy(true);
    setFullError(false);
    try {
      return onLoadFull ? await onLoadFull() : messages;
    } catch {
      setFullError(true);
      return null;
    } finally {
      setFullBusy(false);
    }
  };
  useEffect(() => {
    if (query && preview && !fullBusy && !fullError) void requestFull();
  });
  const exportMarkdown = async () => {
    const fullMessages = await requestFull();
    if (!fullMessages) return;
    const blob = new Blob(
      [exportSessionMarkdown(session, fullMessages, formatTime, roleKey)],
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
        session={session}
      />
    );
  };

  let readerContent;
  if (error) {
    readerContent = (
      <div role="alert" className="mx-auto max-w-xl p-6 text-sm">
        <p className="font-medium">{copy("clisessions.read_failed")}</p>
        <p className="mt-2 text-oai-gray-600 dark:text-oai-gray-400">
          {copy("clisessions.read_failed_hint")}
        </p>
        <div className="mt-3 flex gap-3">
          <button
            type="button"
            onClick={onReload}
            className="min-h-10 rounded-lg bg-oai-brand-600 px-4 text-white hover:bg-oai-brand-700"
          >
            {copy("clisessions.reload")}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="min-h-10 rounded-lg px-3 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800"
          >
            {copy("clisessions.back")}
          </button>
        </div>
        <details className="mt-3 text-xs text-oai-gray-600 dark:text-oai-gray-400">
          <summary className="min-h-10 cursor-pointer py-3">
            {copy("clisessions.error_details")}
          </summary>
          <pre className="whitespace-pre-wrap break-words">{error}</pre>
        </details>
      </div>
    );
  } else if (messages === null) {
    readerContent = (
      <p className="p-6 text-sm text-oai-gray-600 dark:text-oai-gray-400">
        {copy("clisessions.loading")}
      </p>
    );
  } else if (visibleTurns.length === 0) {
    readerContent = (
      <p className="p-6 text-sm text-oai-gray-600 dark:text-oai-gray-400">
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
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-oai-gray-600 dark:text-oai-gray-400">
              <ProviderIcon provider={session.appId} size={13} />
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
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 px-2 text-xs text-oai-gray-600 dark:text-oai-gray-400">
          <span className="min-w-0 flex-1 truncate" title={session.projectDir}>
            {session.projectDir || copy("clisessions.unknown_project")}
          </span>
          {messages !== null && !error ? (
            <span>
              {copy("clisessions.turn_count", { count: turns.length })}
            </span>
          ) : null}
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
                className={`min-h-10 rounded-md px-3 text-xs ${effectiveFilter === value ? "bg-oai-white shadow-sm dark:bg-oai-gray-700" : "text-oai-gray-600 dark:text-oai-gray-300"}`}
              >
                {copy(`clisessions.filter.${value}`)}
              </button>
            ))}
          </div>
          {effectiveFilter === "all" ? (
            <button
              type="button"
              aria-pressed={expandAll}
              onClick={() => {
                setExpandAll(!expandAll);
                writePreference(SESSION_PREFS.processes, !expandAll);
              }}
              className="min-h-10 shrink-0 px-2 text-xs text-oai-gray-600 dark:text-oai-gray-400"
            >
              {copy(
                expandAll
                  ? "clisessions.collapse_processes"
                  : "clisessions.expand_processes",
              )}
            </button>
          ) : null}
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
            disabled={!messages?.length || Boolean(error) || fullBusy}
            onClick={exportMarkdown}
            className={sessionIconButton}
          >
            <Download size={16} />
          </button>
        </div>
        <div className="flex items-center gap-1" role="search">
          <Search
            size={14}
            className="shrink-0 text-oai-gray-600 dark:text-oai-gray-400"
          />
          <input
            ref={searchRef}
            aria-label={copy("clisessions.find")}
            placeholder={copy("clisessions.find")}
            value={search}
            onChange={(event) => { setFullError(false); setSearch(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                stepHit(event.shiftKey ? -1 : 1);
              }
            }}
            className="h-10 min-w-0 flex-1 rounded-md border border-oai-gray-300 bg-oai-white px-3 text-sm placeholder:text-oai-gray-500 dark:placeholder:text-oai-gray-400 outline-none focus:border-oai-brand-500 dark:border-oai-gray-700 dark:bg-oai-gray-900"
          />
          {query ? (
            <>
              <span
                role="status"
                className="max-w-28 text-xs tabular-nums text-oai-gray-600 dark:text-oai-gray-400"
              >
                {preview ? copy(fullError ? "clisessions.content_retry" : "clisessions.loading") : copy("clisessions.find_count", {
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
        {fullError ? <div role="alert" className="flex items-center gap-3 text-xs text-red-700 dark:text-red-400">
          <span>{copy("clisessions.content_failed")}</span>
          <button type="button" onClick={() => { void requestFull(); }} className="min-h-10 underline">{copy("clisessions.content_retry")}</button>
        </div> : null}
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
            <div className="mb-2 flex items-center justify-between px-2 text-xs font-medium text-oai-gray-600 dark:text-oai-gray-400">
              <span>{copy("clisessions.outline")}</span>
              <button
                type="button"
                aria-label={copy("clisessions.close_outline")}
                onClick={() => setOutline(false)}
                className={`${sessionIconButton} md:hidden`}
              >
                <X size={16} />
              </button>
            </div>
            {visibleTurns.map(({ turn, index }) => (
              <div key={turn.key} className="mb-2">
                <button
                  type="button"
                  aria-current={
                    activeTurn === turn.key ? "location" : undefined
                  }
                  onClick={() => {
                    jumpTo(turn.key);
                    if (window.matchMedia("(max-width: 767px)").matches)
                      setOutline(false);
                  }}
                  className={`flex min-h-10 w-full gap-2 rounded-lg px-2 py-2 text-left text-xs ${activeTurn === turn.key ? "bg-oai-brand-50 text-oai-brand-700 dark:bg-oai-brand-950/40 dark:text-oai-brand-300" : "text-oai-gray-600 hover:bg-oai-gray-100 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800"}`}
                >
                  <span className="tabular-nums">{index + 1}</span>
                  <span className="line-clamp-2 break-words">
                    {turnPreview(turn) ||
                      copy("clisessions.turn", { count: index + 1 })}
                  </span>
                </button>
                {turn.final && effectiveFilter !== "changes" ? (
                  <button
                    type="button"
                    aria-label={copy("clisessions.jump_answer", {
                      count: index + 1,
                    })}
                    onClick={() => {
                      jumpTo(turn.key, "answer");
                      if (window.matchMedia("(max-width: 767px)").matches)
                        setOutline(false);
                    }}
                    className="ml-5 flex min-h-10 w-[calc(100%-1.25rem)] items-start gap-1 rounded-md px-2 py-2 text-left text-xs text-oai-gray-600 hover:bg-oai-gray-100 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800"
                  >
                    <ArrowDown size={12} className="mt-0.5 shrink-0" />
                    <span className="line-clamp-2 break-words">
                      {turn.final.content.replace(/[#*`]/g, "").slice(0, 100)}
                    </span>
                  </button>
                ) : null}
                {turn.steps.some(isFailedStep) || !turn.final ? (
                  <p className="ml-7 text-xs text-oai-gray-600 dark:text-oai-gray-400">
                    {turn.steps.some(isFailedStep)
                      ? copy("clisessions.process_failed", {
                          count: turn.steps.filter(isFailedStep).length,
                        })
                      : copy("clisessions.no_final")}
                  </p>
                ) : null}
              </div>
            ))}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
