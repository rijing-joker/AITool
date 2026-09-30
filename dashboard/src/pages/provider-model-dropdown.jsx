import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { copy } from "../lib/copy";

// Port of cc-switch's ModelInputWithFetch + ModelDropdown: a model input with
// a trailing icon button that is a fetch action while idle, a spinner while
// the request runs, and a searchable dropdown once models are fetched
// (cc-switch groups by vendor; the fetch-models endpoint here returns bare
// ids, so the list stays flat).

export function ModelDropdown({ models, onSelect }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = Array.isArray(models) ? models : [];
    if (!q) return list;
    return list.filter((model) => String(model).toLowerCase().includes(q));
  }, [models, query]);

  let hasMatches = false;
  for (const model of filtered) {
    if (model) hasMatches = true;
  }

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={copy("pswitch.models.dropdown_aria")}
        aria-expanded={open}
        className="inline-flex h-[38px] w-9 shrink-0 items-center justify-center rounded-lg border border-oai-gray-200 text-oai-gray-500 transition-colors hover:border-oai-gray-300 hover:text-oai-black dark:border-oai-gray-800 dark:text-oai-gray-400 dark:hover:text-white"
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      {open ? (
        <div className="absolute right-0 z-30 mt-1 w-72 overflow-hidden rounded-xl border border-oai-gray-200 bg-white shadow-xl dark:border-oai-gray-800 dark:bg-oai-gray-900">
          <div className="border-b border-oai-gray-100 p-2 dark:border-oai-gray-800">
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={copy("pswitch.models.search")}
              aria-label={copy("pswitch.models.search")}
              autoFocus
              className="w-full rounded-lg border border-oai-gray-200 bg-white px-2.5 py-1.5 text-xs text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:text-white"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {hasMatches ? (
              filtered.map((model) => (
                <button
                  key={model}
                  type="button"
                  onClick={() => {
                    onSelect(model);
                    setOpen(false);
                  }}
                  className="block w-full truncate px-3 py-1.5 text-left font-mono text-xs text-oai-gray-700 transition-colors hover:bg-oai-gray-100 hover:text-oai-black dark:text-oai-gray-300 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                >
                  {model}
                </button>
              ))
            ) : (
              <p className="px-3 py-2 text-xs text-oai-gray-400 dark:text-oai-gray-500">
                {copy("pswitch.models.none")}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// The three-state trailing icon for a model input: fetch action, spinner, or
// the fetched-models dropdown (cc-switch's ModelInputWithFetch).
export function ModelInputAction({ models, fetchState, onFetch, onSelect }) {
  const loading = fetchState === "loading";
  const fetched = Array.isArray(models) && models.length !== 0;
  if (fetched) {
    return <ModelDropdown models={models} onSelect={onSelect} />;
  }
  if (loading) {
    return (
      <span className="inline-flex h-[38px] w-9 shrink-0 items-center justify-center rounded-lg border border-oai-gray-200 text-oai-gray-400 dark:border-oai-gray-800" aria-label={copy("pswitch.models.fetching")}>
        <Loader2 className="h-4 w-4 animate-spin" />
      </span>
    );
  }
  if (onFetch) {
    return (
      <button
        type="button"
        onClick={onFetch}
        aria-label={copy("pswitch.models.fetch")}
        title={copy("pswitch.models.fetch")}
        className="inline-flex h-[38px] w-9 shrink-0 items-center justify-center rounded-lg border border-oai-gray-200 text-oai-gray-500 transition-colors hover:border-oai-gray-300 hover:text-oai-black dark:border-oai-gray-800 dark:text-oai-gray-400 dark:hover:text-white"
      >
        <Download className="h-4 w-4" />
      </button>
    );
  }
  return null;
}

export default ModelDropdown;
