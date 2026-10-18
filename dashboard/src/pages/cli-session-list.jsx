import React, { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Folder } from "lucide-react";
import {
  observeElementOffset,
  observeElementRect,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { copy } from "../lib/copy";
import {
  formatTime,
  HighlightedText,
  relativeFrom,
} from "./cli-session-content";
import {
  baseName,
  groupSessions,
  readPreference,
  SESSION_PREFS,
  sessionAppLabel,
  sessionIconButton,
  sessionKey,
  sessionTime,
  writePreference,
} from "./cli-sessions-model";

export function SessionList({ sessions, query, mode, hidden, onOpen, onCopy }) {
  const scrollRef = useRef(null);
  const [collapsed, setCollapsed] = useState(() => {
    const saved = readPreference(SESSION_PREFS.collapsed, []);
    return new Set(
      Array.isArray(saved)
        ? saved.filter((key) => typeof key === "string")
        : [],
    );
  });
  const groups = useMemo(() => groupSessions(sessions, mode), [sessions, mode]);
  const rows = useMemo(
    () =>
      groups.flatMap((group) => [
        { key: `${mode}:${group.key}`, group },
        ...(!query && collapsed.has(`${mode}:${group.key}`)
          ? []
          : group.sessions.map((session) => ({
              key: sessionKey(session),
              session,
            }))),
      ]),
    [groups, mode, collapsed, query],
  );
  const virtual = rows.length > 80;
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index].group ? 48 : 80),
    getItemKey: (index) => rows[index].key,
    overscan: 8,
    // Hidden rows also report zero sizes. Retain their cached heights so the
    // virtualizer cannot shrink the list and compensate its scroll offset.
    useCachedMeasurements: hidden,
    observeElementOffset: (instance, callback) =>
      observeElementOffset(instance, (offset, isScrolling) => {
        // A delayed scroll-end callback can read zero while display:none.
        // Use current options, since this observer outlives the initial render.
        if (instance.options.useCachedMeasurements)
          callback(instance.scrollOffset ?? offset, false);
        else callback(offset, isScrolling);
      }),
    observeElementRect: (instance, callback) =>
      observeElementRect(instance, (rect) => {
        if (rect.width || rect.height) callback(rect);
      }),
  });
  const updateCollapsed = (next) => {
    setCollapsed(next);
    writePreference(SESSION_PREFS.collapsed, [...next]);
  };
  const renderRow = (row) => {
    if (row.group) {
      const open = Boolean(query) || !collapsed.has(row.key);
      const label =
        mode === "project"
          ? baseName(row.group.projectDir) || copy("clisessions.unknown_project")
          : copy(`clisessions.group.${row.group.key}`);
      return (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            const next = new Set(collapsed);
            if (open) next.add(row.key);
            else next.delete(row.key);
            updateCollapsed(next);
          }}
          disabled={Boolean(query)}
          title={mode === "project" ? row.group.projectDir : row.group.key}
          className="flex min-h-12 w-full items-center gap-2 border-b border-oai-gray-200 bg-oai-gray-50 px-4 text-left text-xs text-oai-gray-500 transition-colors hover:bg-oai-gray-100 dark:border-oai-gray-800 dark:bg-oai-gray-800/40 dark:hover:bg-oai-gray-800 sm:px-5"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {mode === "project" ? (
            <Folder size={14} className="shrink-0" />
          ) : null}
          <span className="truncate font-medium text-oai-gray-700 dark:text-oai-gray-300">
            {label}
          </span>
          {mode === "project" ? (
            <span className="hidden min-w-0 truncate text-[11px] text-oai-gray-400 sm:block">
              {row.group.projectDir}
            </span>
          ) : null}
          <span className="ml-auto tabular-nums">
            {row.group.sessions.length}
          </span>
        </button>
      );
    }
    const { session } = row;
    return (
      <div className="group flex min-h-20 items-center border-b border-oai-gray-100 px-4 transition-colors hover:bg-oai-gray-50 dark:border-oai-gray-800/70 dark:hover:bg-oai-gray-800/40 sm:px-5">
        <button
          type="button"
          data-session-key={sessionKey(session)}
          onClick={() => onOpen(session)}
          className="flex min-w-0 flex-1 flex-col gap-1.5 py-3 text-left focus-visible:outline-oai-brand-500"
        >
          <span className="flex w-full items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              <HighlightedText
                text={session.title || copy("clisessions.untitled")}
                query={query}
              />
            </span>
            <time
              className="shrink-0 text-xs tabular-nums text-oai-gray-500 dark:text-oai-gray-400"
              title={formatTime(sessionTime(session))}
            >
              {relativeFrom(sessionTime(session)) ||
                formatTime(sessionTime(session))}
            </time>
          </span>
          <span className="flex w-full items-center gap-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">
            <span className="shrink-0">{sessionAppLabel(session.appId)}</span>
            {mode === "time" && session.projectDir ? (
              <span className="max-w-[35%] truncate" title={session.projectDir}>
                {baseName(session.projectDir)}
              </span>
            ) : null}
            <span className="min-w-0 truncate">
              <HighlightedText
                text={session.summary || session.sessionId || ""}
                query={query}
              />
            </span>
          </span>
        </button>
        {session.resumeCommand ? (
          <button
            type="button"
            aria-label={copy("clisessions.copy_resume")}
            title={copy("clisessions.copy_resume")}
            onClick={() => onCopy(session.resumeCommand)}
            className={`${sessionIconButton} ml-2 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100`}
          >
            <Copy size={14} />
          </button>
        ) : null}
      </div>
    );
  };
  const allCollapsed = groups.every((group) =>
    collapsed.has(`${mode}:${group.key}`),
  );
  return (
    <div
      hidden={hidden}
      className={`${hidden ? "hidden" : "flex"} min-h-0 flex-1 flex-col`}
    >
      {groups.length !== 0 ? (
        <div className="flex justify-end px-4 py-1 sm:px-6">
          <button
            type="button"
            disabled={Boolean(query)}
            onClick={() =>
              updateCollapsed(
                allCollapsed
                  ? new Set()
                  : new Set(groups.map((group) => `${mode}:${group.key}`)),
              )
            }
            className="min-h-10 text-xs text-oai-gray-500 disabled:opacity-40"
          >
            {copy(
              allCollapsed
                ? "clisessions.expand_groups"
                : "clisessions.collapse_groups",
            )}
          </button>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      >
        {virtual ? (
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {renderRow(rows[item.index])}
              </div>
            ))}
          </div>
        ) : (
          rows.map((row) => (
            <React.Fragment key={row.key}>{renderRow(row)}</React.Fragment>
          ))
        )}
      </div>
    </div>
  );
}
