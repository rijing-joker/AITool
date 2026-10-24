import React, { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";
import { getLocalApiAuthHeaders } from "../lib/local-api-auth";
import { Button, Card, ConfirmModal } from "../ui/components";
import { useVisiblePolling } from "../hooks/use-visible-polling";
import { usePrivacyText } from "../lib/proxy-privacy";

async function api(route = "", method = "GET", body) {
  const response = await fetch(`/api/provider-switch/kimi/accounts${route}`, { method, headers: { ...await getLocalApiAuthHeaders(), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || copy("pswitch.kimi.account.error"));
  return payload;
}

export function ProviderKimiAccounts() {
  const [data, setData] = useState(null);
  const display = usePrivacyText(data?.accounts.flatMap(row => [row.name, row.nickname, row.id].filter(Boolean)) || []);
  const operation = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [region, setRegion] = useState("cn");
  const [flow, setFlow] = useState(null);
  const [quotas, setQuotas] = useState({});
  const [removing, setRemoving] = useState(null);
  const load = useCallback(async () => { try { setData(await api()); } catch (reason) { setError(String(reason.message || reason)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const poll = useCallback(async () => {
    if (!flow) return;
    try {
      const result = await api(`/login?flowId=${encodeURIComponent(flow.flowId)}`);
      if (result.status === "pending") return;
      if (result.status === "success") { setFlow(null); await load(); return; }
      if (["expired", "denied", "cancelled"].includes(result.status)) { setFlow(null); setError(copy(`pswitch.kimi.account.${result.status}`)); }
    } catch (reason) { setError(String(reason.message || reason)); }
  }, [flow, load]);
  useVisiblePolling(poll, Math.max(1500, Math.round((flow?.interval || 5) * 1000)));
  const activeFlow = useRef(null);
  activeFlow.current = flow;
  useEffect(() => () => { if (activeFlow.current) void api("/login", "DELETE").catch(() => {}); }, []);
  const run = async action => { if (operation.current) return; operation.current = true; setBusy(true); setError(""); try { await action(); } catch (reason) { setError(String(reason.message || reason)); } finally { operation.current = false; setBusy(false); } };
  const signIn = accountId => void run(async () => { setFlow(await api("/login", "POST", accountId ? { region, accountId } : { region })); });
  return <Card className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-sm font-semibold">{copy("pswitch.kimi.account.title")}</h2>
      <div className="flex items-center gap-2">
        <select aria-label={copy("pswitch.kimi.account.region")} value={region} onChange={event => setRegion(event.target.value)} disabled={Boolean(flow) || busy} className="rounded-lg border border-oai-gray-200 bg-transparent p-1.5 text-xs dark:border-oai-gray-700">
          <option value="cn">{copy("pswitch.kimi.account.region.cn")}</option>
          <option value="global">{copy("pswitch.kimi.account.region.global")}</option>
        </select>
        <Button size="sm" variant="secondary" disabled={busy || Boolean(flow)} onClick={() => signIn(null)}>{copy("pswitch.kimi.account.add")}</Button>
      </div>
    </div>
    <p className="text-xs text-oai-gray-500">{copy("pswitch.kimi.account.hint")}</p>
    {flow ? <div className="space-y-2 border-t border-oai-gray-200 pt-3 dark:border-oai-gray-800">
      <p className="text-sm"><a href={flow.verificationUri} target="_blank" rel="noreferrer" className="underline">{copy("pswitch.kimi.account.verify")}</a></p>
      <p className="font-mono text-lg tracking-widest">{flow.userCode}</p>
      <Button size="sm" variant="secondary" onClick={() => void run(async () => { await api("/login", "DELETE"); setFlow(null); })}>{copy("shared.cancel")}</Button>
    </div> : null}
    {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
    {data?.accounts.map(row => <div key={row.id} className="space-y-2 border-t border-oai-gray-200 pt-3 dark:border-oai-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-full min-w-0 break-words text-sm sm:w-auto sm:flex-1">{display(row.name || row.id)}{row.primary ? ` · ${copy("pswitch.kimi.account.primary")}` : ""}</span>
        <span className="rounded bg-oai-gray-100 px-1.5 py-0.5 text-xs text-oai-gray-500 dark:bg-oai-gray-800">{copy(`pswitch.kimi.account.region.${row.region}`)}</span>
        <Button size="sm" variant="secondary" disabled={busy || row.id === data.currentAccountId || !row.authenticated} onClick={() => void run(async () => { await api("/use", "POST", { id: row.id }); await load(); })}>{copy(row.id === data.currentAccountId ? "pswitch.kimi.account.current" : "pswitch.kimi.account.use")}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => { const response = await api(`/quota?id=${encodeURIComponent(row.id)}`); setQuotas(current => ({ ...current, [row.id]: response.quota })); })}>{copy("pswitch.kimi.account.quota")}</Button>
        <Button size="sm" variant="secondary" disabled={busy || Boolean(flow)} onClick={() => signIn(row.id)}>{copy("pswitch.kimi.account.relogin")}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRemoving(row)}>{copy("pswitch.kimi.account.remove")}</Button>
      </div>
      {!row.authenticated ? <p className="text-xs text-amber-700 dark:text-amber-400">{row.error || copy("pswitch.kimi.account.reauth")}</p> : null}
      {(quotas[row.id]?.tiers || []).map((tier, index) => <div key={`${tier.id}:${index}`} className="flex flex-wrap justify-between gap-3 text-xs text-oai-gray-500">
        <span>{tier.label}</span>
        <span>{Number.isFinite(tier.usedPercent) ? copy("pswitch.kimi.account.used", { value: Math.round(tier.usedPercent) }) : copy("shared.placeholder.short")}{tier.resetsAt && Number.isFinite(Date.parse(tier.resetsAt)) ? ` · ${new Date(tier.resetsAt).toLocaleString()}` : ""}</span>
      </div>)}
      {quotas[row.id] && quotas[row.id].credentialStatus && quotas[row.id].credentialStatus !== "valid" ? <p className="text-xs text-amber-700 dark:text-amber-400">{quotas[row.id].message || copy("pswitch.kimi.account.reauth")}</p> : null}
    </div>)}
    <ConfirmModal open={Boolean(removing)} busy={busy} title={copy("pswitch.kimi.account.remove")} description={copy("pswitch.kimi.account.removeHint")} confirmLabel={copy("pswitch.kimi.account.remove")} cancelLabel={copy("shared.cancel")} destructive onCancel={() => setRemoving(null)} onConfirm={() => void run(async () => { await api("", "DELETE", { id: removing.id }); setRemoving(null); await load(); })} />
  </Card>;
}
