import React, { useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { Button } from "../ui/components";

export function ProviderCodexGlobals() {
  const [state, setState] = useState(null);
  const [concurrency, setConcurrency] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = useRef(false);
  const reload = async () => {
    setError(null);
    try { const next = await providerSwitchApi.getCodexSubagents(); setState(next); setConcurrency(String(next.config.maxConcurrentThreadsPerSession ?? "")); }
    catch (error) { setError(error.message); }
  };
  useEffect(() => { void reload(); }, []);
  const save = async patch => {
    if (pending.current || !state) return;
    pending.current = true; setBusy(true); setError(null);
    try { const next = await providerSwitchApi.saveCodexSubagents({ ...state.config, ...patch }, state.revision); setState(next); setConcurrency(String(next.config.maxConcurrentThreadsPerSession ?? "")); }
    catch (error) { setError(error.message); }
    finally { pending.current = false; setBusy(false); }
  };
  const saveConcurrency = () => {
    const next = concurrency.trim() ? Number(concurrency) : null;
    if (next !== null && (!Number.isSafeInteger(next) || next < 1)) { setError(copy("pswitch.subagent.invalid_concurrency")); return; }
    if (next !== state.config.maxConcurrentThreadsPerSession) void save({ maxConcurrentThreadsPerSession: next });
  };
  return <details className="mb-4 rounded-xl border border-oai-gray-200 p-4 dark:border-oai-gray-800">
    <summary className="cursor-pointer text-sm font-medium">{copy("pswitch.subagent.global_title")}</summary>
    <p className="mt-2 text-xs text-oai-gray-500">{copy("pswitch.subagent.global_hint")}</p>
    {!state && !error ? <p className="mt-3 text-sm" role="status">{copy("shared.loading")}</p> : null}
    {state ? <fieldset disabled={busy} className="mt-3 grid gap-3 sm:grid-cols-3">
      <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={state.config.enabled} onChange={event => void save({ enabled: event.target.checked })} className="h-4 w-4 accent-oai-brand-600" />{copy("pswitch.subagent.enabled")}</label>
      <label className="space-y-1 text-sm"><span>{copy("pswitch.subagent.concurrency")}</span><input type="number" min="1" step="1" value={concurrency} onChange={event => setConcurrency(event.target.value)} onBlur={saveConcurrency} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} placeholder={copy("pswitch.subagent.inherit")} className="h-10 w-full rounded-lg border border-oai-gray-300 bg-transparent px-3 tabular-nums focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-700" /></label>
      <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={state.config.interruptMessage} onChange={event => void save({ interruptMessage: event.target.checked })} className="h-4 w-4 accent-oai-brand-600" />{copy("pswitch.subagent.interrupt")}</label>
    </fieldset> : null}
    {busy ? <p className="mt-2 text-xs" role="status">{copy("pswitch.action.saving")}</p> : null}
    {error ? <div className="mt-3 flex flex-wrap items-center gap-2"><p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p><Button variant="secondary" size="sm" disabled={busy} onClick={() => void reload()}>{copy("pswitch.action.reload")}</Button></div> : null}
  </details>;
}
