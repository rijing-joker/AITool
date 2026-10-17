import React, { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";
import { proxyApi } from "../lib/proxy-api";
import { Button, Card, ConfirmModal } from "../ui/components";

const selectClass = "h-9 rounded-lg border border-oai-gray-200 bg-transparent px-2 text-sm dark:border-oai-gray-700";
export function CopilotClients({ keys, remarks }) {
  const [clients, setClients] = useState([]);
  const [client, setClient] = useState("cli");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const operation = useRef(false);
  const load = useCallback(async () => {
    try { setClients((await proxyApi.copilotStatus()).clients); } catch { /* retry after action */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!keys?.includes(key)) setKey(keys?.[0] || ""); }, [keys, key]);
  useEffect(() => {
    let active = true;
    setModels([]);
    if (key) void proxyApi.copilotModels(key).then((result) => {
      if (active) setModels(result.models);
    }).catch(() => {});
    return () => { active = false; };
  }, [key]);
  const selected = clients.find((value) => value.client === client);
  const act = async (restore = false) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      if (restore) await proxyApi.restoreCopilot(client);
      else await proxyApi.connectCopilot(client, key, model);
      setRestoring(false);
      setNotice(copy(restore ? "proxy.copilot.restored" : client === "cli" ? "proxy.copilot.cli_ready" : "proxy.copilot.vscode_ready"));
      await load();
    } catch (failure) {
      const known = ["DISABLED", "DIRTY", "UNSUPPORTED", "PROFILE", "FAILED", "TIMEOUT", "LAUNCH_FAILED"];
      const code = failure.message?.replace("COPILOT_SETUP_", "");
      setError(copy(known.includes(code) ? `proxy.copilot.error.${code.toLowerCase()}` : failure.message === "COPILOT_CONFIG_CONFLICT" ? "proxy.copilot.error.conflict" : "proxy.copilot.error.failed"));
    } finally { operation.current = false; setBusy(false); }
  };
  return <Card>
    <p className="text-sm font-semibold">{copy("proxy.copilot.title")}</p>
    <p className="mt-1 text-xs text-oai-gray-500">{copy(client === "cli" ? "proxy.copilot.cli_hint" : "proxy.copilot.vscode_hint")}</p>
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs"><span>{copy("proxy.copilot.client")}</span>
        <select className={selectClass} value={client} disabled={busy} onChange={(event) => { setClient(event.target.value); setNotice(null); setError(null); }}>
          <option value="cli">{copy("proxy.copilot.cli")}</option><option value="vscode">{copy("proxy.copilot.vscode")}</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs"><span>{copy("proxy.keys.keyLabel")}</span>
        <select className={selectClass} value={key} disabled={busy || !keys?.length} onChange={(event) => setKey(event.target.value)}>
          {!keys?.length ? <option value="">{copy("proxy.keys.empty")}</option> : null}
          {(keys || []).map((value, index) => <option key={value} value={value}>{remarks[value] || copy("proxy.copilot.key_number", { number: index + 1 })}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs"><span>{copy("proxy.copilot.model")}</span>
        <input className={selectClass} list="aitool-copilot-models" value={model} disabled={busy} onChange={(event) => setModel(event.target.value)} />
        <datalist id="aitool-copilot-models">{models.map((value) => <option key={value} value={value} />)}</datalist>
      </label>
      <Button size="sm" disabled={busy || !key || !model.trim()} onClick={() => void act()}>{copy("proxy.copilot.connect")}</Button>
      {selected?.canRestore ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRestoring(true)}>{copy("proxy.copilot.restore")}</Button> : null}
    </div>
    {selected?.configured && client === "vscode" && selected.modelCount ? <p className="mt-2 text-xs text-oai-gray-500">{copy("proxy.copilot.catalog_count", { count: selected.modelCount })}</p> : null}
    {selected?.configured ? <p className="mt-2 text-xs text-oai-gray-500">{copy("proxy.copilot.current", { model: selected.model })}</p> : null}
    {busy && client === "vscode" ? <p className="mt-2 text-xs" role="status">{copy("proxy.copilot.preparing")}</p> : null}
    {notice ? <p className="mt-2 text-xs" role="status">{notice}</p> : null}
    {error ? <p className="mt-2 text-xs text-red-600" role="alert">{error}</p> : null}
    <ConfirmModal open={restoring} busy={busy} title={copy("proxy.copilot.restore")}
      description={copy("proxy.copilot.restore_hint")} confirmLabel={copy("proxy.copilot.restore")}
      cancelLabel={copy("proxy.upstream.common.cancel")} onConfirm={() => void act(true)} onCancel={() => setRestoring(false)} />
  </Card>;
}
