import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, LoaderCircle, Plus, X } from "lucide-react";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { Button } from "../ui/components";

// Endpoint manage + speed test — an interaction port of cc-switch's
// EndpointSpeedTest: add/remove candidate endpoints, probe them all through
// the local CLI (browsers cannot reach arbitrary API hosts cross-origin),
// show colored latencies, optionally auto-pick the fastest into the field.

const TEST_TIMEOUT_BY_APP = { claude: 8000, codex: 12000, gemini: 8000 };

function latencyClass(latencyMs) {
  if (latencyMs < 300) return "text-emerald-600 dark:text-emerald-400";
  if (latencyMs < 500) return "text-oai-amber dark:text-oai-amber-light";
  if (latencyMs < 800) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

function normalizeUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

export function EndpointSpeedTestDialog({ open, app, currentUrl, presetCandidates = [], onClose }) {
  const [list, setList] = useState([]);
  const [draft, setDraft] = useState("");
  const [listError, setListError] = useState(null);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState({});
  const [selected, setSelected] = useState("");
  const [autoSelect, setAutoSelect] = useState(false);
  const savedListRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const initial = [];
    for (const url of [normalizeUrl(currentUrl), ...presetCandidates.map(normalizeUrl)]) {
      if (url && !initial.includes(url)) initial.push(url);
    }
    setList(initial);
    savedListRef.current = new Set(initial);
    setSelected(normalizeUrl(currentUrl));
    setResults({});
    setDraft("");
    setListError(null);
    setAutoSelect(false);
  }, [open, currentUrl, presetCandidates]);

  const addDraft = useCallback(() => {
    const url = normalizeUrl(draft);
    if (!url) return;
    if (!/^https?:\/\//.test(url)) {
      setListError(copy("pswitch.speed.invalid_url"));
      return;
    }
    if (list.includes(url)) {
      setListError(copy("pswitch.speed.duplicate"));
      return;
    }
    setListError(null);
    setList((current) => [...current, url]);
    setDraft("");
  }, [draft, list]);

  const runTest = useCallback(async () => {
    if (!list.length || testing) return;
    setTesting(true);
    setResults({});
    try {
      const res = await providerSwitchApi.speedTest(list, TEST_TIMEOUT_BY_APP[app] || 8000);
      const next = {};
      for (const row of res.results) next[row.url] = row;
      setResults(next);
      if (autoSelect) {
        const ok = res.results.filter((row) => row.ok).sort((a, b) => a.latencyMs - b.latencyMs)[0];
        if (ok) setSelected(ok.url);
      }
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }, [app, autoSelect, list, testing]);

  const removeUrl = useCallback(
    (url) => {
      setList((current) => {
        const next = current.filter((item) => item !== url);
        if (selected === url) setSelected(next[0] || "");
        return next;
      });
    },
    [selected],
  );

  const finish = useCallback(
    (pick) => {
      const listChanged = list.length !== savedListRef.current?.size || list.some((url) => !savedListRef.current?.has(url));
      onClose(pick ? { url: pick, autoSelect } : null, listChanged, list);
    },
    [autoSelect, list, onClose],
  );

  const sortedForDisplay = useMemo(() => {
    // Untested rows keep insertion order; tested rows sort by latency.
    const tested = [];
    const untested = [];
    for (const url of list) {
      const row = results[url];
      if (row && row.ok) tested.push({ url, row });
      else untested.push({ url, row: row || null });
    }
    tested.sort((a, b) => a.row.latencyMs - b.row.latencyMs);
    return [...tested, ...untested];
  }, [list, results]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]">
      <div
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:ring-oai-gray-800"
        role="dialog"
        aria-modal="true"
        aria-label={copy("pswitch.speed.title")}
      >
        <div className="flex items-start justify-between gap-3 border-b border-oai-gray-100 px-5 py-4 dark:border-oai-gray-800">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-oai-black dark:text-white">{copy("pswitch.speed.title")}</h2>
            <p className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.speed.subtitle")}</p>
          </div>
          <button
            type="button"
            onClick={() => finish(false)}
            className="shrink-0 rounded-md p-1.5 text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-black dark:hover:bg-oai-gray-800 dark:hover:text-white"
            aria-label={copy("pswitch.action.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">
              {copy("pswitch.field.base_url")}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addDraft();
                  }
                }}
                placeholder="https://api.example.com"
                className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 font-mono text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
              />
              <Button variant="secondary" size="sm" onClick={addDraft} aria-label={copy("pswitch.speed.add")}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {listError ? (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
                {listError}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            {sortedForDisplay.length === 0 ? (
              <p className="py-4 text-center text-sm text-oai-gray-400">{copy("pswitch.speed.empty")}</p>
            ) : (
              sortedForDisplay.map(({ url, row }) => {
                const isSelected = selected === url;
                return (
                  <div
                    key={url}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors ${
                      isSelected
                        ? "border-oai-brand-500 bg-oai-brand-50/60 dark:bg-oai-brand-950/30"
                        : "border-oai-gray-200 dark:border-oai-gray-800"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelected(url)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      aria-pressed={isSelected}
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                          isSelected ? "border-oai-brand-500 bg-oai-brand-500 text-white" : "border-oai-gray-300 dark:border-oai-gray-600"
                        }`}
                      >
                        {isSelected ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-oai-gray-700 dark:text-oai-gray-300">
                        {url}
                      </span>
                      {testing && row == null ? (
                        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-oai-gray-400" />
                      ) : null}
                      {row ? (
                        row.ok ? (
                          <span className={`shrink-0 font-mono text-xs font-medium ${latencyClass(row.latencyMs)}`}>
                            {row.latencyMs}ms
                          </span>
                        ) : (
                          <span className="shrink-0 text-xs text-red-600 dark:text-red-400">
                            {copy("pswitch.speed.failed")}
                          </span>
                        )
                      ) : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeUrl(url)}
                      className="shrink-0 rounded-md p-1 text-oai-gray-300 transition-colors hover:bg-oai-gray-100 hover:text-red-500 dark:text-oai-gray-600 dark:hover:bg-oai-gray-800"
                      aria-label={copy("pswitch.speed.remove")}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-oai-gray-600 dark:text-oai-gray-300">
            <input
              type="checkbox"
              checked={autoSelect}
              onChange={(event) => setAutoSelect(event.target.checked)}
              className="h-4 w-4 rounded border-oai-gray-300 accent-oai-brand-500"
            />
            {copy("pswitch.speed.auto_select")}
          </label>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-oai-gray-100 px-5 py-3 dark:border-oai-gray-800">
          <Button variant="secondary" size="sm" disabled={testing || list.length === 0} onClick={() => void runTest()}>
            {testing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            {copy("pswitch.speed.test")}
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => finish(false)}>
              {copy("pswitch.action.cancel")}
            </Button>
            <Button size="sm" disabled={!selected} onClick={() => finish(selected)}>
              {copy("pswitch.speed.use_selected")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default EndpointSpeedTestDialog;
