import React, { useEffect, useRef, useState } from "react";
import { getLocalApiAuthHeaders } from "../../../lib/local-api-auth";
import { copy } from "../../../lib/copy";
import { Button } from "../../components";

export function ProviderKeyInput({ provider }) {
  const saving = useRef(false);
  const [source, setSource] = useState(null);
  const [value, setValue] = useState("");
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/api/provider-api-key?provider=${encodeURIComponent(provider)}`;
  useEffect(() => {
    const controller = new AbortController();
    getLocalApiAuthHeaders().then(headers => fetch(endpoint, { headers, signal: controller.signal }))
      .then(response => response.json()).then(payload => { if (!controller.signal.aborted) { setConfigured(payload.configured === true); setSource(payload.source); } }).catch(() => {});
    return () => controller.abort();
  }, [endpoint]);
  const save = async () => {
    if (saving.current) return; saving.current = true; setBusy(true); setError("");
    try {
      const headers = await getLocalApiAuthHeaders();
      const response = await fetch(endpoint, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ apiKey: value }) });
      const payload = await response.json();
      if (!payload.ok) throw new Error(copy("limits.key.error"));
      setValue(""); setConfigured(true);
      window.dispatchEvent(new CustomEvent("limits:credentialChanged"));
    } catch { setError(copy("limits.key.error")); }
    finally { saving.current = false; setBusy(false); }
  };
  return <div className="mt-3 space-y-2" onClick={event => event.stopPropagation()}>
    <label className="block text-xs font-medium">{copy("limits.key.label")}
      <input type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        value={value} onChange={event => setValue(event.target.value)} disabled={busy}
        className="mt-1 block h-9 w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 font-mono text-sm dark:border-oai-gray-700" />
    </label>
    <Button size="sm" variant="secondary" disabled={busy || !value.trim()} onClick={() => void save()}>{copy("limits.key.save")}</Button>
    <p className="text-xs text-oai-gray-500" aria-live="polite">{error || copy(source === "env" ? "limits.key.env" : configured ? "limits.key.saved" : "limits.key.local")}</p>
  </div>;
}
