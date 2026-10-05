import React, { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Import, Pencil, Plus, Trash2 } from "lucide-react";
import { copy } from "../lib/copy";
import { promptsApi } from "../lib/provider-switch-api";
import { Button, Card, ConfirmModal } from "../ui/components";
import { ModalFrame } from "../ui/components/ModalFrame";
import { showToast } from "../ui/components/Toast";

// Prompt management (cc-switch's prompt panel): each agent owns a list of
// named instruction prompts; enabling one writes it over that app's global
// instruction file (CLAUDE.md, AGENTS.md, GEMINI.md, SOUL.md). Exactly one
// prompt is active per app, and enabling first captures the live file as a
// disabled backup entry so a hand-written file is never silently lost.

const PROMPT_APPS = [
  { id: "claude", labelKey: "pswitch.tab.claude" },
  { id: "codex", labelKey: "pswitch.tab.codex" },
  { id: "gemini", labelKey: "pswitch.tab.gemini" },
  { id: "grokbuild", labelKey: "pswitch.tab.grokbuild" },
  { id: "opencode", labelKey: "pswitch.tab.opencode" },
  { id: "openclaw", labelKey: "pswitch.tab.openclaw" },
  { id: "hermes", labelKey: "pswitch.tab.hermes" },
  { id: "pi", labelKey: "pswitch.tab.pi" },
  { id: "mcode", labelKey: "pswitch.tab.mcode" },
];

const inputClass = "h-9 w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700";
const chipOn = "bg-oai-brand-600 text-white border-oai-brand-600";
const chipOff = "bg-transparent text-oai-gray-500 border-oai-gray-200 hover:border-oai-gray-300 dark:border-oai-gray-700 dark:text-oai-gray-400";

function firstLine(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const line = trimmed.split("\n").find((part) => part.trim() !== "");
  return line ? line.trim() : "";
}

export function ProviderPromptsPanel() {
  const [app, setApp] = useState("claude");
  const [prompts, setPrompts] = useState(null);
  const [targetPath, setTargetPath] = useState("");
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  // The app chips stay clickable while a request is in flight, so responses
  // can outlive the selection they were started for — every state write is
  // guarded against the selection having moved on (stale-response races show
  // the wrong app's list and invite cross-app misfires from stale cards).
  const appRef = useRef(app);
  useEffect(() => { appRef.current = app; }, [app]);

  const load = useCallback(async (targetApp) => {
    try {
      const data = await promptsApi.list(targetApp);
      if (appRef.current !== targetApp) return;
      setPrompts(data.prompts);
      setTargetPath(data.targetPath);
      setLoadError(null);
    } catch (error) {
      if (appRef.current !== targetApp) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => { void load(app); }, [app, load]);

  const run = useCallback(async (action, { successTitle, app: runApp } = {}) => {
    if (busy) return null;
    setBusy(true);
    try {
      const result = await action();
      if (appRef.current === runApp) {
        if (result && Array.isArray(result.prompts)) setPrompts(result.prompts);
        if (result && result.targetPath) setTargetPath(result.targetPath);
      }
      if (successTitle) showToast({ title: successTitle });
      return result;
    } catch (error) {
      showToast({ title: `${copy("pswitch.prompts.toast_error")} — ${error instanceof Error ? error.message : String(error)}` });
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const handleDelete = () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    void run(async () => {
      const result = await promptsApi.remove(app, target.id);
      setDeleteTarget(null);
      return result;
    }, { successTitle: copy("pswitch.prompts.toast_deleted"), app });
  };

  const handleImport = () => {
    void run(() => promptsApi.import(app), { successTitle: copy("pswitch.prompts.import_done"), app });
  };

  const switchApp = (nextApp) => {
    if (nextApp === app) return;
    // Drop the previous app's rows immediately so they can neither be read as
    // the new app's prompts nor clicked while the new list is in flight.
    setApp(nextApp);
    setPrompts(null);
    setTargetPath("");
    setLoadError(null);
  };

  const enabledCount = prompts ? prompts.filter((prompt) => prompt.enabled).length : 0;
  const showNoneEnabledHint = prompts !== null && prompts.length > 0 && enabledCount === 0;
  const openAdd = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (prompt) => { setEditing(prompt); setDialogOpen(true); };
  const closeDialog = () => { setDialogOpen(false); setEditing(null); };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{copy("pswitch.prompts.title", { count: (prompts || []).length })}</p>
            <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.prompts.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={handleImport}>
              <Import /> {copy("pswitch.prompts.import")}
            </Button>
            <Button size="sm" disabled={busy} onClick={openAdd}>
              <Plus /> {copy("pswitch.prompts.add")}
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-oai-gray-100 pt-3 dark:border-oai-gray-800">
          {PROMPT_APPS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={app === item.id}
              disabled={busy}
              onClick={() => switchApp(item.id)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${app === item.id ? chipOn : chipOff}`}
            >
              {copy(item.labelKey)}
            </button>
          ))}
        </div>
        {targetPath ? (
          <p className="mt-2 break-all font-mono text-xs text-oai-gray-400 dark:text-oai-gray-500" title={targetPath}>
            {copy("pswitch.prompts.target", { path: targetPath })}
          </p>
        ) : null}
        {loadError ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{loadError}</p> : null}
      </Card>

      {prompts !== null && prompts.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <FileText className="h-8 w-8 text-oai-gray-300 dark:text-oai-gray-600" />
            <p className="text-sm font-medium">{copy("pswitch.prompts.empty_title")}</p>
            <p className="max-w-md text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.prompts.empty_hint")}</p>
          </div>
        </Card>
      ) : null}

      <div className="flex min-w-0 flex-col gap-2">
        {(prompts || []).map((prompt) => (
          <PromptCard
            key={prompt.id}
            prompt={prompt}
            busy={busy}
            onEnable={() => void run(() => promptsApi.enable(app, prompt.id), { successTitle: copy("pswitch.prompts.toast_enabled"), app })}
            onEdit={() => openEdit(prompt)}
            onDelete={() => setDeleteTarget(prompt)}
          />
        ))}
      </div>

      {showNoneEnabledHint ? (
        <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("pswitch.prompts.none_enabled_hint")}</p>
      ) : null}

      <PromptDialog
        open={dialogOpen}
        app={app}
        editing={editing}
        busy={busy}
        onClose={closeDialog}
        onSaved={(result) => {
          setPrompts(result.prompts);
          setTargetPath(result.targetPath);
          setDialogOpen(false);
          setEditing(null);
          showToast({ title: copy("pswitch.prompts.toast_saved") });
        }}
      />

      <ConfirmModal
        open={deleteTarget !== null}
        title={copy("pswitch.prompts.delete_title")}
        description={copy("pswitch.prompts.delete_hint", { name: deleteTarget ? deleteTarget.name : "" })}
        confirmLabel={copy("pswitch.action.delete")}
        cancelLabel={copy("pswitch.action.cancel")}
        destructive
        busy={busy}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function PromptCard({ prompt, busy, onEnable, onEdit, onDelete }) {
  const preview = firstLine(prompt.content);
  const previewText = preview || copy("pswitch.prompts.preview_empty");
  return (
    <Card>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <strong className="min-w-0 truncate text-sm font-medium text-oai-black dark:text-white" title={prompt.name}>
              {prompt.name}
            </strong>
            {prompt.enabled ? (
              <span className="shrink-0 rounded-full bg-oai-brand-50 px-2 py-0.5 text-xs font-medium text-oai-brand-700 dark:bg-oai-brand-950 dark:text-oai-brand-300">
                {copy("pswitch.prompts.enabled_badge")}
              </span>
            ) : null}
          </div>
          {prompt.description ? (
            <p className="mt-1 line-clamp-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">{prompt.description}</p>
          ) : null}
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-xs text-oai-gray-500 dark:text-oai-gray-400" title={previewText}>
            {previewText}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!prompt.enabled ? (
            <Button variant="secondary" size="sm" disabled={busy} onClick={onEnable}>
              {copy("pswitch.prompts.enable")}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" disabled={busy} onClick={onEdit} aria-label={copy("pswitch.prompts.edit")}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || prompt.enabled}
            onClick={onDelete}
            aria-label={copy("pswitch.prompts.delete_title")}
            title={prompt.enabled ? copy("pswitch.prompts.delete_disabled_hint") : undefined}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PromptDialog({ open, app, editing, busy, onClose, onSaved }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing ? editing.name : "");
    setDescription(editing ? editing.description || "" : "");
    setContent(editing ? editing.content : "");
    setEnabled(editing ? editing.enabled : false);
  }, [open, editing]);

  const canSave = open && !busy && !saving && name.trim() !== "";

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const result = await promptsApi.upsert(app, {
        id: editing ? editing.id : `prompt-${Date.now()}`,
        name: name.trim(),
        description: description.trim(),
        content,
        enabled,
      });
      onSaved(result);
    } catch (error) {
      showToast({ title: `${copy("pswitch.prompts.toast_error")} — ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalFrame open={open} onClose={onClose} busy={busy || saving} label={copy("pswitch.prompts.dialog_title")}>
      <div className="flex min-w-0 flex-col gap-3">
        <h2 className="text-sm font-semibold">{editing ? copy("pswitch.prompts.edit") : copy("pswitch.prompts.add")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.prompts.field_name")}</span>
            <input value={name} onChange={(event) => setName(event.currentTarget.value)} className={inputClass} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.prompts.field_description")}</span>
            <input value={description} onChange={(event) => setDescription(event.currentTarget.value)} className={inputClass} />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.prompts.field_content")}</span>
          <textarea
            aria-label={copy("pswitch.prompts.field_content")}
            rows={12}
            spellCheck={false}
            value={content}
            onChange={(event) => setContent(event.currentTarget.value)}
            className="w-full resize-y rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-oai-gray-50 dark:bg-oai-gray-950 p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} className="h-4 w-4" />
          <span>{copy("pswitch.prompts.field_enabled")}</span>
        </label>
        <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("pswitch.prompts.enabled_hint")}</p>
        <div className="flex items-center justify-end gap-2 border-t border-oai-gray-100 pt-3 dark:border-oai-gray-800">
          <Button variant="secondary" size="sm" disabled={busy || saving} onClick={onClose}>{copy("pswitch.action.cancel")}</Button>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>{copy("pswitch.action.save")}</Button>
        </div>
      </div>
    </ModalFrame>
  );
}
