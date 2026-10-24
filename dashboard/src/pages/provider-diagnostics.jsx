import React, { useCallback, useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { Button, Card } from "../ui/components";

const statusKeys = {
  applied: "pswitch.diagnostic.applied", unwired: "pswitch.diagnostic.unwired", unverified: "pswitch.diagnostic.unverified",
  replaced: "pswitch.diagnostic.replaced", presetChanged: "pswitch.diagnostic.preset_changed", invalid: "pswitch.diagnostic.invalid",
};
const probeKeys = {
  reachable: "pswitch.diagnostic.reachable", unreachable: "pswitch.diagnostic.unreachable", cancelled: "pswitch.diagnostic.cancelled",
  invalid: "pswitch.diagnostic.invalid_url", notConfigured: "pswitch.diagnostic.no_endpoint", stale: "pswitch.diagnostic.stale",
};

function diffRows(before, after) {
  // Show changed line blocks and bounded surrounding context. The source
  // strings come from the same projection used by repair, never a UI guess.
  const old = before.split("\n"), next = after.split("\n");
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let oldEnd = old.length, nextEnd = next.length;
  while (oldEnd > start && nextEnd > start && old[oldEnd - 1] === next[nextEnd - 1]) { oldEnd--; nextEnd--; }
  if (start === old.length && start === next.length) return [];
  return [...old.slice(Math.max(0, start - 2), start).map(text => ({ type: "context", text })),
    ...old.slice(start, oldEnd).map(text => ({ type: "removed", text })),
    ...next.slice(start, nextEnd).map(text => ({ type: "added", text })),
    ...next.slice(nextEnd, nextEnd + 2).map(text => ({ type: "context", text }))];
}

export function ProviderDiagnostics({ app, revision, onChanged }) {
  const [diagnostic, setDiagnostic] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState(null);
  const [preview, setPreview] = useState(null);
  const [showValues, setShowValues] = useState(false);
  const pending = useRef(false);
  const controller = useRef(null);
  const load = useCallback(async signal => {
    const result = await providerSwitchApi.diagnostic(app, signal);
    if (!signal?.aborted) setDiagnostic(result.diagnostic);
  }, [app]);
  useEffect(() => {
    setPreview(null); setShowValues(false); setProbe(null); setError("");
    const request = new AbortController();
    void load(request.signal).catch(() => {});
    return () => { request.abort(); controller.current?.abort(); };
  }, [load, revision]);
  const run = async action => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; setBusy(false); }
  };
  const checkEndpoint = () => run(async () => {
    const request = new AbortController(); controller.current = request;
    try { const result = await providerSwitchApi.probeDiagnostic(app, request.signal); if (!request.signal.aborted) setProbe(result.probe); }
    finally { controller.current = null; }
  });
  const previewRepair = () => run(async () => { setPreview(await providerSwitchApi.previewDiagnostic(app)); setShowValues(false); });
  const revealValues = checked => {
    if (!checked) {
      setShowValues(false);
      setPreview(current => current && { ...current, files: current.files.map(({ before, after, ...file }) => file) });
      return;
    }
    void run(async () => {
      const next = await providerSwitchApi.previewDiagnostic(app, true);
      setPreview(next); setShowValues(true);
    });
  };
  const repair = () => run(async () => {
    await providerSwitchApi.repairDiagnostic(app, preview.revision); setPreview(null); await load(); await onChanged?.();
  });
  if (!diagnostic) return null;
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{copy("pswitch.diagnostic.title")}</p>
          <p role="status" className="mt-1 text-xs text-oai-gray-600 dark:text-oai-gray-300">{copy(statusKeys[diagnostic.status] || "pswitch.diagnostic.unverified")}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setOpen(value => !value)} aria-expanded={open}>
          {copy(open ? "pswitch.diagnostic.collapse" : "pswitch.diagnostic.details")}
        </Button>
      </div>
      {open ? (
        <div className="mt-4 space-y-3 border-t border-oai-gray-100 pt-3 dark:border-oai-gray-800">
          {diagnostic.differences.length ? <ul className="space-y-1 text-xs">
            {diagnostic.differences.map(item => <li key={`${item.fileId}:${item.field}`} className="break-all font-mono">{item.fileId} · {item.field}</li>)}
          </ul> : null}
          <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.diagnostic.scope")}</p>
          {diagnostic.environment.length ? <div>
            <p className="text-xs font-medium">{copy("pswitch.diagnostic.environment")}</p>
            <ul className="mt-1 space-y-1 text-xs text-oai-gray-600 dark:text-oai-gray-300">
              {diagnostic.environment.map((item, index) => <li key={index} className="break-all"><code>{item.varName}</code> · {item.sourcePath}</li>)}
            </ul>
            <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.diagnostic.environment_hint")}</p>
          </div> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy || !diagnostic.providerId} onClick={() => void checkEndpoint()}><Activity />{copy("pswitch.diagnostic.probe")}</Button>
            <Button variant="secondary" size="sm" disabled={busy || !diagnostic.providerId} onClick={() => void previewRepair()}>{copy("pswitch.diagnostic.preview")}</Button>
          </div>
          {probe ? <p role="status" className="text-xs">{copy(probeKeys[probe.status] || "pswitch.diagnostic.unreachable")}{probe.httpStatus ? ` · HTTP ${probe.httpStatus}` : ""}</p> : null}
          {preview ? <div className="space-y-3">
            <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.diagnostic.preview_hint")}</p>
            <label className="flex min-h-10 items-center gap-2 text-xs"><input type="checkbox" className="h-4 w-4 accent-oai-brand-600" disabled={busy} checked={showValues} onChange={event => revealValues(event.currentTarget.checked)} />{copy("pswitch.diagnostic.show_values")}</label>
            {preview.files.map(file => <div key={file.id}>
              <p className="break-all font-mono text-xs">{file.path}</p>
              {showValues ? <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-oai-gray-50 p-3 text-xs dark:bg-oai-gray-950">
                {diffRows(file.before, file.after).map((row, index) => <div key={index} className={row.type === "removed" ? "text-red-700 dark:text-red-300" : row.type === "added" ? "text-oai-brand-700 dark:text-oai-brand-300" : "text-oai-gray-500"}>{`${row.type === "removed" ? "-" : row.type === "added" ? "+" : " "} ${row.text}`}</div>)}
              </pre> : <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy(file.changed === false ? "pswitch.diagnostic.no_changes" : "pswitch.diagnostic.values_hidden")}</p>}
            </div>)}
            <div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void repair()}>{copy("pswitch.diagnostic.repair")}</Button><Button variant="secondary" size="sm" disabled={busy} onClick={() => setPreview(null)}>{copy("pswitch.action.cancel")}</Button></div>
          </div> : null}
          {error ? <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        </div>
      ) : null}
    </Card>
  );
}
