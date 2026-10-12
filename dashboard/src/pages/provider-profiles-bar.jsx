import React, { useCallback, useEffect, useState } from "react";
import { copy } from "../lib/copy";
import { profilesApi } from "../lib/provider-switch-api";
import { ConfirmModal } from "../ui/components";
import { ModalFrame } from "../ui/components/ModalFrame";

// ---------------------------------------------------------------------------
// Profiles bar (cc-switch's ProfileSwitcher/ProfileManageDialog, reduced to
// this fork's per-app page layout): named snapshots of the active app's
// providers/MCP/skills/prompts state. Applying is best-effort — warnings from
// the server surface in the page notice. Scope mirrors profiles.js on the
// backend: every app whose pswitch surface carries all four slots (openclaw
// has no MCP/skills support and stays outside profiles).
// ---------------------------------------------------------------------------

const PROFILE_APPS = ["claude", "codex", "gemini", "grokbuild", "opencode", "hermes", "mcode", "pi"];

const inputClass = "h-10 w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700";

function ManageDialog({ open, profiles, currentId, busy, onClose, onRename, onDelete }) {
  const [renaming, setRenaming] = useState({});
  return (
    <ModalFrame open={open} onClose={onClose} label={copy("pswitch.profile.manage_title")}>
      <div className="flex items-center justify-between border-b border-oai-gray-100 px-5 py-3.5 dark:border-oai-gray-800">
        <h2 className="text-sm font-semibold">{copy("pswitch.profile.manage_title")}</h2>
        <button type="button" onClick={onClose} aria-label={copy("pswitch.action.close")} className="rounded-lg p-1.5 text-oai-gray-500 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800">
          <span aria-hidden="true" className="text-base leading-none">×</span>
        </button>
      </div>
      <div className="max-h-[60vh] space-y-2 overflow-y-auto px-5 py-4 text-sm">
        {profiles.length === 0 ? (
          <p className="text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.profile.empty")}</p>
        ) : (
          profiles.map((profile) => (
            <div key={profile.id} className="flex items-center justify-between gap-3 rounded-lg border border-oai-gray-100 px-3 py-2 dark:border-oai-gray-800">
              <div className="flex min-w-0 items-center gap-2">
                <input
                  value={renaming[profile.id] ?? profile.name}
                  onChange={(event) => setRenaming((current) => ({ ...current, [profile.id]: event.currentTarget.value }))}
                  aria-label={copy("pswitch.profile.name_label")}
                  className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-sm hover:border-oai-gray-200 focus:border-oai-gray-300 focus:outline-none dark:hover:border-oai-gray-700"
                />
                {currentId === profile.id ? (
                  <span className="shrink-0 rounded-full bg-oai-gray-100 px-2 py-0.5 text-xs text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-300">{copy("pswitch.current_badge")}</span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy || (renaming[profile.id] ?? profile.name) === profile.name || !(renaming[profile.id] ?? "").trim()}
                  onClick={() => {
                    void onRename(profile.id, renaming[profile.id] ?? profile.name);
                    setRenaming((current) => ({ ...current, [profile.id]: undefined }));
                  }}
                  className="min-h-8 rounded-md border border-oai-gray-200 px-2 text-xs font-medium hover:bg-oai-gray-50 disabled:opacity-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800"
                >
                  {copy("pswitch.profile.rename")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onDelete(profile)}
                  className="min-h-8 rounded-md border border-red-200 px-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:hover:bg-red-950"
                >
                  {copy("pswitch.action.delete")}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </ModalFrame>
  );
}

export function ProviderProfilesBar({ activeApp, onNotice, onChanged }) {
  const [profiles, setProfiles] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [applyTarget, setApplyTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await profilesApi.list();
      setProfiles(res.profiles);
      setCurrentId(res.currentIds[activeApp] ?? null);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : String(error));
    }
  }, [activeApp, onNotice]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async (action) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [onNotice]);

  if (!PROFILE_APPS.includes(activeApp)) return null;

  const createProfile = () => run(async () => {
    if (!newName.trim()) return;
    await profilesApi.create({ name: newName.trim(), app: activeApp });
    setCreating(false);
    setNewName("");
    onNotice?.(copy("pswitch.profile.created"));
    await load();
    await onChanged?.();
  });

  const applyProfile = (profile) => run(async () => {
    const res = await profilesApi.apply({ id: profile.id, app: activeApp });
    const warnings = Array.isArray(res.warnings) ? res.warnings : [];
    onNotice?.(warnings.length > 0
      ? copy("pswitch.profile.applied_with_warnings", { warnings: warnings.join(" · ") })
      : copy("pswitch.profile.applied"));
    setApplyTarget(null);
    await load();
    await onChanged?.();
  });

  const renameProfile = (id, name) => run(async () => {
    await profilesApi.update({ id, name });
    onNotice?.(copy("pswitch.profile.saved"));
    await load();
  });

  const deleteProfile = () => run(async () => {
    if (!deleteTarget) return;
    await profilesApi.remove(deleteTarget.id);
    setDeleteTarget(null);
    onNotice?.(copy("pswitch.profile.deleted"));
    await load();
    await onChanged?.();
  });

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-oai-gray-100 px-4 py-3 dark:border-oai-gray-800">
      <span className="text-xs font-semibold text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.profile.bar_label")}</span>
      {profiles.map((profile) => (
        <button
          key={profile.id}
          type="button"
          disabled={busy}
          onClick={() => setApplyTarget(profile)}
          className={`min-h-8 rounded-full px-3 text-xs font-medium disabled:opacity-50 ${
            currentId === profile.id
              ? "bg-oai-black text-white dark:bg-white dark:text-oai-black"
              : "border border-oai-gray-200 hover:bg-oai-gray-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800"
          }`}
        >
          {profile.name}
        </button>
      ))}
      {profiles.length === 0 ? (
        <span className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("pswitch.profile.empty")}</span>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <button type="button" disabled={busy} onClick={() => setCreating(true)} className="min-h-8 rounded-lg border border-oai-gray-200 px-2.5 text-xs font-medium hover:bg-oai-gray-50 disabled:opacity-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800">
          {copy("pswitch.profile.new")}
        </button>
        <button type="button" disabled={busy} onClick={() => setManageOpen(true)} className="min-h-8 rounded-lg border border-oai-gray-200 px-2.5 text-xs font-medium hover:bg-oai-gray-50 disabled:opacity-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800">
          {copy("pswitch.profile.manage")}
        </button>
      </div>

      {creating ? (
        <ModalFrame open onClose={() => setCreating(false)} label={copy("pswitch.profile.new")}>
          <div className="flex items-center justify-between border-b border-oai-gray-100 px-5 py-3.5 dark:border-oai-gray-800">
            <h2 className="text-sm font-semibold">{copy("pswitch.profile.new")}</h2>
            <button type="button" onClick={() => setCreating(false)} aria-label={copy("pswitch.action.close")} className="rounded-lg p-1.5 text-oai-gray-500 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800">
              <span aria-hidden="true" className="text-base leading-none">×</span>
            </button>
          </div>
          <div className="space-y-3 px-5 py-4 text-sm">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.profile.name_label")}</span>
              <input autoFocus value={newName} onChange={(e) => setNewName(e.currentTarget.value)} className={inputClass} placeholder={copy("pswitch.profile.name_placeholder")} />
            </label>
            <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("pswitch.profile.hint")}</p>
          </div>
          <div className="flex justify-end gap-2 border-t border-oai-gray-100 px-5 py-3 dark:border-oai-gray-800">
            <button type="button" onClick={() => setCreating(false)} className="min-h-10 rounded-lg border border-oai-gray-200 px-3 font-medium hover:bg-oai-gray-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800">{copy("pswitch.action.cancel")}</button>
            <button type="button" disabled={busy || !newName.trim()} onClick={() => void createProfile()} className="min-h-10 rounded-lg bg-oai-black px-3 font-medium text-white hover:bg-oai-gray-800 disabled:opacity-50 dark:bg-white dark:text-oai-black dark:hover:bg-oai-gray-200">{copy("pswitch.profile.create")}</button>
          </div>
        </ModalFrame>
      ) : null}

      {applyTarget ? (
        <ConfirmModal
          open
          title={copy("pswitch.profile.apply_confirm_title")}
          description={copy("pswitch.profile.apply_confirm_desc", { name: applyTarget.name })}
          confirmLabel={copy("pswitch.profile.apply")}
          cancelLabel={copy("pswitch.action.cancel")}
          busy={busy}
          onConfirm={() => {
            const target = applyTarget;
            setApplyTarget(null);
            void applyProfile(target);
          }}
          onCancel={() => setApplyTarget(null)}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmModal
          open
          destructive
          title={copy("pswitch.profile.delete_confirm_title")}
          description={copy("pswitch.profile.delete_confirm_desc", { name: deleteTarget.name })}
          confirmLabel={copy("pswitch.action.delete")}
          cancelLabel={copy("pswitch.action.cancel")}
          busy={busy}
          onConfirm={() => void deleteProfile()}
          onCancel={() => setDeleteTarget(null)}
        />
      ) : null}

      {manageOpen ? (
        <ManageDialog
          open
          profiles={profiles}
          currentId={currentId}
          busy={busy}
          onClose={() => setManageOpen(false)}
          onRename={(id, name) => void renameProfile(id, name)}
          onDelete={(profile) => setDeleteTarget(profile)}
        />
      ) : null}
    </div>
  );
}
