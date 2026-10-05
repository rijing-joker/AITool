import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ShieldAlert,
  TimerReset,
  Trash2,
  X,
} from "lucide-react";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { Button, Card, ConfirmModal } from "../ui/components";
import { PageHeader } from "../ui/components/PageHeader";
import { PageTabs } from "../ui/components/PageTabs";
import { UnsavedChangesGuard } from "../ui/components/UnsavedChangesGuard";
import { ModalFrame } from "../ui/components/ModalFrame";
import { useVisiblePolling } from "../hooks/use-visible-polling";
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

function FailoverEditDialog({ draft, setDraft, saving, onClose, onSave }) {
  // Read currentTarget synchronously — React nulls it before a setState
  // updater runs, and StrictMode replays updaters.
  const numberField = (key) => ({
    value: draft[key],
    onChange: (event) => {
      const { value } = event.currentTarget;
      setDraft((current) => ({ ...current, [key]: value }));
    },
    inputMode: "numeric",
    "aria-label": copy(`pswitch.failover.${key === "failureRatePct" ? "rate" : key === "cooldownMinutes" ? "cooldown_minutes" : key === "windowMinutes" ? "window" : "min_requests"}`),
    className: "h-10 w-24 rounded-lg border border-oai-gray-200 bg-transparent px-2 text-sm tabular-nums dark:border-oai-gray-700",
  });
  return (
    <ModalFrame open onClose={onClose} label={copy("pswitch.failover.settings")}>
      <div className="flex items-center justify-between border-b border-oai-gray-100 px-5 py-3.5 dark:border-oai-gray-800">
        <h2 className="text-sm font-semibold">{copy("pswitch.failover.settings")}</h2>
        <button type="button" onClick={onClose} aria-label={copy("pswitch.action.close")} className="rounded-lg p-1.5 text-oai-gray-500 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800">
          <span aria-hidden="true" className="text-base leading-none">×</span>
        </button>
      </div>
      <div className="space-y-3 px-5 py-4 text-sm">
        <label className="flex min-h-8 items-center gap-2">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => {
              const { checked } = event.currentTarget;
              setDraft((current) => ({ ...current, enabled: checked }));
            }}
            className="h-4 w-4 accent-oai-brand-600"
          />
          {copy("pswitch.failover.enable")}
        </label>
        <label className="flex min-h-8 items-center gap-2">
          <input
            type="checkbox"
            checked={draft.autoSwitch}
            onChange={(event) => {
              const { checked } = event.currentTarget;
              setDraft((current) => ({ ...current, autoSwitch: checked }));
            }}
            className="h-4 w-4 accent-oai-brand-600"
          />
          {copy("pswitch.failover.auto_switch")}
        </label>
        <div className="flex items-center justify-between gap-4"><span>{copy("pswitch.failover.window")}</span><input {...numberField("windowMinutes")} /></div>
        <div className="flex items-center justify-between gap-4"><span>{copy("pswitch.failover.min_requests")}</span><input {...numberField("minRequests")} /></div>
        <div className="flex items-center justify-between gap-4"><span>{copy("pswitch.failover.rate")}</span><input {...numberField("failureRatePct")} /></div>
        <div className="flex items-center justify-between gap-4"><span>{copy("pswitch.failover.cooldown_minutes")}</span><input {...numberField("cooldownMinutes")} /></div>
        <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("pswitch.failover.hint")}</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-oai-gray-100 px-5 py-3 dark:border-oai-gray-800">
        <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-oai-gray-200 px-3 font-medium hover:bg-oai-gray-50 sm:min-h-0 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800">{copy("shared.action.cancel")}</button>
        <button type="button" onClick={onSave} disabled={saving} className="min-h-10 rounded-lg bg-oai-black px-3 font-medium text-white hover:bg-oai-gray-800 disabled:opacity-50 sm:min-h-0 dark:bg-white dark:text-oai-black dark:hover:bg-oai-gray-200">{copy("shared.action.save")}</button>
      </div>
    </ModalFrame>
  );
}

// Failover strip: per-app health of the active provider, cooldown alerts and
// the settings entry. Self-contained — the monitor runs server-side, this
// only polls GET /failover and renders it.
function FailoverBar({ failover, activeApp, busy, onEdit, onSwitchTo }) {
  if (!failover?.config) return null;
  const config = failover.config;
  const appInfo = failover.apps?.[activeApp] || null;
  return (
    <div className="mb-6 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
          {config.enabled && appInfo?.health
            ? copy("pswitch.failover.health", {
                window: config.windowMinutes,
                requests: appInfo.health.requests,
                failed: appInfo.health.failed,
                ratePct: appInfo.health.ratePct,
              })
            : config.enabled
              ? copy("pswitch.failover.no_data")
              : copy("pswitch.failover.off")}
        </span>
        <button
          type="button"
          onClick={onEdit}
          className="min-h-8 rounded-lg px-2 font-medium text-oai-brand-600 hover:bg-oai-gray-50 dark:text-oai-brand-400 dark:hover:bg-oai-gray-800"
        >
          {copy("pswitch.failover.settings")}
        </button>
      </div>
      {config.enabled && appInfo?.cooldown ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
        >
          <span>{copy("pswitch.failover.cooldown", { reason: appInfo.cooldown.reason })}</span>
          {appInfo.switchedTo ? (
            <span>{copy("pswitch.failover.switched", { name: appInfo.suggestion?.name || appInfo.switchedTo })}</span>
          ) : appInfo.suggestion ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onSwitchTo(appInfo.suggestion)}
                className="min-h-8 rounded-lg bg-oai-black px-2.5 font-medium text-white hover:bg-oai-gray-800 disabled:opacity-50 dark:bg-white dark:text-oai-black dark:hover:bg-oai-gray-200"
              >
                {copy("pswitch.failover.switch_to", { name: appInfo.suggestion.name })}
              </button>
              {config.autoSwitch ? <span>{copy("pswitch.failover.auto_hint")}</span> : null}
            </>
          ) : (
            <span>{copy("pswitch.failover.no_candidate")}</span>
          )}
          {appInfo.switchError ? <span className="text-red-600 dark:text-red-400">{appInfo.switchError}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function downloadJsonBlob(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Passphrase-encrypted export/import of the provider-switch stores. The
// passphrase lives only in this dialog; the export downloads an opaque JSON
// blob the user keeps wherever they keep dotfiles.
function EncryptedBackupDialog({ mode, onClose, onImported }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [payloadText, setPayloadText] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const isExport = mode === "export";

  const run = async () => {
    if (working) return;
    setError("");
    if (passphrase.length < 8) {
      setError(copy("pswitch.encrypted.short"));
      return;
    }
    if (isExport && passphrase !== confirmPassphrase) {
      setError(copy("pswitch.encrypted.mismatch"));
      return;
    }
    if (isExport) {
      setWorking(true);
      try {
        const res = await providerSwitchApi.exportEncryptedBackup(passphrase);
        const stamp = new Date().toISOString().slice(0, 10);
        downloadJsonBlob(`aitool-providers-backup-${stamp}.json`, res.payload);
        onImported();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      } finally {
        setWorking(false);
      }
      return;
    }
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      setError(copy("pswitch.encrypted.bad_file"));
      return;
    }
    setWorking(true);
    try {
      const res = await providerSwitchApi.importEncryptedBackup(passphrase, payload);
      showToast({ title: copy("pswitch.encrypted.imported", { count: res.restored.length }) });
      await onImported();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setWorking(false);
    }
  };

  const canRun = !working && passphrase.length >= 8 && (isExport || payloadText.trim() !== "");
  return (
    <ModalFrame open onClose={onClose} label={isExport ? copy("pswitch.encrypted.export") : copy("pswitch.encrypted.import")}>
      <div className="flex min-w-0 flex-col gap-3">
        <h2 className="text-sm font-semibold">{isExport ? copy("pswitch.encrypted.export") : copy("pswitch.encrypted.import")}</h2>
        <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {isExport ? copy("pswitch.encrypted.export_hint") : copy("pswitch.encrypted.import_hint")}
        </p>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.encrypted.passphrase")}</span>
          <input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.currentTarget.value)}
            autoComplete="new-password"
            aria-label={copy("pswitch.encrypted.passphrase")}
            className="h-9 w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 text-sm dark:border-oai-gray-700"
          />
        </label>
        {isExport ? (
          <label className="block space-y-1">
            <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.encrypted.confirm")}</span>
            <input
              type="password"
              value={confirmPassphrase}
              onChange={(event) => setConfirmPassphrase(event.currentTarget.value)}
              autoComplete="new-password"
              aria-label={copy("pswitch.encrypted.confirm")}
              className="h-9 w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 text-sm dark:border-oai-gray-700"
            />
          </label>
        ) : (
          <label className="block space-y-1">
            <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.encrypted.file")}</span>
            <input
              type="file"
              accept="application/json,.json"
              aria-label={copy("pswitch.encrypted.file")}
              onChange={async (event) => {
                const file = event.currentTarget.files?.[0];
                if (!file) return;
                try {
                  setPayloadText(await file.text());
                  setError("");
                } catch {
                  setError(copy("pswitch.encrypted.bad_file"));
                }
              }}
              className="text-xs"
            />
          </label>
        )}
        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        <div className="flex items-center justify-end gap-2 border-t border-oai-gray-100 pt-3 dark:border-oai-gray-800">
          <Button variant="secondary" size="sm" disabled={working} onClick={onClose}>{copy("pswitch.action.cancel")}</Button>
          <Button size="sm" disabled={!canRun} onClick={() => void run()}>
            {isExport ? copy("pswitch.encrypted.export") : copy("pswitch.encrypted.import")}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}

function SortableProviderCard({ app, provider, isCurrent, busy, dragLabel, cooldownMs, onSwitch, onEdit, onDelete }) {
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
            {cooldownMs != null ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium tabular-nums text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                title={copy("pswitch.failover.cooldown_badge", { minutes: Math.max(1, Math.ceil(cooldownMs / 60000)) })}
              >
                <TimerReset className="h-3 w-3" aria-hidden="true" />
                {copy("pswitch.failover.cooldown_badge", { minutes: Math.max(1, Math.ceil(cooldownMs / 60000)) })}
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

  // failover monitor (server-side evaluation, polled)
  const [failover, setFailover] = useState(null);
  const [failoverDialogOpen, setFailoverDialogOpen] = useState(false);
  const [failoverDraft, setFailoverDraft] = useState(null);
  const [failoverSaving, setFailoverSaving] = useState(false);
  // encrypted backup (export downloads a blob; import restores the stores)
  const [backupDialog, setBackupDialog] = useState(null);

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
      cooldownMs: failover?.cooldowns?.find((entry) => entry.app === activeApp && entry.id === provider.id)?.remainingMs ?? null,
    }));
  }, [appState, activeApp, failover]);

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

  const refreshFailover = useCallback(async () => {
    try {
      const res = await providerSwitchApi.getFailover();
      setFailover(res.failover);
    } catch {
      setFailover(null);
    }
  }, []);

  const runAutoEvaluate = useRef(false);
  const evaluateAutoSwitch = useCallback(async (next) => {
    if (runAutoEvaluate.current) return;
    if (!next?.config?.enabled || !next?.config?.autoSwitch) return;
    if (!(next.suggestions || []).length) return;
    runAutoEvaluate.current = true;
    try {
      await providerSwitchApi.runFailoverEvaluation();
      const res = await providerSwitchApi.getFailover();
      if (!res.failover.config.autoSwitch || (res.failover.suggestions || []).length === 0) {
        setFailover(res.failover);
      }
    } catch {
      /* the suggestion banner stays; user can switch manually */
    }
  }, []);

  // Visible-polling keeps one non-overlapping loop that pauses on hidden tabs.
  // Declared after evaluateAutoSwitch — the deps array is evaluated at render.
  const pollFailover = useVisiblePolling(
    useCallback(async (signal) => {
      try {
        const res = await providerSwitchApi.getFailover(signal);
        if (!signal.aborted) {
          setFailover(res.failover);
          void evaluateAutoSwitch(res.failover);
        }
      } catch {
        /* transient; the poll retries */
      }
      return true;
    }, [evaluateAutoSwitch]),
    60_000,
  );
  const pollFailoverRef = useRef(pollFailover);
  useEffect(() => {
    pollFailoverRef.current = pollFailover;
  }, [pollFailover]);

  const openFailoverEdit = useCallback(() => {
    const source = failover?.config || {};
    setFailoverDraft({
      enabled: source.enabled === true,
      autoSwitch: source.autoSwitch === true,
      windowMinutes: String(source.windowMinutes ?? 30),
      minRequests: String(source.minRequests ?? 5),
      failureRatePct: String(source.failureRatePct ?? 50),
      cooldownMinutes: String(source.cooldownMinutes ?? 30),
    });
    setFailoverDialogOpen(true);
  }, [failover]);

  const saveFailover = useCallback(async () => {
    if (!failoverDraft || failoverSaving) return;
    setFailoverSaving(true);
    try {
      const res = await providerSwitchApi.updateFailover({
        enabled: failoverDraft.enabled,
        autoSwitch: failoverDraft.autoSwitch,
        windowMinutes: Number(failoverDraft.windowMinutes) || 30,
        minRequests: Number(failoverDraft.minRequests) || 5,
        failureRatePct: Number(failoverDraft.failureRatePct) || 50,
        cooldownMinutes: Number(failoverDraft.cooldownMinutes) || 30,
      });
      setFailover((current) => (current ? { ...current, config: res.config } : current));
      setFailoverDialogOpen(false);
      void refreshFailover();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setFailoverSaving(false);
    }
  }, [failoverDraft, failoverSaving, refreshFailover]);

  const switchToSuggestion = useCallback(async (suggestion) => {
    if (!suggestion) return;
    setBusy(true);
    try {
      const res = await providerSwitchApi.switchProvider(activeApp, suggestion.id);
      setNotice(copy("pswitch.switch.done", { name: suggestion.name, files: res.wrote.join(", ") }));
      await refreshStatus();
      await refreshBackups(activeApp);
      await refreshFailover();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [activeApp, refreshBackups, refreshFailover, refreshStatus]);

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
      await refreshFailover();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [activeApp, refreshBackups, refreshFailover, refreshStatus, switchTarget]);

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
      <FailoverBar
        failover={failover}
        activeApp={activeApp}
        busy={busy}
        onEdit={openFailoverEdit}
        onSwitchTo={(suggestion) => void switchToSuggestion(suggestion)}
      />
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
                    cooldownMs={provider.cooldownMs}
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
        <div className="flex items-center justify-between gap-2">
          <SectionTitle>{copy("pswitch.section.backups")}</SectionTitle>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setBackupDialog({ mode: "export" })}>
              {copy("pswitch.encrypted.export")}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setBackupDialog({ mode: "import" })}>
              {copy("pswitch.encrypted.import")}
            </Button>
          </div>
        </div>
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

      {backupDialog ? (
        <EncryptedBackupDialog
          mode={backupDialog.mode}
          busy={busy}
          onClose={() => setBackupDialog(null)}
          onImported={async () => {
            setBackupDialog(null);
            await refreshStatus();
            await refreshBackups(activeApp);
          }}
        />
      ) : null}
      {failoverDialogOpen && failoverDraft ? (
        <FailoverEditDialog
          draft={failoverDraft}
          setDraft={setFailoverDraft}
          saving={failoverSaving}
          onClose={() => setFailoverDialogOpen(false)}
          onSave={() => void saveFailover()}
        />
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
