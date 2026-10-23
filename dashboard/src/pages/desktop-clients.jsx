import React, { useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";
import { proxyApi } from "../lib/proxy-api";
import { Button, Card } from "../ui/components";
const clients = [{ id: "workbuddy", key: "proxy.desktop.workbuddy" }, { id: "workbuddy-ai", key: "proxy.desktop.workbuddy_ai" }, { id: "zed", key: "proxy.desktop.zed" }];
const inputClass = "h-10 min-w-0 rounded-lg border border-oai-gray-200 bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700";

export function DesktopClients({ keys, remarks }) {
  const [client, setClient] = useState("workbuddy");
  const [key, setKey] = useState("");
  const [status, setStatus] = useState([]);
  const [models, setModels] = useState([]);
  const [selected, setSelected] = useState([]);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const load = async () => setStatus((await proxyApi.desktopClientStatus()).clients);
  useEffect(() => { void load().catch(() => {}); }, []);
  useEffect(() => { if (!keys?.includes(key)) { setKey(keys?.[0] || ""); setModels([]); setSelected([]); } }, [keys, key]);
  const run = async action => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; setBusy(false); }
  };
  const refresh = () => run(async () => {
    const result = await proxyApi.desktopClientModels(key);
    setModels(result.models); setSelected(previous => previous.filter(id => result.models.includes(id))); setModel(previous => result.models.includes(previous) ? previous : "");
  });
  const connect = () => run(async () => {
    await proxyApi.connectDesktopClient(client, key, selected, selected.includes(model) ? model : selected[0]);
    setNotice(copy(client === "zed" ? "proxy.desktop.zed_ready" : "proxy.desktop.buddy_ready")); await load();
  });
  const restore = () => run(async () => { await proxyApi.restoreDesktopClient(client); setNotice(copy("proxy.desktop.restored")); await load(); });
  const current = status.find(row => { return row.client === client; });
  return <Card>
    <p className="text-sm font-semibold">{copy("proxy.desktop.title")}</p>
    <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy(client === "zed" ? "proxy.desktop.zed_hint" : "proxy.desktop.buddy_hint")}</p>
    <div className="mt-4 flex flex-wrap items-end gap-3">
      <label className="flex min-w-0 flex-col gap-1 text-xs"><span>{copy("proxy.desktop.client")}</span><select className={inputClass} disabled={busy} value={client} onChange={event => { setClient(event.currentTarget.value); setNotice(""); setError(""); }}>{clients.map(item => <option key={item.id} value={item.id}>{copy(item.key)}</option>)}</select></label>
      <label className="flex min-w-0 flex-col gap-1 text-xs"><span>{copy("proxy.keys.keyLabel")}</span><select className={inputClass} disabled={busy || !keys?.length} value={key} onChange={event => { setKey(event.currentTarget.value); setModels([]); setSelected([]); setModel(""); }}>
        {!keys?.length ? <option value="">{copy("proxy.keys.empty")}</option> : null}
        {(keys || []).map((value, index) => <option key={value} value={value}>{remarks[value] || copy("proxy.copilot.key_number", { number: index + 1 })}</option>)}
      </select></label>
      <Button variant="secondary" size="sm" disabled={busy || !key} onClick={() => void refresh()}>{copy("proxy.desktop.models")}</Button>
    </div>
    {models.length ? <fieldset className="mt-4"><legend className="mb-2 text-xs font-medium">{copy("proxy.desktop.select_models")}</legend>
      <div className="max-h-60 overflow-y-auto">
        {models.map(id => <label key={id} className="flex min-h-10 items-center gap-2 text-xs"><input type="checkbox" className="h-4 w-4 shrink-0 accent-oai-brand-600" disabled={busy} checked={selected.includes(id)} onChange={event => { const checked = event.currentTarget.checked; setSelected(previous => checked ? [...previous, id] : previous.filter(item => item !== id)); }} /><span className="break-all font-mono">{id}</span></label>)}
      </div>
    </fieldset> : null}
    {client === "zed" && selected.length ? <label className="mt-3 flex flex-col gap-1 text-xs"><span>{copy("proxy.desktop.default_model")}</span><select className={`${inputClass} max-w-md`} value={selected.includes(model) ? model : selected[0]} disabled={busy} onChange={event => setModel(event.currentTarget.value)}>{selected.map(id => <option key={id} value={id}>{id}</option>)}</select></label> : null}
    <div className="mt-4 flex flex-wrap gap-2"><Button size="sm" disabled={busy || !key || !selected.length} onClick={() => void connect()}>{copy("proxy.desktop.connect")}</Button>
      {current?.canRestore ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void restore()}>{copy("proxy.desktop.restore")}</Button> : null}
    </div>
    {current?.path ? <p className="mt-2 break-all font-mono text-xs text-oai-gray-500 dark:text-oai-gray-400">{current.path}</p> : null}
    {notice ? <p role="status" className="mt-2 text-xs">{notice}</p> : null}
    {error ? <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
  </Card>;
}
