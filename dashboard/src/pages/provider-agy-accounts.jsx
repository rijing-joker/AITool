import React, { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";
import { getLocalApiAuthHeaders } from "../lib/local-api-auth";
import { Button, Card, ConfirmModal } from "../ui/components";
import { useVisiblePolling } from "../hooks/use-visible-polling";
import { usePrivacyText } from "../lib/proxy-privacy";

async function api(route = "", method = "GET", body) {
  const response = await fetch(`/api/provider-switch/agy/accounts${route}`, { method, headers: { ...await getLocalApiAuthHeaders(), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json(); if (!payload.ok) throw new Error(payload.error || copy("pswitch.agy.account.error")); return payload;
}
export function ProviderAgyAccounts() {
  const [data, setData] = useState(null);
  const display = usePrivacyText(data?.accounts.flatMap(row => [row.email, row.name, row.id].filter(Boolean)) || []);
  const operation = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flow, setFlow] = useState(null);
  const [quotas, setQuotas] = useState({});
  const [removing, setRemoving] = useState(null);
  const load = useCallback(async () => { try { setData(await api()); } catch (reason) { setError(String(reason)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const poll = useCallback(async () => {
    if (!flow) return;
    const result = await api(`/login?flowId=${encodeURIComponent(flow.flowId)}`);
    if (result.status !== "pending" && result.status !== "working") { setFlow(null); if (result.status === "success") await load(); else setError(copy("pswitch.agy.account.error")); }
  }, [flow, load]);
  useVisiblePolling(poll, 2000);
  const activeFlow = useRef(null);
  activeFlow.current = flow;
  useEffect(() => () => { if (activeFlow.current) void api("/login", "DELETE").catch(() => {}); }, []);
  const run = async action => { if (operation.current) return; operation.current = true; setBusy(true); setError(""); try { await action(); } catch (reason) { setError(String(reason)); } finally { operation.current = false; setBusy(false); } };
  return <Card className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-semibold">{copy("pswitch.agy.account.title")}</h2>
      <Button size="sm" variant="secondary" disabled={busy || !data?.supported} onClick={() => void run(async () => setFlow(await api("/login", "POST")))}>{copy("pswitch.agy.account.add")}</Button>
    </div>
    <p className="text-xs text-oai-gray-500">{copy(data?.supported ? "pswitch.agy.account.local" : "pswitch.agy.account.macos")}</p>
    {flow ? <div className="flex flex-wrap items-center gap-3"><a href={flow.authUrl} target="_blank" rel="noreferrer" className="text-sm underline">{copy("pswitch.agy.account.browser")}</a><Button size="sm" variant="secondary" onClick={() => void run(async () => { await api("/login", "DELETE"); setFlow(null); })}>{copy("shared.cancel")}</Button></div> : null}
    {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
    {data?.accounts.map(row => <div key={row.id} className="space-y-2 border-t border-oai-gray-200 pt-3 dark:border-oai-gray-800">
      <div className="flex flex-wrap items-center gap-2"><span className="w-full min-w-0 break-words text-sm sm:w-auto sm:flex-1">{display(row.email || row.name || row.id)}</span>
        <Button size="sm" variant="secondary" disabled={busy || !data.supported || row.id === data.currentAccountId || row.requiresReauth} onClick={() => void run(async () => { await api("/switch", "POST", { id: row.id }); await load(); })}>{copy(row.id === data.currentAccountId ? "pswitch.agy.account.current" : "pswitch.agy.account.switch")}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => { const response = await api(`/quota?id=${encodeURIComponent(row.id)}`); setQuotas(current => ({ ...current, [row.id]: response.quota })); })}>{copy("pswitch.agy.account.quota")}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRemoving(row)}>{copy("pswitch.agy.account.remove")}</Button>
      </div>
      {row.requiresReauth ? <p className="text-xs text-amber-700 dark:text-amber-400">{copy("pswitch.agy.account.reauth")}</p> : null}
      {quotas[row.id]?.groups.flatMap(group => group.buckets.map((bucket, index) => <div key={`${bucket.bucketId}:${index}`} className="flex flex-wrap justify-between gap-3 text-xs text-oai-gray-500"><span>{bucket.bucketId || group.displayName}</span><span>{bucket.remainingFraction == null ? copy("shared.placeholder.short") : copy("pswitch.agy.account.remaining", { value: Math.round(bucket.remainingFraction * 100) })}{bucket.resetTime && Number.isFinite(Date.parse(bucket.resetTime)) ? ` · ${new Date(bucket.resetTime).toLocaleString()}` : ""}</span></div>))}
    </div>)}
    <ConfirmModal open={Boolean(removing)} busy={busy} title={copy("pswitch.agy.account.remove")} description={copy("pswitch.agy.account.removeHint")} confirmLabel={copy("pswitch.agy.account.remove")} cancelLabel={copy("shared.cancel")} destructive onCancel={() => setRemoving(null)} onConfirm={() => void run(async () => { await api("", "DELETE", { id: removing.id }); setRemoving(null); await load(); })} />
  </Card>;
}

export function AgyAccountSelect({ value, onChange }) {
  const [data, setData] = useState(null);
  const display = usePrivacyText(data?.accounts.flatMap(row => [row.email, row.name, row.id].filter(Boolean)) || []);
  const [error, setError] = useState("");
  useEffect(() => { let alive = true; api().then(result => { if (alive) setData(result); }).catch(() => { if (alive) setError(copy("pswitch.agy.account.error")); }); return () => { alive = false; }; }, []);
  function matchesAccount(row) { return row.id === value; }
  const missing = value && !data?.accounts.some(matchesAccount);
  return <label className="block space-y-1 text-sm">{copy("pswitch.agy.account.binding")}
    <select value={value || ""} onChange={event => onChange(event.target.value || undefined)} className="block w-full rounded-lg border border-oai-gray-200 bg-transparent p-2 dark:border-oai-gray-700">
      <option value="">{copy("pswitch.agy.account.follow")}</option>
      {data?.accounts.map(row => <option key={row.id} value={row.id} disabled={row.requiresReauth}>{display(row.email || row.name || row.id)}</option>)}
      {missing ? <option value={value}>{copy("pswitch.agy.account.missing")}</option> : null}
    </select>
    <span className="block text-xs text-oai-gray-500">{error || copy("pswitch.agy.account.bindingHint")}</span>
  </label>;
}
