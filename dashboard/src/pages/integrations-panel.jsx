import React, { useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";
import { integrationsApi } from "../lib/proxy-api";
import { Button, Card } from "../ui/components";
const choices = [{ id: "magpie", key: "proxy.integration.magpie" }, { id: "workbuddy", key: "proxy.desktop.workbuddy" }, { id: "workbuddy-ai", key: "proxy.desktop.workbuddy_ai" }];
export function IntegrationsPanel({ onChanged }) {
  const [kind, setKind] = useState("magpie"), [status, setStatus] = useState(null), [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState([]), [login, setLogin] = useState(null), [quota, setQuota] = useState(null);
  const [apiKey, setApiKey] = useState(""), [freeOnly, setFreeOnly] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false);
  const load = async () => setStatus(await integrationsApi.status());
  useEffect(() => { void load().catch(failure => setError(failure.message)); }, []);
  const current = status?.[kind === "workbuddy-ai" ? "workbuddyAI" : kind];
  useEffect(() => { setFreeOnly(current?.freeOnly === true); setApiKey(""); }, [kind, current?.freeOnly]);
  const run = async action => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action(); } catch (failure) { setError(failure.message || String(failure)); }
    finally { pending.current = false; setBusy(false); }
  };
  const action = async (name, values = {}) => (await integrationsApi.action(kind, name, values)).result;
  const discover = () => run(async () => {
    const next = await action(kind === "magpie" ? "discover" : "catalog"); setCatalog(next);
    setSelected((current?.models || []).filter(id => next.models.some(model => model.id === id)));
  });
  const save = enabled => run(async () => { await action("configure", { enabled, models: selected, ...(kind === "workbuddy" || kind === "workbuddy-ai" ? { freeOnly } : {}), revision: catalog?.revision }); await load(); await onChanged?.(); });
  return <Card>
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">{copy("proxy.integration.title")}</h3><span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy(current?.enabled ? "proxy.integration.enabled" : "proxy.integration.disabled")}</span></div>
    <label className="mt-3 flex max-w-sm flex-col gap-1 text-xs"><span>{copy("proxy.integration.source")}</span><select value={kind} disabled={busy} className="h-10 rounded-lg border border-oai-gray-200 bg-transparent px-3 dark:border-oai-gray-700" onChange={event => { setKind(event.currentTarget.value); setCatalog(null); setSelected([]); setLogin(null); setQuota(null); setError(""); }}>{choices.map(row => <option key={row.id} value={row.id}>{copy(row.key)}</option>)}</select></label>
    <p className="mt-3 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy(kind === "magpie" ? "proxy.integration.magpie_hint" : "proxy.integration.buddy_hint")}</p>
    {kind === "magpie" && current?.directory ? <p className="mt-2 break-all font-mono text-xs text-oai-gray-500 dark:text-oai-gray-400">{current.directory}</p> : null}
    {kind !== "magpie" ? <div className="mt-3 flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => setLogin(await action("begin")))}>{copy("proxy.integration.browser_login")}</Button>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => { await action("desktop"); await load(); })}>{copy("proxy.integration.desktop_login")}</Button>
      {current?.signedIn ? <><Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => setQuota(await action("quota")))}>{copy("proxy.integration.quota")}</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => { await action("forget"); await load(); setCatalog(null); await onChanged?.(); })}>{copy("proxy.integration.forget")}</Button></> : null}
    </div> : null}
    {kind !== "magpie" ? <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-end gap-2"><label className="flex min-w-0 flex-1 flex-col gap-1 text-xs"><span>{copy("proxy.keys.keyLabel")}</span><input type="password" autoComplete="off" value={apiKey} disabled={busy} onChange={event => setApiKey(event.target.value)} className="h-10 rounded-lg border border-oai-gray-200 bg-transparent px-3 dark:border-oai-gray-700" /></label><Button size="sm" variant="secondary" disabled={busy || !apiKey.trim()} onClick={() => void run(async () => { await action("key", { apiKey }); setApiKey(""); setCatalog(null); await load(); })}>{copy("proxy.integration.key_login")}</Button></div>
      <label className="flex min-h-10 items-center gap-2 text-xs"><input type="checkbox" checked={freeOnly} disabled={busy} onChange={event => { setFreeOnly(event.target.checked); if (event.target.checked) setSelected(previous => previous.filter(id => catalog?.models?.find(row => row.id === id)?.free === true)); }} />{copy("proxy.integration.free_only")}</label>
      {freeOnly ? <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.integration.free_hint")}</p> : null}
    </div> : null}
    {login ? <div className="mt-3 flex flex-wrap items-center gap-3"><a className="break-all text-sm text-oai-brand-600 underline underline-offset-4" href={login.url} target="_blank" rel="noreferrer">{copy("proxy.integration.open_login")}</a><Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => { const result = await action("poll", { id: login.id }); if (!result.pending) { setLogin(null); await load(); } })}>{copy("proxy.integration.check_login")}</Button><span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.integration.login_pending")}</span></div> : null}
    {quota ? <p role="status" className="mt-3 text-sm">{quota.total == null ? quota.balance != null ? copy("proxy.integration.wallet", { balance: quota.balance }) : copy("proxy.integration.quota_unknown") : copy("proxy.integration.quota_value", { used: quota.used, total: quota.total })}</p> : null}
    <div className="mt-4 flex flex-wrap gap-2"><Button variant="secondary" size="sm" disabled={busy || (kind !== "magpie" && !current?.signedIn)} onClick={() => void discover()}>{copy("proxy.integration.discover")}</Button><Button size="sm" disabled={busy || !selected.length || !catalog} onClick={() => void save(true)}>{copy(current?.enabled ? "proxy.integration.save" : "proxy.integration.enable")}</Button>{current?.enabled ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void save(false)}>{copy("proxy.integration.disable")}</Button> : null}</div>
    {catalog?.models ? <fieldset className="mt-3"><legend className="mb-1 text-xs font-medium">{copy("proxy.desktop.select_models")}</legend><div className="max-h-60 overflow-y-auto">{catalog.models.map(row => <label key={row.id} className="flex min-h-10 items-center gap-2 text-xs"><input className="h-4 w-4 shrink-0 accent-oai-brand-600" type="checkbox" disabled={busy || (freeOnly && row.free !== true)} checked={selected.includes(row.id)} onChange={event => { const checked = event.currentTarget.checked; setSelected(previous => checked ? [...previous, row.id] : previous.filter(id => id !== row.id)); }} /><span className="break-all font-mono">{row.id}</span>{kind !== "magpie" && row.free !== true ? <span className="text-oai-gray-500">{copy("proxy.integration.paid_model")}</span> : null}</label>)}</div></fieldset> : null}
    <p className="mt-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.integration.accounting")}</p>
    {(error || current?.error) ? <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error || current.error}</p> : null}
  </Card>;
}
