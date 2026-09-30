import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  FileCode,
  Gem,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { Button, Card, ConfirmModal } from "../ui/components";

// Provider config management — a port of cc-switch's config-file module.
// Presets live in ~/.aitool/provider-switch (served by the local CLI);
// switching projects a provider's key fields into the live tool configs
// (~/.claude/settings.json, ~/.codex/config.toml + auth.json,
// ~/.gemini/.env) with pre-write backups, leaving user-owned fields alone.

const APPS = [
  { id: "claude", labelKey: "pswitch.tab.claude", icon: Sparkles },
  { id: "codex", labelKey: "pswitch.tab.codex", icon: Terminal },
  { id: "gemini", labelKey: "pswitch.tab.gemini", icon: Gem },
];

function SectionTitle({ children, action = null }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-oai-gray-500 dark:text-oai-gray-400">{children}</h2>
      {action}
    </div>
  );
}

function CredsModal({ open, onClose, busy, title, subtitle, children, width = "max-w-2xl" }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]">
      <div
        className={`flex max-h-[88vh] w-full ${width} flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:ring-oai-gray-800`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-3 border-b border-oai-gray-100 px-5 py-4 dark:border-oai-gray-800">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-oai-black dark:text-white">{title}</h2>
            {subtitle ? (
              <p className="mt-0.5 truncate text-sm text-oai-gray-500 dark:text-oai-gray-400">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="shrink-0 rounded-md p-1.5 text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-black disabled:opacity-50 dark:hover:bg-oai-gray-800 dark:hover:text-white"
            aria-label={copy("pswitch.action.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EditorField({ label, hint, error, children }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">{hint}</p> : null}
      {error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ProviderSwitchPage() {
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [activeApp, setActiveApp] = useState("claude");
  const [notice, setNotice] = useState(null);

  // provider editor dialog state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState(null);
  const [editorName, setEditorName] = useState("");
  const [editorCategory, setEditorCategory] = useState("custom");
  const [editorConfig, setEditorConfig] = useState("");
  const [editorError, setEditorError] = useState(null);
  const [presets, setPresets] = useState([]);

  // confirm dialogs
  const [switchTarget, setSwitchTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  // live file editor state
  const [liveFileId, setLiveFileId] = useState("settings");
  const [liveContent, setLiveContent] = useState("");
  const [liveBaseHash, setLiveBaseHash] = useState("");
  const [liveExists, setLiveExists] = useState(true);
  const [liveError, setLiveError] = useState(null);
  const [conflict, setConflict] = useState(null);

  // backups
  const [backups, setBackups] = useState([]);
  const [restoreTarget, setRestoreTarget] = useState(null);

  const appState = useMemo(() => {
    return status?.apps.find((app) => app.app === activeApp) || null;
  }, [status, activeApp]);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await providerSwitchApi.getStatus();
      setStatus(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const refreshBackups = useCallback(async (app) => {
    try {
      const res = await providerSwitchApi.listBackups(app);
      setBackups(res.backups || []);
    } catch {
      setBackups([]);
    }
  }, []);

  const loadLive = useCallback(async (app, fileId) => {
    setLiveError(null);
    try {
      const res = await providerSwitchApi.getLive(app, fileId);
      setLiveContent(res.content ?? "");
      setLiveBaseHash(res.baseHash);
      setLiveExists(!!res.file.exists);
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const fileIds = appState?.files.map((file) => file.id) || [];
    if (!fileIds.includes(liveFileId) && fileIds.length) {
      setLiveFileId(fileIds[0]);
    }
  }, [appState, liveFileId]);

  useEffect(() => {
    void loadLive(activeApp, liveFileId);
    void refreshBackups(activeApp);
  }, [activeApp, liveFileId, loadLive, refreshBackups]);

  const openAddDialog = useCallback(async () => {
    setEditingProvider(null);
    setEditorName("");
    setEditorCategory("custom");
    setEditorConfig("{\n  \n}\n");
    setEditorError(null);
    setEditorOpen(true);
    try {
      const res = await providerSwitchApi.getPresets(activeApp);
      setPresets(res.presets || []);
    } catch {
      setPresets([]);
    }
  }, [activeApp]);

  const openEditDialog = useCallback((provider) => {
    setEditingProvider(provider);
    setEditorName(provider.name);
    setEditorCategory(provider.category);
    setEditorConfig(JSON.stringify(provider.settingsConfig ?? {}, null, 2));
    setEditorError(null);
    setPresets([]);
    setEditorOpen(true);
  }, []);

  const applyPreset = useCallback((presetId) => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    setEditorName((current) => current || preset.name);
    setEditorCategory(preset.category);
    setEditorConfig(JSON.stringify(preset.settingsConfig ?? {}, null, 2));
  }, [presets]);

  const saveEditor = useCallback(async () => {
    let parsed;
    try {
      parsed = JSON.parse(editorConfig);
    } catch (error) {
      setEditorError(copy("pswitch.provider.invalid_json", { error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    setBusy(true);
    setEditorError(null);
    try {
      if (editingProvider) {
        await providerSwitchApi.updateProvider(activeApp, editingProvider.id, {
          name: editorName,
          category: editorCategory,
          settingsConfig: parsed,
        });
      } else {
        await providerSwitchApi.createProvider(activeApp, {
          name: editorName,
          category: editorCategory,
          settingsConfig: parsed,
        });
      }
      setEditorOpen(false);
      await refreshStatus();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [activeApp, editorCategory, editorConfig, editorName, editingProvider, refreshStatus]);

  const confirmSwitch = useCallback(async () => {
    if (!switchTarget) return;
    setBusy(true);
    try {
      const res = await providerSwitchApi.switchProvider(activeApp, switchTarget.id);
      setNotice(copy("pswitch.switch.done", { name: switchTarget.name, files: res.wrote.join(", ") }));
      setSwitchTarget(null);
      await refreshStatus();
      await loadLive(activeApp, liveFileId);
      await refreshBackups(activeApp);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [activeApp, liveFileId, loadLive, refreshBackups, refreshStatus, switchTarget]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await providerSwitchApi.deleteProvider(activeApp, deleteTarget.id);
      setDeleteTarget(null);
      await refreshStatus();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [activeApp, deleteTarget, refreshStatus]);

  const saveLive = useCallback(
    async (policy = "refuse") => {
      setBusy(true);
      setLiveError(null);
      try {
        await providerSwitchApi.saveLive(activeApp, liveFileId, {
          content: liveContent,
          baseHash: liveBaseHash,
          policy,
        });
        setConflict(null);
        setNotice(copy("pswitch.live.saved", { file: liveFileId }));
        await loadLive(activeApp, liveFileId);
        await refreshBackups(activeApp);
      } catch (error) {
        if (error?.status === 409 && error?.payload?.currentHash !== undefined) {
          setConflict({
            currentContent: error.payload.currentContent ?? null,
            currentHash: error.payload.currentHash,
          });
        } else {
          setLiveError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        setBusy(false);
      }
    },
    [activeApp, liveBaseHash, liveContent, liveFileId, loadLive, refreshBackups],
  );

  const keepMine = useCallback(async () => {
    if (!conflict) return;
    setLiveBaseHash(conflict.currentHash);
    setConflict(null);
    // baseHash now matches disk; save with the in-editor content as "mine".
    setBusy(true);
    try {
      await providerSwitchApi.saveLive(activeApp, liveFileId, {
        content: liveContent,
        baseHash: conflict.currentHash,
        policy: "keepMine",
      });
      setNotice(copy("pswitch.live.saved", { file: liveFileId }));
      await loadLive(activeApp, liveFileId);
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [activeApp, conflict, liveContent, liveFileId, loadLive]);

  const keepTheirs = useCallback(async () => {
    if (!conflict) return;
    setConflict(null);
    setLiveContent(conflict.currentContent ?? "");
    setLiveBaseHash(conflict.currentHash);
  }, [conflict]);

  const confirmRestore = useCallback(async () => {
    if (!restoreTarget) return;
    setBusy(true);
    try {
      await providerSwitchApi.restoreBackup(activeApp, restoreTarget.name, restoreTarget.target || liveFileId);
      setRestoreTarget(null);
      setNotice(copy("pswitch.backups.restored"));
      await loadLive(activeApp, liveFileId);
      await refreshBackups(activeApp);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [activeApp, liveFileId, loadLive, refreshBackups, restoreTarget]);

    const liveFile = useMemo(() => {
    return appState?.files.find((file) => file.id === liveFileId) || null;
  }, [appState, liveFileId]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-oai-black dark:text-white">{copy("pswitch.title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-oai-gray-500 dark:text-oai-gray-400">
            {copy("pswitch.subtitle")}
          </p>
          {status ? (
            <p className="mt-1 font-mono text-xs text-oai-gray-400 dark:text-oai-gray-500">
              {copy("pswitch.storage_path", { path: status.storagePath })}
            </p>
          ) : null}
        </div>
        <Button variant="secondary" size="sm" onClick={() => void refreshStatus()} disabled={busy}>
          <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
          {copy("pswitch.action.refresh")}
        </Button>
      </div>

      {loadError ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {copy("pswitch.error.load")}: {loadError}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-oai-gray-200 bg-white px-4 py-3 text-sm text-oai-gray-700 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-300">
          <span className="min-w-0 break-all">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={copy("pswitch.action.close")}>
            <XIcon />
          </button>
        </div>
      ) : null}

      <div className="mb-6 inline-flex rounded-xl bg-oai-gray-100 p-1 dark:bg-oai-gray-900" role="tablist">
        {APPS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={activeApp === id}
            type="button"
            onClick={() => setActiveApp(id)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 ${
              activeApp === id
                ? "bg-white text-oai-black shadow-sm dark:bg-oai-gray-800 dark:text-white"
                : "text-oai-gray-500 hover:text-oai-black dark:hover:text-white"
            }`}
          >
            <Icon className="h-4 w-4" />
            {copy(labelKey)}
          </button>
        ))}
      </div>

      <section className="mb-8">
        <SectionTitle
          action={
            <Button variant="secondary" size="sm" onClick={() => void openAddDialog()}>
              <Plus className="h-4 w-4" />
              {copy("pswitch.action.add")}
            </Button>
          }
        >
          {copy("pswitch.section.providers")}
        </SectionTitle>
        {!appState || appState.providers.length === 0 ? (
          <Card>
            <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.providers.empty")}</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {appState.providers.map((provider) => {
              const isCurrent = appState.current === provider.id;
              return (
                <Card key={provider.id}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={`relative flex h-2 w-2 shrink-0 ${isCurrent ? "text-oai-brand-500" : "text-oai-gray-300 dark:text-oai-gray-600"}`}
                        aria-hidden
                      >
                        {isCurrent ? (
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-oai-brand-500 opacity-75" />
                        ) : null}
                        <span
                          className={`relative inline-flex h-2 w-2 rounded-full ${isCurrent ? "bg-oai-brand-500" : "bg-oai-gray-300 dark:bg-oai-gray-600"}`}
                        />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-oai-black dark:text-white">{provider.name}</span>
                          <span className="rounded-full bg-oai-gray-100 px-2 py-0.5 text-xs text-oai-gray-500 dark:bg-oai-gray-800 dark:text-oai-gray-400">
                            {provider.category === "official"
                              ? copy("pswitch.provider.category.official")
                              : copy("pswitch.provider.category.custom")}
                          </span>
                          {isCurrent ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-oai-brand-600 dark:text-oai-brand-400">
                              <Check className="h-3.5 w-3.5" />
                              {copy("pswitch.current_badge")}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant={isCurrent ? "ghost" : "primary"}
                        size="sm"
                        disabled={busy || isCurrent}
                        onClick={() => setSwitchTarget(provider)}
                      >
                        {copy("pswitch.action.switch")}
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={copy("pswitch.action.edit")} onClick={() => openEditDialog(provider)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={copy("pswitch.action.delete")} onClick={() => setDeleteTarget(provider)}>
                        <Trash2 className="h-4 w-4 text-red-500 dark:text-red-400" />
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="mb-8">
        <SectionTitle>{copy("pswitch.section.live")}</SectionTitle>
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FileCode className="h-4 w-4 text-oai-gray-400" />
              <select
                value={liveFileId}
                onChange={(event) => setLiveFileId(event.target.value)}
                aria-label={copy("pswitch.live.file")}
                className="rounded-lg border border-oai-gray-200 bg-white px-2.5 py-1.5 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
              >
                {(appState?.files || []).map((file) => (
                  <option key={file.id} value={file.id}>
                    {fileLabel(file.id)}
                  </option>
                ))}
              </select>
            </div>
            {liveFile ? (
              <span className="min-w-0 truncate font-mono text-xs text-oai-gray-400 dark:text-oai-gray-500" title={liveFile.path}>
                {liveFile.path}
              </span>
            ) : null}
          </div>
          {!liveExists ? (
            <p className="mb-2 text-xs text-oai-amber-600 dark:text-oai-amber-400">{copy("pswitch.live.missing")}</p>
          ) : null}
          {liveError ? (
            <p className="mb-2 text-xs text-red-600 dark:text-red-400" role="alert">
              {liveError}
            </p>
          ) : null}
          <textarea
            value={liveContent}
            onChange={(event) => setLiveContent(event.target.value)}
            spellCheck={false}
            rows={14}
            aria-label={copy("pswitch.live.editor_label")}
            className="w-full resize-y rounded-lg border border-oai-gray-200 bg-oai-gray-50 p-3 font-mono text-xs text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:text-oai-gray-100"
          />
          <div className="mt-3 flex justify-end">
            <Button size="sm" disabled={busy} onClick={() => void saveLive("refuse")}>
              {copy("pswitch.live.save")}
            </Button>
          </div>
        </Card>
      </section>

      <section className="mb-8">
        <SectionTitle>{copy("pswitch.section.backups")}</SectionTitle>
        <Card>
          {backups.length === 0 ? (
            <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.backups.empty")}</p>
          ) : (
            <ul className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
              {backups.map((item) => (
                <li key={item.name} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-oai-gray-700 dark:text-oai-gray-300">{item.name}</p>
                    <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">
                      {new Date(item.createdAt).toLocaleString()} · {item.size} B
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRestoreTarget(item)}>
                    <RotateCcw className="h-4 w-4" />
                    {copy("pswitch.action.restore")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {status?.codexAuthStash ? (
        <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">
          {copy("pswitch.stash.notice", { time: status.codexAuthStash.stashedAt || "" })}
        </p>
      ) : null}

      {/* Provider add/edit dialog */}
      {editorOpen ? (
        <CredsModal
          open={editorOpen}
          busy={busy}
          onClose={() => setEditorOpen(false)}
          title={editingProvider ? copy("pswitch.provider.dialog.edit_title") : copy("pswitch.provider.dialog.add_title")}
          subtitle={copy("pswitch.provider.config_hint")}
        >
          <div className="space-y-4 overflow-y-auto px-5 py-4">
            {presets.length ? (
              <EditorField label={copy("pswitch.provider.preset")}>
                <select
                  value=""
                  onChange={(event) => applyPreset(event.target.value)}
                  aria-label={copy("pswitch.provider.preset")}
                  className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                >
                  <option value="">{copy("pswitch.provider.preset.none")}</option>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.nameKey ? copy(preset.nameKey) : preset.name}
                    </option>
                  ))}
                </select>
              </EditorField>
            ) : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
              <EditorField label={copy("pswitch.provider.name")}>
                <input
                  type="text"
                  value={editorName}
                  onChange={(event) => setEditorName(event.target.value)}
                  placeholder={copy("pswitch.provider.name_placeholder")}
                  className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                />
              </EditorField>
              <EditorField label={copy("pswitch.provider.category")}>
                <select
                  value={editorCategory}
                  onChange={(event) => setEditorCategory(event.target.value === "official" ? "official" : "custom")}
                  aria-label={copy("pswitch.provider.category")}
                  className="rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                >
                  <option value="official">{copy("pswitch.provider.category.official")}</option>
                  <option value="custom">{copy("pswitch.provider.category.custom")}</option>
                </select>
              </EditorField>
            </div>
            <EditorField label={copy("pswitch.provider.config")} error={editorError}>
              <textarea
                value={editorConfig}
                onChange={(event) => setEditorConfig(event.target.value)}
                spellCheck={false}
                rows={12}
                aria-label={copy("pswitch.provider.config")}
                className="w-full resize-y rounded-lg border border-oai-gray-200 bg-oai-gray-50 p-3 font-mono text-xs text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:text-oai-gray-100"
              />
            </EditorField>
          </div>
          <div className="flex justify-end gap-2 border-t border-oai-gray-100 px-5 py-3 dark:border-oai-gray-800">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditorOpen(false)}>
              {copy("pswitch.action.cancel")}
            </Button>
            <Button size="sm" disabled={busy || !editorName.trim()} onClick={() => void saveEditor()}>
              {copy("pswitch.action.save")}
            </Button>
          </div>
        </CredsModal>
      ) : null}

      <ConfirmModal
        open={!!switchTarget}
        title={copy("pswitch.switch.confirm_title")}
        description={
          switchTarget
            ? copy("pswitch.switch.confirm_desc", {
                name: switchTarget.name,
                app: appLabel(activeApp),
              })
            : ""
        }
        confirmLabel={copy("pswitch.action.switch")}
        cancelLabel={copy("pswitch.action.cancel")}
        busy={busy}
        onConfirm={() => void confirmSwitch()}
        onCancel={() => setSwitchTarget(null)}
      />

      <ConfirmModal
        open={!!deleteTarget}
        title={copy("pswitch.delete.confirm_title")}
        description={deleteTarget ? copy("pswitch.delete.confirm_desc", { name: deleteTarget.name }) : ""}
        confirmLabel={copy("pswitch.action.delete")}
        cancelLabel={copy("pswitch.action.cancel")}
        destructive
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmModal
        open={!!restoreTarget}
        title={copy("pswitch.backups.restore_confirm_title")}
        description={restoreTarget ? copy("pswitch.backups.restore_confirm_desc", { target: restoreTarget.target || liveFileId }) : ""}
        confirmLabel={copy("pswitch.action.restore")}
        cancelLabel={copy("pswitch.action.cancel")}
        destructive
        busy={busy}
        onConfirm={() => void confirmRestore()}
        onCancel={() => setRestoreTarget(null)}
      />

      {conflict ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]">
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:ring-oai-gray-800"
            role="dialog"
            aria-modal="true"
            aria-label={copy("pswitch.live.conflict_title")}
          >
            <h2 className="text-base font-semibold text-oai-black dark:text-white">{copy("pswitch.live.conflict_title")}</h2>
            <p className="mt-2 text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-300">{copy("pswitch.live.conflict_desc")}</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void keepTheirs()}>
                {copy("pswitch.live.conflict_keep_theirs")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void keepMine()}>
                {copy("pswitch.live.conflict_keep_mine")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function appLabel(app) {
  const entry = APPS.find((item) => item.id === app);
  return entry ? copy(entry.labelKey) : app;
}

function fileLabel(fileId) {
  switch (fileId) {
    case "settings":
      return copy("pswitch.live.file.settings");
    case "config":
      return copy("pswitch.live.file.config");
    case "auth":
      return copy("pswitch.live.file.auth");
    case "env":
      return copy("pswitch.live.file.env");
    default:
      return fileId;
  }
}

export default ProviderSwitchPage;
