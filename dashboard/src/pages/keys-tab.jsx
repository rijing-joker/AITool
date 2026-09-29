import React, { useCallback, useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  Check,
  Copy as CopyIcon,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { copy } from "../lib/copy";
import { proxyApi } from "../lib/proxy-api";
import { Button, Card, ConfirmModal } from "../ui/components";

// ---------------------------------------------------------------------------
// Keys tab (客户端密钥) — EasyCLIProxyAPI's ConfigPanel key list, ported
// interaction-for-interaction: masked keys, add/edit dialog with generated
// sk- keys and remarks, charset/duplicate/remark-length validation, delete
// confirmation, and per-key copy. Remarks live AiTool-side (the kernel only
// stores the raw keys), mirroring how EasyCLIProxyAPI keeps GuiApiKeyEntry
// remarks in its own config.
// ---------------------------------------------------------------------------

function maskApiKey(apiKey) {
  const value = apiKey.trim();
  if (!value) return "";
  const visible = value.length < 4 ? 1 : 2;
  return `${value.slice(0, visible)}${"*".repeat(Math.max(6, 10 - visible * 2))}${value.slice(-visible)}`;
}

const inputClass = "h-9 w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 font-mono text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700";

function KeyDialog({ open, editing, keys, onClose, onSubmit, busy }) {
  const [apiKey, setApiKey] = useState("");
  const [remark, setRemark] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (!open) return;
    setApiKey(editing?.apiKey ?? "");
    setRemark(editing?.remark ?? "");
    setShowApiKey(false);
    setFormError("");
  }, [open, editing]);

  const generateApiKey = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    setApiKey(`sk-${value}`);
    setShowApiKey(true);
    setFormError("");
  };

  const submit = (event) => {
    event.preventDefault();
    const normalized = apiKey.trim();
    if (!normalized) {
      setFormError(copy("proxy.keys.error.emptyKey"));
      return;
    }
    if (!/^[\x21-\x7e]+$/.test(normalized)) {
      setFormError(copy("proxy.keys.error.invalidKey"));
      return;
    }
    if (keys.some((entry) => entry.apiKey === normalized && entry.apiKey !== editing?.apiKey)) {
      setFormError(copy("proxy.keys.error.duplicateKey"));
      return;
    }
    const normalizedRemark = remark.trim();
    if (normalizedRemark.length > 80) {
      setFormError(copy("proxy.keys.error.remarkTooLong"));
      return;
    }
    setFormError("");
    onSubmit({ apiKey: normalized, remark: normalizedRemark });
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center p-4">
          <Dialog.Popup className="w-full max-w-md rounded-2xl bg-white p-5 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.25)] ring-1 ring-oai-gray-200 transition-[opacity,transform] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] data-[ending-style]:translate-y-2 data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0 dark:bg-oai-gray-950 dark:ring-oai-gray-800">
            <div className="flex items-start justify-between gap-3">
              <Dialog.Title className="text-base font-semibold text-oai-black dark:text-white">
                {copy(editing ? "proxy.keys.editTitle" : "proxy.keys.addTitle")}
              </Dialog.Title>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-md p-1 text-oai-gray-400 hover:bg-oai-gray-100 hover:text-oai-black disabled:opacity-50 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                aria-label={copy("proxy.upstream.common.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={submit} className="mt-4 space-y-3.5">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.keys.keyLabel")}</span>
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={apiKey}
                    onChange={(event) => { setApiKey(event.currentTarget.value); setFormError(""); }}
                    type={showApiKey ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="sk-…"
                    className={inputClass}
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((current) => !current)}
                    aria-label={copy(showApiKey ? "proxy.keys.hide" : "proxy.keys.show")}
                    title={copy(showApiKey ? "proxy.keys.hide" : "proxy.keys.show")}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-oai-gray-200 text-oai-gray-500 hover:bg-oai-gray-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800"
                  >
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                  <Button type="button" variant="secondary" onClick={generateApiKey} title={copy("proxy.keys.generate")} aria-label={copy("proxy.keys.generate")}>
                    <Sparkles className="h-4 w-4" />
                  </Button>
                </div>
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("proxy.keys.remarkLabel")} <code className="rounded bg-oai-gray-100 px-1 font-mono text-[10px] dark:bg-oai-gray-800">remark</code>
                </span>
                <input
                  value={remark}
                  onChange={(event) => { setRemark(event.currentTarget.value); setFormError(""); }}
                  autoComplete="off"
                  className="h-9 w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700"
                />
                <span className="block text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.keys.remarkHint")}</span>
              </label>
              {formError ? <p className="text-sm text-red-600 dark:text-red-400" role="alert">{formError}</p> : null}
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
                  {copy("proxy.upstream.common.cancel")}
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {copy("proxy.upstream.common.save")}
                </Button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function KeysTab({ status }) {
  const [keys, setKeys] = useState(null);
  const [remarks, setRemarks] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteEntry, setDeleteEntry] = useState(null);
  const [copiedIndex, setCopiedIndex] = useState(null);

  const load = useCallback(async () => {
    try {
      const [keysData, remarksData] = await Promise.all([
        proxyApi.keys(),
        fetch("/api/proxy/api-key-remarks").then((response) => response.json()),
      ]);
      const list = Array.isArray(keysData.keys) ? keysData.keys : keysData.keys?.items || [];
      setKeys(list.map(String));
      if (remarksData?.ok && remarksData.remarks && typeof remarksData.remarks === "object") {
        setRemarks(remarksData.remarks);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setKeys([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = useCallback(async (nextKeys, nextRemarks) => {
    setBusy(true);
    setError(null);
    try {
      await proxyApi.putKeys(nextKeys);
      const response = await fetch("/api/proxy/api-key-remarks", {
        method: "PUT",
        headers: await (async () => {
          const { getLocalApiAuthHeaders } = await import("../lib/local-api-auth");
          return getLocalApiAuthHeaders();
        })(),
        body: JSON.stringify({ remarks: nextRemarks }),
      });
      const payload = await response.json().catch(() => null);
      if (!payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      setKeys(nextKeys);
      setRemarks(nextRemarks);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  }, [load]);

  const submitDialog = async ({ apiKey, remark }) => {
    const current = keys ?? [];
    const nextRemarks = { ...remarks };
    if (editing) {
      if (editing.apiKey !== apiKey) {
        delete nextRemarks[editing.apiKey];
        if (remark || editing.remark) nextRemarks[apiKey] = remark;
      } else if (remark !== editing.remark) {
        if (remark) nextRemarks[apiKey] = remark;
        else delete nextRemarks[apiKey];
      }
    } else if (remark) {
      nextRemarks[apiKey] = remark;
    }
    const nextKeys = editing
      ? current.map((entry) => (entry === editing.apiKey ? apiKey : entry))
      : [...current, apiKey];
    const saved = await persist(nextKeys, nextRemarks);
    if (saved) {
      setDialogOpen(false);
      setEditing(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteEntry) return;
    const nextRemarks = { ...remarks };
    delete nextRemarks[deleteEntry];
    const saved = await persist((keys ?? []).filter((entry) => entry !== deleteEntry), nextRemarks);
    if (saved) setDeleteEntry(null);
  };

  const port = status?.core.port ?? 8318;
  const host = status?.core.host ?? "127.0.0.1";
  const endpoints = [
    { label: "OpenAI", path: "/v1/chat/completions" },
    { label: "Anthropic", path: "/v1/messages" },
    { label: "Gemini", path: "/v1beta/models" },
  ];

  const copyKey = async (entry, index) => {
    try {
      await navigator.clipboard.writeText(entry);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex((current) => (current === index ? null : current)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <Card>
        <p className="text-xs font-semibold tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
          {copy("proxy.keys.endpoints")}
        </p>
        <ul className="mt-3 space-y-2">
          {endpoints.map((endpoint) => {
            const url = `http://${host}:${port}${endpoint.path}`;
            return (
              <li key={endpoint.label} className="flex items-center justify-between gap-3 text-sm">
                <span className="w-20 shrink-0 text-oai-gray-500 dark:text-oai-gray-400">{endpoint.label}</span>
                <code className="min-w-0 flex-1 truncate rounded bg-oai-gray-100 dark:bg-oai-gray-800 px-2 py-1 font-mono text-xs">
                  {url}
                </code>
                <CopyButtonInline text={url} />
              </li>
            );
          })}
        </ul>
      </Card>

      <Card className="!p-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-oai-gray-100 dark:border-oai-gray-800">
          <p className="text-sm font-semibold">{copy("proxy.keys.title")}</p>
          <div className="flex items-center gap-3">
            <span className="text-xs text-oai-gray-400">{copy("proxy.keys.count", { count: keys?.length ?? 0 })}</span>
            <Button
              size="sm"
              onClick={() => { setEditing(null); setDialogOpen(true); }}
              disabled={keys === null || busy}
            >
              <Plus className="h-4 w-4" />
              {copy("proxy.keys.add")}
            </Button>
          </div>
        </div>
        <ul className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
          {keys === null ? (
            <li className="px-5 py-6 text-center text-sm text-oai-gray-400">{copy("proxy.loading")}</li>
          ) : keys.length === 0 ? (
            <li className="px-5 py-8 text-center text-sm text-oai-gray-400">{copy("proxy.keys.empty")}</li>
          ) : (
            keys.map((entry, index) => (
              <li key={`${entry}-${index}`} className="flex items-center gap-2 px-4 sm:px-5 py-3 text-sm">
                <KeyRound className="h-3.5 w-3.5 shrink-0 text-oai-gray-400" />
                <div className="min-w-0 flex-1">
                  <code className="block truncate font-mono text-xs">{maskApiKey(entry)}</code>
                  {remarks[entry] ? (
                    <span className="block truncate text-xs text-oai-gray-400 dark:text-oai-gray-500" title={remarks[entry]}>
                      {remarks[entry]}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => void copyKey(entry, index)}
                  aria-label={copy("proxy.action.copy")}
                  title={copy("proxy.action.copy")}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-oai-gray-400 hover:bg-oai-gray-100 hover:text-oai-black dark:hover:bg-oai-gray-800 dark:hover:text-white"
                >
                  {copiedIndex === index ? <Check className="h-3.5 w-3.5 text-oai-brand-600" /> : <CopyIcon className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing({ apiKey: entry, remark: remarks[entry] ?? "" }); setDialogOpen(true); }}
                  disabled={busy}
                  aria-label={copy("proxy.upstream.common.edit")}
                  title={copy("proxy.upstream.common.edit")}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-oai-gray-400 hover:bg-oai-gray-100 hover:text-oai-black disabled:opacity-50 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteEntry(entry)}
                  disabled={busy}
                  aria-label={copy("proxy.action.delete_key")}
                  title={copy("proxy.action.delete_key")}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-oai-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))
          )}
        </ul>
      </Card>

      <KeyDialog
        open={dialogOpen}
        editing={editing}
        keys={(keys ?? []).map((entry) => ({ apiKey: entry }))}
        onClose={() => { setDialogOpen(false); setEditing(null); }}
        onSubmit={(values) => void submitDialog(values)}
        busy={busy}
      />
      <ConfirmModal
        open={deleteEntry !== null}
        title={copy("proxy.action.delete_key")}
        description={copy("proxy.keys.deleteConfirm", { key: deleteEntry ? maskApiKey(deleteEntry) : "" })}
        confirmLabel={copy("proxy.action.delete_key")}
        destructive
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteEntry(null)}
      />
    </div>
  );
}

function CopyButtonInline({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copy("proxy.action.copy")}
      title={copy("proxy.action.copy")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {}
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-oai-brand-600" /> : <CopyIcon className="h-3.5 w-3.5" />}
    </button>
  );
}
