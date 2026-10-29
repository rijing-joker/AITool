import React, { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";
import { getLocalApiAuthHeaders } from "../lib/local-api-auth";
import { Button, Card, ConfirmModal } from "../ui/components";
import { useVisiblePolling } from "../hooks/use-visible-polling";
import { usePrivacyText } from "../lib/proxy-privacy";

async function api(route = "", method = "GET", body) {
  const response = await fetch(`/api/provider-switch/claude/accounts${route}`, { method, headers: { ...await getLocalApiAuthHeaders(), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json(); if (!payload.ok) throw new Error(payload.error || copy("pswitch.claude.account.error")); return payload;
}
export function ProviderClaudeAccounts() {
  const [data, setData] = useState(null);
  const display = usePrivacyText(data?.accounts.flatMap(row => [row.email, row.name, row.id].filter(Boolean)) || []);
  const operation = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flow, setFlow] = useState(null);
  const [callback, setCallback] = useState("");
  const [quotas, setQuotas] = useState({});
  const [removing, setRemoving] = useState(null);
  const load = useCallback(async () => { try { setData(await api()); } catch (reason) { setError(String(reason)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const poll = useCallback(async () => {
    if (!flow) return;
    const result = await api(`/login?flowId=${encodeURIComponent(flow.flowId)}`);
    setFlow(current => current?.flowId === result.flowId ? { ...current, ...result } : current);
    if (result.status !== "pending" && result.status !== "working") { setFlow(null); if (result.status === "success") await load(); else setError(copy("pswitch.claude.account.error")); }
  }, [flow, load]);
  useVisiblePolling(poll, 2000);
  const activeFlow = useRef(null);
  activeFlow.current = flow;
  useEffect(() => () => { if (activeFlow.current) void api("/login", "DELETE", { flowId: activeFlow.current.flowId }).catch(() => {}); }, []);
  const run = async action => { if (operation.current) return; operation.current = true; setBusy(true); setError(""); try { await action(); } catch (reason) { setError(String(reason)); } finally { operation.current = false; setBusy(false); } };
  return <Card className="mb-4 space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-semibold">{copy("pswitch.claude.account.title")}</h2>
      <Button size="sm" variant="secondary" disabled={busy || !data?.supported} onClick={() => void run(async () => setFlow(await api("/login", "POST")))}>{copy("pswitch.claude.account.add")}</Button>
    </div>
    <p className="text-xs text-oai-gray-500">{copy("pswitch.claude.account.local")}</p>
    {!data && !error ? <p role="status" className="text-sm">{copy("shared.loading")}</p> : null}
    {data?.recoveryRequired ? <Button variant="secondary" disabled={busy} onClick={() => void run(async () => { await api("/recover", "POST"); await load(); })}>{copy("pswitch.claude.account.recover")}</Button> : null}
    {flow ? <div className="flex flex-wrap items-center gap-3">{flow.authUrl ? <a href={flow.authUrl} target="_blank" rel="noreferrer" className="text-sm underline">{copy("pswitch.claude.account.browser")}</a> : <span role="status" className="text-sm">{copy("shared.loading")}</span>}<Button size="sm" variant="secondary" onClick={() => void run(async () => { await api("/login", "DELETE", { flowId: flow.flowId }); setFlow(null); })}>{copy("shared.cancel")}</Button></div> : null}
    {flow?.authUrl ? <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void run(async () => { await api("/paste", "POST", { flowId: flow.flowId, value: callback }); setCallback(""); }); }}><input className="min-h-10 min-w-0 flex-1 rounded-lg border border-oai-gray-300 bg-transparent px-3 text-base dark:border-oai-gray-700" aria-label={copy("pswitch.claude.account.callback")} placeholder={copy("pswitch.claude.account.callback")} value={callback} onChange={event => setCallback(event.target.value)} /><Button type="submit" disabled={busy || !callback.trim()}>{copy("pswitch.claude.account.submit")}</Button></form> : null}
    {error ? <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    {data?.accounts.length === 0 ? <p className="text-sm text-oai-gray-500">{copy("pswitch.claude.account.empty")}</p> : null}
    {data?.accounts.map(row => <div key={row.id} className="space-y-2 border-t border-oai-gray-200 pt-3 dark:border-oai-gray-800">
      <div className="flex flex-wrap items-center gap-2"><span className="w-full min-w-0 break-words text-sm sm:w-auto sm:flex-1">{display(row.email || row.name || row.id)}</span>
        <Button size="sm" variant="secondary" disabled={busy || !data.switchSupported || data.recoveryRequired || row.id === data.currentAccountId || row.requiresReauth} onClick={() => void run(async () => { await api("/switch", "POST", { id: row.id }); await load(); })}>{copy(row.id === data.currentAccountId ? "pswitch.claude.account.current" : "pswitch.claude.account.switch")}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => { const response = await api(`/quota?id=${encodeURIComponent(row.id)}`); setQuotas(current => ({ ...current, [row.id]: response.quota })); })}>{copy("pswitch.claude.account.quota")}</Button>
        <Button size="sm" variant="secondary" disabled={busy || row.requiresReauth || data.recoveryRequired} onClick={() => void run(async () => { await api("/launch", "POST", { id: row.id }); await load(); })}>{copy("pswitch.claude.account.launch")}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRemoving(row)}>{copy("pswitch.claude.account.remove")}</Button>
      </div>
      {row.requiresReauth ? <p className="text-xs text-amber-700 dark:text-amber-400">{copy("pswitch.claude.account.reauth")}</p> : null}
      {quotas[row.id]?.tiers?.map(tier => <div key={tier.id} className="flex flex-wrap justify-between gap-3 text-xs text-oai-gray-500"><span>{tier.label}</span><span>{copy("pswitch.claude.account.used", { value: Math.round(tier.used_percent) })}{tier.reset_at && Number.isFinite(Date.parse(tier.reset_at)) ? ` · ${new Date(tier.reset_at).toLocaleString()}` : ""}</span></div>)}
    </div>)}
    <ConfirmModal open={Boolean(removing)} busy={busy} title={copy("pswitch.claude.account.remove")} description={copy("pswitch.claude.account.removeHint")} confirmLabel={copy("pswitch.claude.account.remove")} cancelLabel={copy("shared.cancel")} destructive onCancel={() => setRemoving(null)} onConfirm={() => void run(async () => { await api("", "DELETE", { id: removing.id }); setRemoving(null); await load(); })} />
  </Card>;
}

export function ClaudeAccountSelect({ value, onChange }) {
  const [data, setData] = useState(null);
  const display = usePrivacyText(data?.accounts.flatMap(row => [row.email, row.name, row.id].filter(Boolean)) || []);
  const [error, setError] = useState("");
  useEffect(() => { let alive = true; api().then(result => { if (alive) setData(result); }).catch(() => { if (alive) setError(copy("pswitch.claude.account.error")); }); return () => { alive = false; }; }, []);
  function matchesAccount(row) { return row.id === value; }
  const missing = value && !data?.accounts.some(matchesAccount);
  return <label className="block space-y-1 text-sm">{copy("pswitch.claude.account.binding")}
    <select value={value || ""} onChange={event => onChange(event.target.value || undefined)} className="block w-full rounded-lg border border-oai-gray-200 bg-transparent p-2 dark:border-oai-gray-700">
      <option value="">{copy("pswitch.claude.account.follow")}</option>
      {data?.accounts.map(row => <option key={row.id} value={row.id} disabled={row.requiresReauth}>{display(row.email || row.name || row.id)}</option>)}
      {missing ? <option value={value}>{copy("pswitch.claude.account.missing")}</option> : null}
    </select>
    <span className="block text-xs text-oai-gray-500">{error || copy("pswitch.claude.account.bindingHint")}</span>
  </label>;
}
