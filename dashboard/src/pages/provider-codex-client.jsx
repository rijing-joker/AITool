import React, { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { Button, Card, ConfirmModal } from "../ui/components";
import { useVisiblePolling } from "../hooks/use-visible-polling";

export function ProviderCodexClient({ revision }) {
  const [client, setClient] = useState(null);
  const [dismissed, setDismissed] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const actionPending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const refresh = useCallback(async (signal) => {
    try {
      const result = await providerSwitchApi.getCodexClient(signal);
      if (!signal?.aborted) setClient(result.client);
    } catch { /* retry on focus */ }
  }, []);
  const refreshVisible = useVisiblePolling(refresh, 15000);
  useEffect(() => { void refreshVisible(); }, [refreshVisible, revision]);
  const restart = async () => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    try {
      const result = await providerSwitchApi.restartCodexDaemon();
      setConfirm(false);
      setNotice(copy(result.outcome === "notRunning" ? "pswitch.codex_client.not_running" : "pswitch.codex_client.restarted"));
      await refresh();
    } catch (error) { setNotice(error.message); }
    finally { actionPending.current = false; setBusy(false); }
  };
  const dismiss = async () => {
    try { await providerSwitchApi.acknowledgeCodexClients(); setDismissed(client.revision); } catch (error) { setNotice(error.message); }
  };
  const show = client && (client.daemon || client.others) && client.revision !== dismissed;
  if (!show && !notice) return null;
  return <>
    <Card className="mb-4" role="status">
      {show ? <>
        <p className="text-sm">{copy(client.auth ? "pswitch.codex_client.auth" : "pswitch.codex_client.catalog")}</p>
        {client.others ? <p className="mt-1 text-xs text-oai-gray-500">{copy(client.unverified ? "pswitch.codex_client.unverified" : "pswitch.codex_client.others")}</p> : null}
        <div className="mt-3 flex gap-2">
          {client.daemonRunning ? <Button size="sm" disabled={busy} onClick={() => setConfirm(true)}>{copy("pswitch.codex_client.restart")}</Button> : null}
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void dismiss()}>{copy("pswitch.codex_client.dismiss")}</Button>
        </div>
      </> : null}
      {notice ? <p className="mt-2 text-xs text-oai-gray-500">{notice}</p> : null}
    </Card>
    <ConfirmModal open={confirm} busy={busy} title={copy("pswitch.codex_client.confirm_title")}
      description={copy("pswitch.codex_client.confirm_desc")} confirmLabel={copy("pswitch.codex_client.restart")}
      cancelLabel={copy("pswitch.action.cancel")} onConfirm={() => void restart()} onCancel={() => setConfirm(false)} />
  </>;
}
