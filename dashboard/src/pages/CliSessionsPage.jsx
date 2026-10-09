import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { History, RefreshCw, Search } from "lucide-react";
import { copy } from "../lib/copy";
import { Input } from "../ui/components";
import { LocalOnlyNotice } from "../components/LocalOnlyNotice.jsx";
import { isLocalDashboardHost } from "../lib/host-mode";
import { isMockEnabled } from "../lib/mock-data";
import { SessionList } from "./cli-session-list";
import { SessionReader } from "./cli-session-reader";
import {
  filterSessions,
  readPreference,
  SESSION_PREFS,
  sessionAppLabel,
  sessionIconButton,
  sessionKey,
  writePreference,
} from "./cli-sessions-model";

const IS_LOCAL_HOST = isLocalDashboardHost();

async function readApi(url, signal) {
  const response = await fetch(url, { cache: "no-store", signal });
  const data = await response.json();
  if (response.ok === false || !data?.ok)
    throw new Error(data?.error || copy("clisessions.load_failed"));
  return data;
}

function LocalCliSessionsPage() {
  const [apps, setApps] = useState(null);
  const [activeApp, setActiveApp] = useState("claude");
  const [sessions, setSessions] = useState(null);
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase());
  const [mode, setMode] = useState(() =>
    readPreference(SESSION_PREFS.group, "project") === "time"
      ? "time"
      : "project",
  );
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState(null);
  const [readError, setReadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const sessionsController = useRef(null);
  const transcriptController = useRef(null);
  const opener = useRef(null);
  const availableApps = useMemo(
    () => (apps ?? []).filter((app) => app.available),
    [apps],
  );

  useEffect(() => {
    const controller = new AbortController();
    readApi("/api/cli-sessions", controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const next = data.apps ?? [];
        setApps(next);
        const first = next.find((app) => app.available);
        if (first && !next.some((app) => app.id === "claude" && app.available))
          setActiveApp(first.id);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setApps([]);
          setListError(error.message);
        }
      });
    return () => controller.abort();
  }, []);

  const loadSessions = useCallback(
    async (app) => {
      sessionsController.current?.abort();
      const controller = new AbortController();
      sessionsController.current = controller;
      setLoading(true);
      try {
        const ids =
          app === "all" ? availableApps.map((entry) => entry.id) : [app];
        const responses = await Promise.all(
          ids.map((id) =>
            readApi(
              `/api/cli-sessions/list?app=${encodeURIComponent(id)}`,
              controller.signal,
            ),
          ),
        );
        if (controller.signal.aborted) return;
        setSessions(responses.flatMap((data) => data.sessions ?? []));
        setListError(null);
      } catch (error) {
        if (!controller.signal.aborted) {
          setSessions([]);
          setListError(error.message);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [availableApps],
  );

  useEffect(() => {
    if (apps === null) return;
    setSessions(null);
    void loadSessions(activeApp);
    return () => sessionsController.current?.abort();
  }, [activeApp, apps, loadSessions]);
  useEffect(() => () => transcriptController.current?.abort(), []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(copy("clisessions.copied"));
    } catch {
      setNotice(copy("clisessions.copy_failed"));
    }
  };
  const openSession = async (session) => {
    if (!selected) opener.current = document.activeElement;
    transcriptController.current?.abort();
    const controller = new AbortController();
    transcriptController.current = controller;
    setSelected(session);
    setMessages(null);
    setUsage(null);
    setReadError(null);
    try {
      const params = new URLSearchParams({
        app: session.appId,
        path: session.sourcePath,
      });
      const data = await readApi(
        `/api/cli-sessions/read?${params}`,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setMessages(data.messages ?? []);
      setUsage(data.usage ?? null);
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessages([]);
        setReadError(error.message);
      }
    }
  };
  const backToList = () => {
    transcriptController.current?.abort();
    setSelected(null);
    setMessages(null);
    setUsage(null);
    setReadError(null);
    requestAnimationFrame(
      () =>
        opener.current?.isConnected &&
        opener.current.focus({ preventScroll: true }),
    );
  };
  const filtered = useMemo(() => {
    return filterSessions(sessions ?? [], query);
  }, [sessions, query]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden font-oai text-oai-black antialiased dark:text-oai-white">
      {notice ? (
        <div
          role="status"
          className="shrink-0 bg-oai-brand-50 px-4 py-2 text-xs text-oai-brand-700 dark:bg-oai-brand-950/40 dark:text-oai-brand-300"
        >
          {notice}
        </div>
      ) : null}
      <div
        hidden={Boolean(selected)}
        className={
          selected
            ? "hidden"
            : "shrink-0 border-b border-oai-gray-200 dark:border-oai-gray-800"
        }
      >
        <div className="flex items-start justify-between gap-4 px-4 pb-3 pt-5 sm:px-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {copy("clisessions.title")}
            </h1>
            <p className="mt-1 text-sm text-oai-gray-500">
              {copy("clisessions.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadSessions(activeApp)}
            disabled={loading || apps === null}
            aria-label={copy("clisessions.refresh")}
            title={copy("clisessions.refresh")}
            className={sessionIconButton}
          >
            <RefreshCw
              size={16}
              className={
                loading ? "animate-spin motion-reduce:animate-none" : ""
              }
            />
          </button>
        </div>
        <div className="flex gap-1 overflow-x-auto px-4 sm:px-6">
          {availableApps.length !== 1 && availableApps.length !== 0 ? (
            <button
              type="button"
              aria-pressed={activeApp === "all"}
              onClick={() => {
                setActiveApp("all");
                setSearch("");
              }}
              className={`min-h-10 shrink-0 border-b-2 px-3 text-sm ${activeApp === "all" ? "border-oai-brand-500 text-oai-brand-600" : "border-transparent text-oai-gray-500"}`}
            >
              {copy("clisessions.all_apps")}
            </button>
          ) : null}
          {availableApps.map((app) => (
            <button
              key={app.id}
              type="button"
              aria-pressed={activeApp === app.id}
              onClick={() => {
                setActiveApp(app.id);
                setSearch("");
              }}
              className={`min-h-10 shrink-0 border-b-2 px-3 text-sm ${activeApp === app.id ? "border-oai-brand-500 text-oai-brand-600 dark:text-oai-brand-400" : "border-transparent text-oai-gray-500"}`}
            >
              {sessionAppLabel(app.id)}
            </button>
          ))}
          {apps !== null && availableApps.length === 0 ? (
            <span className="py-2 text-xs text-oai-gray-500">
              {copy("clisessions.no_apps")}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
          <div className="relative min-w-0 flex-1 basis-48">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-3 text-oai-gray-400"
            />
            <Input
              aria-label={copy("clisessions.search")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={copy("clisessions.search")}
              className="h-10 w-full pl-9"
            />
          </div>
          <div className="inline-flex shrink-0 rounded-lg bg-oai-gray-100 p-0.5 dark:bg-oai-gray-800">
            {["project", "time"].map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  writePreference(SESSION_PREFS.group, value);
                }}
                className={`min-h-10 rounded-md px-3 text-xs ${mode === value ? "bg-oai-white shadow-sm dark:bg-oai-gray-700" : "text-oai-gray-500"}`}
              >
                {copy(`clisessions.group.${value}`)}
              </button>
            ))}
          </div>
          <span
            role="status"
            className="text-xs tabular-nums text-oai-gray-500"
          >
            {sessions !== null
              ? copy("clisessions.count", { count: filtered.length })
              : ""}
          </span>
        </div>
        {listError ? (
          <p role="alert" className="px-4 pb-3 text-sm text-red-600 sm:px-6">
            {listError}
          </p>
        ) : null}
      </div>
      {!selected && (sessions === null || filtered.length === 0) ? (
        <div className="px-5 py-16 text-center text-sm text-oai-gray-400">
          <History size={28} className="mx-auto mb-3" />
          {copy(
            sessions === null
              ? "clisessions.loading"
              : query
                ? "clisessions.no_matches"
                : "clisessions.empty",
          )}
        </div>
      ) : null}
      <SessionList
        sessions={filtered}
        query={query}
        mode={mode}
        hidden={Boolean(selected)}
        onOpen={openSession}
        onCopy={handleCopy}
      />
      {selected ? (
        <SessionReader
          key={sessionKey(selected)}
          session={selected}
          messages={messages}
          usage={usage}
          error={readError}
          onBack={backToList}
          onReload={() => void openSession(selected)}
          onCopy={handleCopy}
        />
      ) : null}
    </div>
  );
}

export function CliSessionsPage() {
  if (!IS_LOCAL_HOST && !isMockEnabled()) {
    return (
      <div className="flex flex-1 flex-col">
        <LocalOnlyNotice />
      </div>
    );
  }
  return <LocalCliSessionsPage />;
}
