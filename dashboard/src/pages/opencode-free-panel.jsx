import React, { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";
import { opencodeFreeApi } from "../lib/proxy-api";
import { Button, Card } from "../ui/components";

const POLICY_KEYS = {
  training: "proxy.free.policy.training", improvement: "proxy.free.policy.improvement",
  no_training: "proxy.free.policy.no_training", review: "proxy.free.policy.review", retired: "proxy.free.policy.retired",
};

export function OpenCodeFreePanel({ onChanged }) {
  const [status, setStatus] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    try {
      const next = await opencodeFreeApi.status();
      setStatus(next); setCatalog(next.catalog); setSelected(next.selectedModels);
    } catch (e) { setError(String(e.message || e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let active = true;
    const timer = setInterval(async () => {
      if (inFlight.current) return;
      try {
        const next = await opencodeFreeApi.status();
        if (active && !inFlight.current) {
          setStatus(next);
          if (next.catalog.updatedAt) setCatalog(next.catalog);
        }
      } catch { /* Explicit refresh reports connection failures. */ }
    }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const run = async (action) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (e) { setError(String(e.message || e)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const save = (enabled) => run(async () => {
    const next = await opencodeFreeApi.configure(enabled, selected);
    setStatus(next); setCatalog(next.catalog); setSelected(next.selectedModels);
    await onChanged?.();
  });
  const refresh = () => run(async () => {
    setStatus(await opencodeFreeApi.status());
    setCatalog((await opencodeFreeApi.refresh()).catalog);
  });
  const models = catalog?.models || [];
  const retired = selected.filter((id) => { return !models.some((model) => model.id === id); });
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{copy("proxy.free.title")}</h3>
        <span className="text-xs text-oai-gray-500">{copy(status?.enabled ? status.running ? "proxy.free.running" : "proxy.free.stopped" : "proxy.free.disabled")}</span>
      </div>
      <p className="mt-2 text-sm text-oai-gray-500">{copy("proxy.free.description")}</p>
      <p className="mt-2 text-xs text-oai-gray-500">{copy("proxy.free.compatibility")}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={refresh}>{copy("proxy.free.refresh")}</Button>
        <Button size="sm" disabled={busy || !status || !selected.length || Boolean(catalog?.lastError) || retired.length > 0} onClick={() => save(true)}>{copy(status?.enabled ? "proxy.free.save" : "proxy.free.enable")}</Button>
        {status?.enabled && <Button variant="secondary" size="sm" disabled={busy} onClick={() => save(false)}>{copy("proxy.free.disable")}</Button>}
        {catalog?.updatedAt && <span className="text-xs text-oai-gray-500">{copy("proxy.free.updated", { time: new Date(catalog.updatedAt).toLocaleString() })}</span>}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {[...models, ...retired.map((id) => ({ id, policy: "retired" }))].map((model) => (
          <div key={model.id} className="text-sm">
            <label className="flex min-h-10 cursor-pointer items-center gap-2">
              <input type="checkbox" disabled={busy} checked={selected.includes(model.id)} onChange={(e) => setSelected((prev) => e.target.checked ? [...prev, model.id] : prev.filter((id) => id !== model.id))} />
              <span className="break-all font-mono text-xs">{model.id}</span>
            </label>
            <p className="pl-5 text-xs text-oai-gray-500">{copy(POLICY_KEYS[model.policy] || POLICY_KEYS.review)}</p>
          </div>
        ))}
      </div>
      {!models.length && <p className="mt-3 text-xs text-oai-gray-500">{copy("proxy.free.empty")}</p>}
      <a href="https://opencode.ai/docs/zen/" target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs text-oai-brand">{copy("proxy.free.policy_link")}</a>
      <p className="mt-2 text-xs text-oai-gray-500">{!status?.lastInference ? copy("proxy.free.inference_pending") : status.lastInference.ok
        ? copy("proxy.free.inference_ok", { time: new Date(status.lastInference.at).toLocaleString() })
        : copy("proxy.free.inference_error", { code: status.lastInference.code })}</p>
      {(error || catalog?.lastError) && <p role="alert" className="mt-2 text-sm text-red-500">{error || copy("proxy.free.catalog_error")}</p>}
    </Card>
  );
}
