import React, { useRef, useState } from "react";
import { copy } from "../lib/copy";
import { Button } from "../ui/components";
import { supportsPluginQuota, loadPluginQuota } from "../lib/plugin-credential-quota";
export function CredentialPluginQuota({ file }) {
  const operation = useRef(false);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!supportsPluginQuota(file)) return null;
  const load = async () => { if (operation.current) return; operation.current = true; setBusy(true); setError(""); try { setRows(await loadPluginQuota(file)); } catch { setError(copy("proxy.creds.quota.error")); } finally { operation.current = false; setBusy(false); } };
  return <div className="mt-3 space-y-1 border-t border-oai-gray-200 pt-2 dark:border-oai-gray-800">
    <Button size="sm" variant="secondary" disabled={busy || file.disabled === true} onClick={() => void load()}>{copy("proxy.creds.quota.query")}</Button>
    {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
    {rows?.map((row, index) => <div key={index} className="flex flex-wrap justify-between gap-2 text-xs text-oai-gray-500"><span>{row.label}</span><span>{row.remainingPercent == null ? row.detail || copy("shared.placeholder.short") : copy("pswitch.agy.account.remaining", { value: Math.round(row.remainingPercent) })}{row.reset && Number.isFinite(Date.parse(row.reset)) ? ` · ${new Date(row.reset).toLocaleString()}` : ""}</span></div>)}
  </div>;
}
