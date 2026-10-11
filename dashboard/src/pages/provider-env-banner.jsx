import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Trash2, X } from "lucide-react";
import { Button, ConfirmModal } from "../ui/components";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";

// Env-conflict warning banner (cc-switch's EnvWarningBanner): lists shell
// profile / process environment variables that can override the configs the
// switcher writes, and removes the file-sourced ones with an automatic
// backup. Session-scoped dismiss, like the original.
export function ProviderEnvBanner({ conflicts, onDismiss, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoreBackupPath, setRestoreBackupPath] = useState(null);
  const [notice, setNotice] = useState(null);

  const flat = useMemo(
    () => Object.entries(conflicts || {}).flatMap(([app, list]) => (Array.isArray(list) ? list.map((entry) => ({ ...entry, app })) : [])),
    [conflicts],
  );
  const fileConflicts = flat.filter((entry) => entry.sourceType === "file");
  const systemConflicts = flat.filter((entry) => entry.sourceType !== "file");
  const fileSelected = fileConflicts.filter((entry) => selected.has(`${entry.sourcePath}|${entry.varName}`));

  const toggle = (key) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const removeSelected = async () => {
    if (fileSelected.length === 0) return;
    setBusy(true);
    try {
      const payload = fileSelected.map((entry) => ({
        varName: entry.varName,
        varValue: entry.varValue,
        sourceType: entry.sourceType,
        sourcePath: entry.sourcePath,
      }));
      const res = await providerSwitchApi.deleteEnvConflicts(payload);
      setRestoreBackupPath(res.backupPath);
      setNotice(copy("pswitch.env.deleted", { count: res.deleted }));
      setSelected(new Set());
      await onChanged();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const restore = async () => {
    if (!restoreBackupPath) return;
    setBusy(true);
    try {
      const res = await providerSwitchApi.restoreEnvConflicts(restoreBackupPath);
      setNotice(copy("pswitch.env.restored", { count: res.restored }));
      setRestoreBackupPath(null);
      await onChanged();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (flat.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-700/50 dark:bg-amber-950/30">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 text-left font-medium text-amber-800 dark:text-amber-200"
            onClick={() => setExpanded((value) => !value)}
          >
            <span>{copy("pswitch.env.title", { count: flat.length })}</span>
            {expanded ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
          </button>
          {notice ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{notice}</p> : null}
          {expanded ? (
            <div className="mt-2 space-y-3">
              <p className="text-xs text-amber-700 dark:text-amber-300">{copy("pswitch.env.hint")}</p>
              <ul className="space-y-1.5">
                {flat.map((entry) => {
                  const key = `${entry.sourcePath}|${entry.varName}`;
                  const removable = entry.sourceType === "file";
                  return (
                    <li key={key} className="flex items-center gap-2 text-xs text-oai-gray-700 dark:text-oai-gray-300">
                      {removable ? (
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-amber-600"
                          checked={selected.has(key)}
                          onChange={() => toggle(key)}
                          aria-label={copy("pswitch.env.select", { name: entry.varName })}
                        />
                      ) : (
                        <span className="w-3.5 shrink-0" />
                      )}
                      <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[11px] dark:bg-amber-900/40">
                        {entry.varName}={entry.varValue}
                      </code>
                      <span className="truncate text-oai-gray-400 dark:text-oai-gray-500">
                        {entry.app} · {entry.sourcePath}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={fileSelected.length === 0 || busy}
                  onClick={() => setConfirming(true)}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  {copy("pswitch.env.remove_selected", { count: fileSelected.length })}
                </Button>
                {restoreBackupPath ? (
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => void restore()}>
                    {copy("pswitch.env.restore")}
                  </Button>
                ) : null}
                {systemConflicts.length > 0 ? (
                  <span className="text-xs text-oai-gray-400 dark:text-oai-gray-500">
                    {copy("pswitch.env.system_hint", { count: systemConflicts.length })}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-amber-600 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-900/40"
          aria-label={copy("pswitch.env.dismiss")}
          onClick={onDismiss}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ConfirmModal
        open={confirming}
        title={copy("pswitch.env.confirm_title", { count: fileSelected.length })}
        description={copy("pswitch.env.confirm_message")}
        confirmLabel={copy("pswitch.env.remove_selected", { count: fileSelected.length })}
        destructive
        busy={busy}
        onConfirm={() => void removeSelected()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
