import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { History, RefreshCw, Search } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { copy } from "../lib/copy";
import { Button, Input } from "../ui/components";
import { PageHeader } from "../ui/components/PageHeader";
import { PageTabs } from "../ui/components/PageTabs";
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
  const location = useLocation();
  const navigate = useNavigate();
  const routeParams = new URLSearchParams(location.search);
  const [apps, setApps] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase());
  const [mode, setMode] = useState(() =>
    readPreference(SESSION_PREFS.group, "project") === "time"
      ? "time"
      : "project",
  );
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
  const requestedApp = routeParams.get("app");
  const defaultApp = availableApps.find((app) => app.id === "claude")?.id ?? availableApps[0]?.id ?? "claude";
  const activeApp = requestedApp === "all" || availableApps.some((app) => app.id === requestedApp)
    ? requestedApp : defaultApp;
  const selectedId = routeParams.get("session");
  const selectedApp = routeParams.get("sessionApp") || activeApp;
  // Resolve the opaque native ID against the scanner's list; never accept a
  // transcript path from the URL or put conversation contents in history.
  const selected = sessions?.find((session) => session.appId === selectedApp && session.sessionId === selectedId) ?? null;

  const listLocation = () => {
    const params = new URLSearchParams(location.search);
    params.delete("session");
    params.delete("sessionApp");
    return { pathname: location.pathname, search: params.toString(), hash: location.hash };
  };

  useEffect(() => {
    const controller = new AbortController();
    readApi("/api/cli-sessions", controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const next = data.apps ?? [];
        setApps(next);
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
  const loadTranscript = useCallback(async (session) => {
    transcriptController.current?.abort();
    const controller = new AbortController();
    transcriptController.current = controller;
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
  }, []);
  useEffect(() => {
    if (selected) {
      void loadTranscript(selected);
    } else {
      transcriptController.current?.abort();
      setMessages(null);
      setUsage(null);
      setReadError(null);
      const frame = requestAnimationFrame(() => {
        if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
    return () => transcriptController.current?.abort();
  }, [selected, loadTranscript]);
  const openSession = (session) => {
    opener.current = document.activeElement;
    const params = new URLSearchParams(location.search);
    params.set("app", activeApp);
    params.set("sessionApp", session.appId);
    params.set("session", session.sessionId);
    navigate({ pathname: location.pathname, search: params.toString(), hash: location.hash }, {
      state: { cliSessionFromList: true },
    });
  };
  const backToList = () => {
    transcriptController.current?.abort();
    if (location.state?.cliSessionFromList) navigate(-1);
    else navigate(listLocation(), { replace: true });
  };
  const filtered = useMemo(() => {
    return filterSessions(sessions ?? [], query);
  }, [sessions, query]);

  return (
    <div className={`mx-auto flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden font-oai text-oai-black antialiased dark:text-oai-white ${selected ? "" : "max-w-6xl px-4 py-6 sm:px-6 sm:py-8"}`}>
      {notice ? (
        <div
          role="status"
          className="shrink-0 bg-oai-brand-50 px-4 py-2 text-xs text-oai-brand-700 dark:bg-oai-brand-950/40 dark:text-oai-brand-300"
        >
          {notice}
        </div>
      ) : null}
      {/* Keep the outer and virtual list scroll positions when the reader opens. */}
      <div
        hidden={Boolean(selected)}
        className={selected ? "hidden" : "flex min-h-0 flex-1 flex-col overflow-y-auto"}
      >
        <div className="shrink-0">
          <PageHeader
            title={copy("clisessions.title")}
            description={copy("clisessions.subtitle")}
            actions={<Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void loadSessions(activeApp)}
              disabled={loading || apps === null}
              aria-label={copy("clisessions.refresh")}
              title={copy("clisessions.refresh")}
            >
              <RefreshCw
                size={16}
                className={
                  loading ? "animate-spin motion-reduce:animate-none" : ""
                }
              />
              {copy("clisessions.refresh")}
            </Button>}
          />
          <div className="mb-5">
            {availableApps.length > 0 ? (
              <PageTabs
                options={[
                  ...(availableApps.length > 1 ? [{ id: "all", label: copy("clisessions.all_apps") }] : []),
                  ...availableApps.map((app) => ({ id: app.id, label: sessionAppLabel(app.id) })),
                ]}
                value={activeApp}
                onChange={(app) => {
                  const next = listLocation();
                  const params = new URLSearchParams(next.search);
                  params.set("app", app);
                  navigate({ ...next, search: params.toString() }, { replace: true });
                  setSearch("");
                }}
                label={copy("clisessions.title")}
                panelId="cli-sessions-panel"
              />
            ) : null}
            {apps !== null && availableApps.length === 0 ? (
              <span className="py-2 text-xs text-oai-gray-500">
                {copy("clisessions.no_apps")}
              </span>
            ) : null}
          </div>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative min-w-0 flex-1 basis-48">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-3 text-oai-gray-500"
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
                  className={`min-h-10 rounded-md px-3 text-xs font-medium transition-colors ${mode === value ? "bg-oai-white shadow-sm dark:bg-oai-gray-700" : "text-oai-gray-600 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-oai-white"}`}
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
            <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {listError}
            </p>
          ) : null}
          {selectedId && sessions !== null && !loading && !listError && !selected ? (
            <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              <span>{copy("clisessions.unavailable")}</span>
              <Button variant="secondary" size="sm" onClick={() => navigate(listLocation(), { replace: true })}>{copy("clisessions.back")}</Button>
            </div>
          ) : null}
        </div>
        <div
          id="cli-sessions-panel"
          role={availableApps.length > 0 ? "tabpanel" : undefined}
          aria-labelledby={availableApps.length > 0 ? `cli-sessions-panel-${activeApp}` : undefined}
          className="flex min-h-64 flex-1 flex-col overflow-hidden rounded-xl border border-oai-gray-200 bg-oai-white dark:border-oai-gray-800 dark:bg-oai-gray-900"
        >
          {!selected && (sessions === null || filtered.length === 0) ? (
            <div className="px-5 py-16 text-center text-sm text-oai-gray-600 dark:text-oai-gray-400">
              <History size={28} className="mx-auto mb-4 text-oai-gray-400 dark:text-oai-gray-500" aria-hidden />
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
        </div>
      </div>
      {selected ? (
        <SessionReader
          key={sessionKey(selected)}
          session={selected}
          messages={messages}
          usage={usage}
          error={readError}
          onBack={backToList}
          onReload={() => void loadTranscript(selected)}
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
