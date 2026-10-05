import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS as DndCss } from "@dnd-kit/utilities";
import {
  Check,
  Globe,
  GripVertical,
  Import,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { Button, Card, ConfirmModal } from "../ui/components";
import { PageHeader } from "../ui/components/PageHeader";
import { PageTabs } from "../ui/components/PageTabs";
import { UnsavedChangesGuard } from "../ui/components/UnsavedChangesGuard";
import { PresetIcon, presetAvatarClass, ProviderEditDialog } from "./provider-edit-dialog";
import { ProviderMcpPanel } from "./provider-mcp-panel";
import { ProviderPromptsPanel } from "./provider-prompts-panel";
import { ProviderQuotaLine } from "./provider-quota-line";

// Provider config management — an interaction port of cc-switch's provider
// module. Presets live in ~/.aitool/provider-switch (served by the local
// CLI); switching projects a provider's key fields into the live tool configs
// (~/.claude/settings.json, ~/.codex/config.toml + auth.json, ~/.gemini/.env,
// plus the additive apps' native configs — opencode.json, openclaw.json,
// MiniMax Code's config.yaml — via src/lib/provider-switch/additive.js) with
// pre-write backups, leaving user-owned fields alone. The card list is
// drag-sortable, providers can be imported from the current live config, and
// editing the active provider re-applies it immediately. Which agent tabs
// show follows the visible-apps setting (cc-switch's AppVisibilitySettings),
// edited on the dashboard's Settings page.

const APPS = [
  { id: "claude", labelKey: "pswitch.tab.claude" },
  { id: "codex", labelKey: "pswitch.tab.codex" },
  { id: "gemini", labelKey: "pswitch.tab.gemini" },
  { id: "opencode", labelKey: "pswitch.tab.opencode" },
  { id: "openclaw", labelKey: "pswitch.tab.openclaw" },
  { id: "mcode", labelKey: "pswitch.tab.mcode" },
  { id: "hermes", labelKey: "pswitch.tab.hermes" },
  { id: "pi", labelKey: "pswitch.tab.pi" },
  { id: "grokbuild", labelKey: "pswitch.tab.grokbuild" },
];

function SectionTitle({ children, action = null }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-oai-gray-500 dark:text-oai-gray-400">{children}</h2>
      {action}
    </div>
  );
}

function SortableProviderCard({ app, provider, isCurrent, busy, dragLabel, onSwitch, onEdit, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: provider.id,
    disabled: busy,
    transition: { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  });
  const style = {
    position: "relative",
    zIndex: isDragging ? 2 : undefined,
    transform: DndCss.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border bg-white px-4 py-3.5 transition-colors dark:bg-oai-gray-900 ${
        isCurrent
          ? "border-oai-brand-500 ring-1 ring-oai-brand-500/30"
          : "border-oai-gray-200 dark:border-oai-gray-800"
      } ${isDragging ? "shadow-lg" : ""}`}
    >
      <div className="flex flex-wrap items-start gap-3 sm:flex-nowrap">
        <button
          type="button"
          className="-ml-1 mt-0.5 cursor-grab touch-none rounded-md p-1 text-oai-gray-300 transition-colors hover:bg-oai-gray-100 hover:text-oai-gray-500 active:cursor-grabbing disabled:opacity-40 dark:text-oai-gray-600 dark:hover:bg-oai-gray-800 dark:hover:text-oai-gray-300"
          disabled={busy}
          aria-label={dragLabel}
          title={dragLabel}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${presetAvatarClass(provider.avatarColor)}`}
        >
          <PresetIcon icon={provider.avatarIcon} color={provider.avatarColor} className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-oai-black dark:text-white">{provider.name}</span>
            <span className="rounded-full bg-oai-gray-100 px-2 py-0.5 text-xs text-oai-gray-500 dark:bg-oai-gray-800 dark:text-oai-gray-400">
              {provider.category === "official"
                ? copy("pswitch.provider.category.official")
                : copy("pswitch.provider.category.custom")}
            </span>
            {isCurrent ? (
              <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-oai-brand-50 px-2 py-0.5 text-xs font-medium text-oai-brand-600 dark:bg-oai-brand-950/50 dark:text-oai-brand-400">
                <Check className="h-3 w-3" />
                {copy("pswitch.current_badge")}
              </span>
            ) : null}
          </div>
          {provider.notes ? (
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
              {provider.notes}
            </p>
          ) : null}
          {provider.websiteUrl ? (
            <a
              href={provider.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-oai-gray-400 hover:text-oai-brand-600 dark:text-oai-gray-500 dark:hover:text-oai-brand-400"
            >
              <Globe className="h-3 w-3 shrink-0" />
              <span className="truncate">{provider.websiteUrl.replace(/^https?:\/\//, "")}</span>
            </a>
          ) : null}
          <ProviderQuotaLine app={app} provider={provider} />
        </div>
        <div className="ml-auto flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto">
          <Button
            variant={isCurrent ? "ghost" : "primary"}
            size="sm"
            disabled={busy || isCurrent}
            onClick={onSwitch}
          >
            {copy("pswitch.action.switch")}
          </Button>
          <Button variant="ghost" size="sm" aria-label={copy("pswitch.action.edit")} onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" aria-label={copy("pswitch.action.delete")} onClick={onDelete}>
            <Trash2 className="h-4 w-4 text-red-500 dark:text-red-400" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ProviderSwitchPage() {
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [activeApp, setActiveApp] = useState("claude");
  const [notice, setNotice] = useState(null);

  // dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDirty, setDialogDirty] = useState(false);
  const [dialogSaving, setDialogSaving] = useState(false);
  const onDialogDirty = useCallback((dirty, saving) => { setDialogDirty(dirty); setDialogSaving(saving); }, []);
  const [editingProvider, setEditingProvider] = useState(null);
  const [presets, setPresets] = useState([]);

  // confirm dialogs
  const [switchTarget, setSwitchTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  // backups
  const [backups, setBackups] = useState([]);
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const appState = useMemo(() => {
    return status?.apps.find((app) => app.app === activeApp) || null;
  }, [status, activeApp]);
  // "mcp" and "prompts" are tool tabs, not per-app provider lists — the
  // provider header buttons and ProviderEditDialog (which unconditionally
  // reads the active app's endpoint paths) don't apply to them.
  const isMcpTab = activeApp === "mcp";
  const isPromptsTab = activeApp === "prompts";
  const isUtilityTab = isMcpTab || isPromptsTab;

  // Visible tabs follow the settings-page toggle (cc-switch's
  // AppVisibilitySettings); the backend guarantees at least one stays on.
  const visibleApps = useMemo(() => {
    return APPS.filter(({ id }) => !status?.visibleApps || status.visibleApps[id] !== false);
  }, [status]);

  useEffect(() => {
    // "mcp" and "prompts" are tool tabs — not apps, so the visible-apps
    // filter doesn't apply to them.
    if (activeApp === "mcp" || activeApp === "prompts") return;
    if (!visibleApps.some(({ id }) => id === activeApp) && visibleApps.length > 0) {
      setActiveApp(visibleApps[0].id);
    }
  }, [visibleApps, activeApp]);

  // Card presentation: provider record + preset-derived avatar styling.
  const providerRows = useMemo(() => {
    return (appState?.providers || []).map((provider) => ({
      ...provider,
      avatarIcon: provider.icon || (provider.category === "official" ? officialIconFor(activeApp) : "shuffle"),
      avatarColor: provider.iconColor || (provider.category === "official" ? officialColorFor(activeApp) : "blue"),
    }));
  }, [appState, activeApp]);

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

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    // The tool tabs have no per-app backup list; skip the doomed request.
    if (activeApp === "mcp" || activeApp === "prompts") return;
    void refreshBackups(activeApp);
  }, [activeApp, refreshBackups]);

  const openDialog = useCallback(
    async (provider) => {
      setEditingProvider(provider || null);
      // Load presets before opening so the dialog's init effect sees them and
      // auto-selects the first preset (add mode) on mount.
      let list = [];
      try {
        const res = await providerSwitchApi.getPresets(activeApp);
        list = res.presets || [];
      } catch {
        list = [];
      }
      setPresets(list);
      setDialogOpen(true);
    },
    [activeApp],
  );

  const onDialogSaved = useCallback(
    async (message) => {
      setNotice(message);
      await refreshStatus();
    },
    [refreshStatus],
  );

  const onDialogError = useCallback((message) => setNotice(message), []);

  const confirmSwitch = useCallback(async () => {
    if (!switchTarget) return;
    setBusy(true);
    try {
      const res = await providerSwitchApi.switchProvider(activeApp, switchTarget.id);
      setNotice(copy("pswitch.switch.done", { name: switchTarget.name, files: res.wrote.join(", ") }));
      setSwitchTarget(null);
      await refreshStatus();
      await refreshBackups(activeApp);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [activeApp, refreshBackups, refreshStatus, switchTarget]);

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

  const importFromLive = useCallback(async () => {
    setBusy(true);
    try {
      const res = await providerSwitchApi.importFromLive(activeApp);
      setNotice(copy("pswitch.provider.imported", { name: res.provider.name }));
      await refreshStatus();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [activeApp, refreshStatus]);

  const handleDragEnd = useCallback(
    async (event) => {
      setDragOverId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const ids = providerRows.map((row) => row.id);
      const from = ids.indexOf(String(active.id));
      const to = ids.indexOf(String(over.id));
      if (from === -1 || to === -1) return;
      const orderedIds = arrayMove(ids, from, to);
      setBusy(true);
      try {
        const res = await providerSwitchApi.reorderProviders(activeApp, orderedIds);
        setStatus((current) => ({
          ...current,
          apps: current.apps.map((app) => (app.app === activeApp ? { ...app, providers: res.providers } : app)),
        }));
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [activeApp, providerRows],
  );

  const confirmRestore = useCallback(async () => {
    if (!restoreTarget) return;
    setBusy(true);
    try {
      await providerSwitchApi.restoreBackup(activeApp, restoreTarget.name);
      setRestoreTarget(null);
      setNotice(copy("pswitch.backups.restored"));
      await refreshBackups(activeApp);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [activeApp, refreshBackups, restoreTarget]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <UnsavedChangesGuard dirty={dialogOpen && dialogDirty} busy={dialogOpen && dialogSaving} />
      <PageHeader title={copy("pswitch.title")} description={copy("pswitch.subtitle")}
        actions={<Button variant="secondary" size="sm" onClick={() => void refreshStatus()} disabled={busy}>
          <RefreshCw className="h-4 w-4" />{copy("pswitch.action.refresh")}
        </Button>} />

      {loadError ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {copy("pswitch.error.load")}: {loadError}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-oai-gray-200 bg-white px-4 py-3 text-sm text-oai-gray-700 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-300">
          <span className="min-w-0 break-all">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={copy("pswitch.action.close")}>
            <X className="h-4 w-4 shrink-0" />
          </button>
        </div>
      ) : null}

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <PageTabs
          options={[
            ...visibleApps.map((item) => ({ ...item, label: copy(item.labelKey) })),
            { id: "mcp", label: copy("pswitch.mcp.tab") },
            { id: "prompts", label: copy("pswitch.prompts.tab") },
          ]}
          value={activeApp}
          onChange={setActiveApp}
          label={copy("pswitch.title")}
          panelId="provider-panel"
        />
        {!isUtilityTab ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void importFromLive()}>
              <Import className="h-4 w-4" />
              {copy("pswitch.action.import_live")}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void openDialog(null)}>
              <Plus className="h-4 w-4" />
              {copy("pswitch.action.add")}
            </Button>
          </div>
        ) : null}
      </div>

      <div role="tabpanel" id="provider-panel" aria-labelledby={`provider-panel-${activeApp}`}>
      {isUtilityTab ? (
        isMcpTab ? <ProviderMcpPanel /> : <ProviderPromptsPanel />
      ) : (
      <>
      <section className="mb-8">
        <SectionTitle>{copy("pswitch.section.providers")}</SectionTitle>
        {!appState || appState.providers.length === 0 ? (
          <Card>
            <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{loadError || copy(!status ? "proxy.loading" : "pswitch.providers.empty")}</p>
          </Card>
        ) : (
          <DndContext
            sensors={dragSensors}
            collisionDetection={closestCenter}
            onDragStart={() => setNotice(null)}
            onDragOver={({ over }) => setDragOverId(over ? String(over.id) : null)}
            onDragCancel={() => setDragOverId(null)}
            onDragEnd={(event) => void handleDragEnd(event)}
          >
            <SortableContext
              items={providerRows.map((row) => row.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-2.5">
                {providerRows.map((provider) => (
                  <SortableProviderCard
                    key={provider.id}
                    app={activeApp}
                    provider={provider}
                    isCurrent={appState.current === provider.id}
                    busy={busy}
                    dragLabel={copy("pswitch.provider.drag_handle", { name: provider.name })}
                    isDragOver={dragOverId === provider.id}
                    onSwitch={() => setSwitchTarget(provider)}
                    onEdit={() => void openDialog(provider)}
                    onDelete={() => setDeleteTarget(provider)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
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
      </>
      )}

      </div>
      {status ? <p className="mb-3 break-all font-mono text-xs text-oai-gray-500">{copy("pswitch.storage_path", { path: status.storagePath })}</p> : null}
      {status?.codexAuthStash ? (
        <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">
          {copy("pswitch.stash.notice", { time: status.codexAuthStash.stashedAt || "" })}
        </p>
      ) : null}

      {!isUtilityTab ? (
        <ProviderEditDialog
          onDirtyChange={onDialogDirty}
          open={dialogOpen}
          busy={busy}
          app={activeApp}
          appState={appState}
          presets={presets}
          editing={editingProvider}
          onClose={() => setDialogOpen(false)}
          onSaved={onDialogSaved}
          onError={onDialogError}
        />
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
        description={
          restoreTarget
            ? copy("pswitch.backups.restore_confirm_desc", { target: restoreTarget.target || "" })
            : ""
        }
        confirmLabel={copy("pswitch.action.restore")}
        cancelLabel={copy("pswitch.action.cancel")}
        destructive
        busy={busy}
        onConfirm={() => void confirmRestore()}
        onCancel={() => setRestoreTarget(null)}
      />
    </div>
  );
}

function officialIconFor(app) {
  return { claude: "sparkles", codex: "terminal", gemini: "gem", opencode: "boxes", openclaw: "globe", mcode: "sparkles", hermes: "sparkles", pi: "boxes", grokbuild: "terminal" }[app] || "sparkles";
}

function officialColorFor(app) {
  return { claude: "orange", codex: "green", gemini: "sky", opencode: "violet", openclaw: "teal", mcode: "amber", hermes: "violet", pi: "sky", grokbuild: "gray" }[app] || "gray";
}

function appLabel(app) {
  const entry = APPS.find((item) => item.id === app);
  return entry ? copy(entry.labelKey) : app;
}

export default ProviderSwitchPage;
