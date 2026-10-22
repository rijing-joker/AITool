import React, { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { Button } from "../ui/components";
import { ModalFrame } from "../ui/components/ModalFrame";
import { useVisiblePolling } from "../hooks/use-visible-polling";
export function ProviderQuickSwitch() {
  const [open, setOpen] = useState(() => window.__aitoolProvidersPending === true || new URLSearchParams(window.location.search).get("quick") === "providers");
  const [data, setData] = useState(null);
  const [app, setApp] = useState("claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef(false);
  const load = useCallback(async () => { if (open) { try { const next = await providerSwitchApi.getStatus(); setData(next); setApp(current => next.apps.some(row => row.app === current && next.visibleApps?.[row.app] !== false) ? current : next.apps.find(row => next.visibleApps?.[row.app] !== false)?.app || current); } catch { setError(copy("pswitch.quick.error")); } } }, [open]);
  useEffect(() => { const show = () => { window.__aitoolProvidersPending = false; setOpen(true); }; window.addEventListener("native:providers", show); if (window.__aitoolProvidersPending) show(); return () => window.removeEventListener("native:providers", show); }, []);
  useEffect(() => { if (open) void load(); }, [open, load]);
  useVisiblePolling(load, 10000);
  const select = async row => {
    if (operation.current) return; operation.current = true; setBusy(true); setError("");
    try { if (app === "agy") await providerSwitchApi.launchAgy(row.id); else await providerSwitchApi.switchProvider(app, row.id); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : copy("pswitch.quick.error")); }
    finally { operation.current = false; setBusy(false); }
  };
  function matchesApp(row) { return row.app === app; }
  const current = data?.apps.find(matchesApp);
  return <ModalFrame open={open} busy={busy} label={copy("pswitch.quick.title")} onClose={() => setOpen(false)} className="max-w-md">
    <header className="flex items-center justify-between p-4"><h2 className="text-sm font-semibold">{copy("pswitch.quick.title")}</h2><Button variant="secondary" size="sm" aria-label={copy("shared.cancel")} disabled={busy} onClick={() => setOpen(false)}><X size={16} /></Button></header>
    <div className="space-y-3 overflow-y-auto px-4 pb-4">
      <label className="block text-xs text-oai-gray-500">{copy("pswitch.quick.app")}<select className="mt-1 block w-full rounded-lg border border-oai-gray-200 bg-transparent p-2 dark:border-oai-gray-700" disabled={busy} value={app} onChange={event => setApp(event.target.value)}>{data?.apps.filter(row => data.visibleApps?.[row.app] !== false).map(row => <option key={row.app} value={row.app}>{copy(`pswitch.tab.${row.app}`)}</option>)}</select></label>
      {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
      {current?.providers.map(row => <Button key={row.id} variant={current.current === row.id ? "primary" : "secondary"} className="w-full justify-between" disabled={busy || row.builtinIdConflict} onClick={() => void select(row)}><span className="truncate">{row.name}</span><span className="text-xs">{copy(app === "agy" ? "pswitch.agy.launch" : current.current === row.id ? "pswitch.agy.account.current" : "pswitch.agy.account.switch")}</span></Button>)}
      {current && !current.providers.length ? <p className="text-xs text-oai-gray-500">{copy("pswitch.quick.empty")}</p> : null}
    </div>
  </ModalFrame>;
}
