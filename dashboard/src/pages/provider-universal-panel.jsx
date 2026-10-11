import React, { useCallback, useEffect, useState } from "react";
import { copy } from "../lib/copy";
import { universalProvidersApi } from "../lib/provider-switch-api";
import { Card, ConfirmModal } from "../ui/components";
import { ModalFrame } from "../ui/components/ModalFrame";

// ---------------------------------------------------------------------------
// Universal providers (cc-switch's 统一供应商, ported from
// UniversalProviderPanel/FormModal/Card): one shared base URL + API key that
// syncs into deterministic claude/codex/gemini child providers. Creation
// auto-syncs (upstream ffc22ea71); edits save until the user asks for
// save-and-sync; sync re-projects the live files of apps whose current
// provider is a generated child. Deliberate integration divergence: upstream
// nests the panel inside its add dialog, this fork renders it as its own
// section on the provider-switch page.
// ---------------------------------------------------------------------------

const UNIVERSAL_APPS = ["claude", "codex", "gemini"];

function appLabel(app) {
  if (app === "claude") return "Claude Code";
  if (app === "codex") return "Codex CLI";
  return "Gemini CLI";
}

const inputClass = "h-10 w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700";

function emptyDraft() {
  return {
    id: null,
    name: "",
    providerType: "newapi",
    apps: { claude: true, codex: true, gemini: true },
    baseUrl: "",
    apiKey: "",
    models: {
      claude: { model: "", haikuModel: "", sonnetModel: "", opusModel: "" },
      codex: { model: "", reasoningEffort: "high" },
      gemini: { model: "" },
    },
    websiteUrl: "",
    notes: "",
  };
}

function draftFromProvider(provider) {
  return {
    ...emptyDraft(),
    ...provider,
    apps: { claude: false, codex: false, gemini: false, ...(provider.apps || {}) },
    models: {
      claude: { model: "", haikuModel: "", sonnetModel: "", opusModel: "", ...(provider.models?.claude || {}) },
      codex: { model: "", reasoningEffort: "high", ...(provider.models?.codex || {}) },
      gemini: { model: "", ...(provider.models?.gemini || {}) },
    },
  };
}

// NewAPI-flavoured presets (upstream universalProviderPresets): a type picker
// seeds the form, everything stays editable afterwards.
const PRESET_TYPES = [
  {
    providerType: "newapi",
    models: {
      claude: { model: "claude-sonnet-5", haikuModel: "claude-haiku-4-5-20251001", sonnetModel: "claude-sonnet-5", opusModel: "claude-opus-5" },
      codex: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      gemini: { model: "gemini-3.6-flash" },
    },
  },
  { providerType: "custom_gateway", models: null },
  { providerType: "custom", models: null },
];

function UniversalFormModal({ draft, setDraft, saving, onClose, onSave, onSaveAndSync }) {
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const setModel = (app, key, value) =>
    setDraft((current) => ({ ...current, models: { ...current.models, [app]: { ...current.models[app], [key]: value } } }));
  const invalid = !draft.name.trim() || !draft.baseUrl.trim() || !draft.apiKey.trim();

  return (
    <ModalFrame open onClose={onClose} label={copy(draft.id ? "pswitch.universal.edit" : "pswitch.universal.add")}>
      <div className="flex items-center justify-between border-b border-oai-gray-100 px-5 py-3.5 dark:border-oai-gray-800">
        <h2 className="text-sm font-semibold">{copy(draft.id ? "pswitch.universal.edit" : "pswitch.universal.add")}</h2>
        <button type="button" onClick={onClose} aria-label={copy("pswitch.action.close")} className="rounded-lg p-1.5 text-oai-gray-500 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800">
          <span aria-hidden="true" className="text-base leading-none">×</span>
        </button>
      </div>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto px-5 py-4 text-sm">
        {!draft.id ? (
          <label className="block space-y-1">
            <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.universal.select_preset")}</span>
            <select
              value={draft.providerType}
              onChange={(event) => {
                const preset = PRESET_TYPES.find((p) => p.providerType === event.currentTarget.value) || PRESET_TYPES[0];
                setDraft((current) => ({ ...current, providerType: preset.providerType, models: preset.models || current.models }));
              }}
              className={inputClass}
            >
              {PRESET_TYPES.map((preset) => (
                <option key={preset.providerType} value={preset.providerType}>{preset.providerType}</option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="block space-y-1">
          <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.provider.name")}</span>
          <input value={draft.name} onChange={(e) => set("name", e.currentTarget.value)} className={inputClass} placeholder={copy("pswitch.universal.name_placeholder")} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.universal.base_url")}</span>
          <input value={draft.baseUrl} onChange={(e) => set("baseUrl", e.currentTarget.value)} className={inputClass} placeholder="https://gw.example.com" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.universal.api_key")}</span>
          <input value={draft.apiKey} onChange={(e) => set("apiKey", e.currentTarget.value)} className={inputClass} placeholder="sk-…" />
        </label>
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.universal.enabled_apps")}</legend>
          {UNIVERSAL_APPS.map((app) => (
            <label key={app} className="flex min-h-8 items-center gap-2">
              <input
                type="checkbox"
                checked={draft.apps[app]}
                onChange={(event) => setDraft((current) => ({ ...current, apps: { ...current.apps, [app]: event.currentTarget.checked } }))}
                className="h-4 w-4 accent-oai-brand-600"
              />
              {appLabel(app)}
            </label>
          ))}
        </fieldset>
        <div className="space-y-2 rounded-lg border border-oai-gray-100 p-3 dark:border-oai-gray-800">
          <p className="text-xs font-semibold">{copy("pswitch.universal.model_config")}</p>
          {draft.apps.claude ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.universal.model")}</span>
                <input value={draft.models.claude.model} onChange={(e) => setModel("claude", "model", e.currentTarget.value)} className={inputClass} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.role.haiku")}</span>
                <input value={draft.models.claude.haikuModel} onChange={(e) => setModel("claude", "haikuModel", e.currentTarget.value)} className={inputClass} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.role.sonnet")}</span>
                <input value={draft.models.claude.sonnetModel} onChange={(e) => setModel("claude", "sonnetModel", e.currentTarget.value)} className={inputClass} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.role.opus")}</span>
                <input value={draft.models.claude.opusModel} onChange={(e) => setModel("claude", "opusModel", e.currentTarget.value)} className={inputClass} />
              </label>
            </div>
          ) : null}
          {draft.apps.codex ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.universal.model")}</span>
                <input value={draft.models.codex.model} onChange={(e) => setModel("codex", "model", e.currentTarget.value)} className={inputClass} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.universal.reasoning_effort")}</span>
                <input value={draft.models.codex.reasoningEffort} onChange={(e) => setModel("codex", "reasoningEffort", e.currentTarget.value)} className={inputClass} />
              </label>
            </div>
          ) : null}
          {draft.apps.gemini ? (
            <label className="block space-y-1">
              <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.universal.model")}</span>
              <input value={draft.models.gemini.model} onChange={(e) => setModel("gemini", "model", e.currentTarget.value)} className={inputClass} />
            </label>
          ) : null}
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.provider.website_url")}</span>
          <input value={draft.websiteUrl} onChange={(e) => set("websiteUrl", e.currentTarget.value)} className={inputClass} placeholder="https://example.com" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.provider.notes")}</span>
          <input value={draft.notes} onChange={(e) => set("notes", e.currentTarget.value)} className={inputClass} placeholder={copy("pswitch.provider.notes_placeholder")} />
        </label>
        <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("pswitch.universal.form_hint")}</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-oai-gray-100 px-5 py-3 dark:border-oai-gray-800">
        <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-oai-gray-200 px-3 font-medium hover:bg-oai-gray-50 sm:min-h-0 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800">{copy("pswitch.action.cancel")}</button>
        {draft.id ? (
          <button type="button" onClick={onSaveAndSync} disabled={saving || invalid} className="min-h-10 rounded-lg border border-oai-gray-200 px-3 font-medium hover:bg-oai-gray-50 disabled:opacity-50 sm:min-h-0 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800">{copy("pswitch.universal.save_and_sync")}</button>
        ) : null}
        <button type="button" onClick={onSave} disabled={saving || invalid} className="min-h-10 rounded-lg bg-oai-black px-3 font-medium text-white hover:bg-oai-gray-800 disabled:opacity-50 sm:min-h-0 dark:bg-white dark:text-oai-black dark:hover:bg-oai-gray-200">{copy("pswitch.action.save")}</button>
      </div>
    </ModalFrame>
  );
}

export function ProviderUniversalPanel({ onNotice, onChanged }) {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [syncTarget, setSyncTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await universalProvidersApi.list();
      setProviders(res.providers);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [onNotice]);

  useEffect(() => {
    void load();
  }, [load]);

  const syncProvider = useCallback(async (id) => {
    try {
      const res = await universalProvidersApi.sync(id);
      if (!res.ok) throw new Error("sync failed");
      onNotice?.(copy("pswitch.universal.synced"));
      await load();
      await onChanged?.();
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : String(error));
    }
  }, [load, onChanged, onNotice]);

  const saveDraft = useCallback(async (alsoSync) => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const payload = {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        providerType: draft.providerType,
        apps: draft.apps,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
        models: draft.models,
        websiteUrl: draft.websiteUrl,
        notes: draft.notes,
      };
      const res = await universalProvidersApi.upsert(payload);
      // Upstream interaction: creation auto-syncs; edits sync only on request.
      // A failed post-save sync must not read as a failed add (upstream PR
      // #2811): the provider is already persisted, so the dialog still closes
      // and the sync failure surfaces as a partial-failure notice.
      if (!draft.id || alsoSync) {
        try {
          await universalProvidersApi.sync(res.provider.id);
          onNotice?.(copy(draft.id ? "pswitch.universal.saved_and_synced" : "pswitch.universal.added_and_synced"));
        } catch (error) {
          onNotice?.(`${copy("pswitch.universal.added_but_sync_failed")}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        onNotice?.(copy("pswitch.universal.saved"));
      }
      setDraft(null);
      await load();
      await onChanged?.();
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [draft, load, onChanged, onNotice, saving]);

  const deleteProvider = useCallback(async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await universalProvidersApi.remove(deleteTarget.id);
      onNotice?.(copy("pswitch.universal.deleted"));
      setDeleteTarget(null);
      await load();
      await onChanged?.();
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [deleteTarget, load, onChanged, onNotice, saving]);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{copy("pswitch.universal.title")}</p>
          <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.universal.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => setDraft(emptyDraft())}
          className="min-h-10 rounded-lg bg-oai-black px-3 text-sm font-medium text-white hover:bg-oai-gray-800 sm:min-h-0 dark:bg-white dark:text-oai-black dark:hover:bg-oai-gray-200"
        >
          {copy("pswitch.universal.add")}
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {loading ? (
          <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.universal.loading")}</p>
        ) : (
          <>
            {providers.length === 0 ? (
              <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.universal.empty")}</p>
            ) : null}
            {providers.length > 0 ? providers.map((provider) => (
              <div key={provider.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-oai-gray-100 px-4 py-3 dark:border-oai-gray-800">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {provider.name}
                    <span className="ml-2 text-xs font-normal text-oai-gray-400">{provider.providerType}</span>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-oai-gray-500 dark:text-oai-gray-400">{provider.baseUrl}</p>
                  <p className="mt-0.5 text-xs text-oai-gray-400 dark:text-oai-gray-500">
                    {UNIVERSAL_APPS.filter((app) => provider.apps?.[app]).map(appLabel).join(" · ") || copy("pswitch.universal.no_apps")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setSyncTarget(provider)} className="min-h-9 rounded-lg border border-oai-gray-200 px-3 text-xs font-medium hover:bg-oai-gray-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800">
                    {copy("pswitch.universal.sync")}
                  </button>
                  <button type="button" onClick={() => setDraft(draftFromProvider(provider))} className="min-h-9 rounded-lg border border-oai-gray-200 px-3 text-xs font-medium hover:bg-oai-gray-50 dark:border-oai-gray-700 dark:hover:bg-oai-gray-800">
                    {copy("pswitch.action.edit")}
                  </button>
                  <button type="button" onClick={() => setDeleteTarget(provider)} className="min-h-9 rounded-lg border border-red-200 px-3 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950">
                    {copy("pswitch.action.delete")}
                  </button>
                </div>
              </div>
            )) : null}
          </>
        )}
      </div>

      {draft ? (
        <UniversalFormModal
          draft={draft}
          setDraft={setDraft}
          saving={saving}
          onClose={() => setDraft(null)}
          onSave={() => void saveDraft(false)}
          onSaveAndSync={() => void saveDraft(true)}
        />
      ) : null}

      {syncTarget ? (
        <ConfirmModal
          open
          title={copy("pswitch.universal.sync_confirm_title")}
          description={copy("pswitch.universal.sync_confirm_desc", { name: syncTarget.name })}
          confirmLabel={copy("pswitch.universal.sync")}
          cancelLabel={copy("pswitch.action.cancel")}
          busy={saving}
          onConfirm={() => {
            const target = syncTarget;
            setSyncTarget(null);
            void syncProvider(target.id);
          }}
          onCancel={() => setSyncTarget(null)}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmModal
          open
          destructive
          title={copy("pswitch.universal.delete_confirm_title")}
          description={copy("pswitch.universal.delete_confirm_desc", { name: deleteTarget.name })}
          confirmLabel={copy("pswitch.action.delete")}
          cancelLabel={copy("pswitch.action.cancel")}
          busy={saving}
          onConfirm={() => void deleteProvider()}
          onCancel={() => setDeleteTarget(null)}
        />
      ) : null}
    </Card>
  );
}
