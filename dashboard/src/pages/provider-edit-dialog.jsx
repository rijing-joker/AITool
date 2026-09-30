import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Sparkles, Terminal, Gem, Shuffle, Boxes, ChevronDown, ChevronUp, X } from "lucide-react";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { Button } from "../ui/components";

// Add/edit provider dialog — an interaction port of cc-switch's
// AddProviderDialog / EditProviderDialog: preset cards on top (add mode),
// a structured per-preset form written into the settingsConfig template at
// dotted paths, an optional raw JSON editor for everything the form doesn't
// cover, and — when editing the currently-active provider — initial values
// read back from the live config files (read_live_provider_settings).

const PRESET_ICONS = { sparkles: Sparkles, terminal: Terminal, gem: Gem, shuffle: Shuffle };
const FALLBACK_ICON = Boxes;

const AVATAR_COLORS = {
  orange: "bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400",
  blue: "bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400",
  green: "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
  sky: "bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-400",
  gray: "bg-oai-gray-100 text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-300",
};

export function presetAvatarClass(color) {
  return AVATAR_COLORS[color] || AVATAR_COLORS.gray;
}

export function PresetIcon({ icon, color, className = "h-4 w-4" }) {
  const Icon = PRESET_ICONS[icon] || FALLBACK_ICON;
  return <Icon className={className} />;
}

function getPath(obj, dottedPath) {
  let current = obj;
  for (const key of dottedPath.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function setPath(obj, dottedPath, value) {
  const keys = dottedPath.split(".");
  const clone = JSON.parse(JSON.stringify(obj ?? {}));
  let current = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] == null || typeof current[keys[i]] !== "object") {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
  return clone;
}

function Collapsible({ open, children }) {
  if (!open) return null;
  return children;
}

export function ProviderEditDialog({
  open,
  busy,
  app,
  appState,
  presets,
  editing,
  onClose,
  onSaved,
  onError,
}) {
  const [selectedPresetId, setSelectedPresetId] = useState(null);
  const [draft, setDraft] = useState({});
  const [name, setName] = useState("");
  const [category, setCategory] = useState("custom");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [claudeApiKeyName, setClaudeApiKeyName] = useState("ANTHROPIC_AUTH_TOKEN");
  const [rawOpen, setRawOpen] = useState(false);
  const [rawText, setRawText] = useState("");
  const [error, setError] = useState(null);
  const [fromLive, setFromLive] = useState(false);
  const [loading, setLoading] = useState(false);

  const isEdit = !!editing;

  // Field set for the current selection: add mode = selected preset's fields;
  // edit mode = the app's default (custom) field set, since stored providers
  // don't remember which preset they came from.
  const fields = useMemo(() => {
    if (isEdit) {
      const custom = presets.find((preset) => preset.category === "custom");
      return custom ? custom.formFields : [];
    }
    const preset = presets.find((p) => p.id === selectedPresetId);
    return preset ? preset.formFields : [];
  }, [isEdit, presets, selectedPresetId]);

  const applyPreset = useCallback(
    (preset) => {
      setSelectedPresetId(preset.id);
      setDraft(JSON.parse(JSON.stringify(preset.settingsConfig ?? {})));
      setCategory(preset.category);
      if (!name.trim()) {
        setName(preset.nameKey ? copy(preset.nameKey) : preset.name);
      }
      setError(null);
    },
    [name],
  );

  // Initialize each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setRawOpen(false);
    setRawText("");
    setClaudeApiKeyName("ANTHROPIC_AUTH_TOKEN");
    setFromLive(false);
    if (editing) {
      setName(editing.name);
      setCategory(editing.category);
      setWebsiteUrl(editing.websiteUrl || "");
      setNotes(editing.notes || "");
      setDraft(JSON.parse(JSON.stringify(editing.settingsConfig ?? {})));
      if (app === "claude" && editing.settingsConfig?.env) {
        if ("ANTHROPIC_API_KEY" in editing.settingsConfig.env) setClaudeApiKeyName("ANTHROPIC_API_KEY");
      }
      // cc-switch's read_live_provider_settings: editing the current provider
      // starts from what is actually in the live files.
      if (appState?.current === editing.id) {
        setLoading(true);
        providerSwitchApi
          .getEditorView(app, editing.id)
          .then((view) => {
            setDraft(JSON.parse(JSON.stringify(view.settingsConfig ?? {})));
            setFromLive(!!view.fromLive);
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setLoading(false));
      }
    } else {
      setName("");
      setCategory("custom");
      setWebsiteUrl("");
      setNotes("");
      const first = presets[0] || null;
      setSelectedPresetId(first ? first.id : null);
      setDraft(first ? JSON.parse(JSON.stringify(first.settingsConfig ?? {})) : {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, app, appState?.current]);

  const fieldValue = (field) => {
    if (app === "claude" && field.id === "api_key") {
      return getPath(draft, `env.${claudeApiKeyName}`) ?? "";
    }
    return getPath(draft, field.path) ?? "";
  };

  const setFieldValue = (field, value) => {
    if (app === "claude" && field.id === "api_key") {
      setDraft((current) => {
        // The API key may live under either credential env name; keep the
        // value when the user flips the key-name select.
        const env = { ...(current.env || {}) };
        for (const keyName of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
          if (keyName !== claudeApiKeyName) delete env[keyName];
        }
        env[claudeApiKeyName] = value;
        return { ...current, env };
      });
      return;
    }
    setDraft((current) => setPath(current, field.path, value));
  };

  const switchClaudeApiKeyName = (keyName) => {
    const previous = claudeApiKeyName;
    setClaudeApiKeyName(keyName);
    if (keyName === previous) return;
    setDraft((current) => {
      const env = { ...(current.env || {}) };
      if (previous in env) {
        env[keyName] = env[previous];
        delete env[previous];
      }
      return { ...current, env };
    });
  };

  const syncRawText = () => setRawText(JSON.stringify(draft, null, 2));

  const openRaw = () => {
    syncRawText();
    setRawOpen(true);
  };

  const closeRaw = () => {
    try {
      const parsed = JSON.parse(rawText);
      setDraft(parsed);
      setRawOpen(false);
      setError(null);
    } catch (err) {
      setError(copy("pswitch.provider.invalid_json", { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const save = async () => {
    let payloadConfig = draft;
    if (rawOpen) {
      try {
        payloadConfig = JSON.parse(rawText);
      } catch (err) {
        setError(copy("pswitch.provider.invalid_json", { error: err instanceof Error ? err.message : String(err) }));
        return;
      }
    }
    try {
      if (isEdit) {
        const res = await providerSwitchApi.updateProvider(app, editing.id, {
          name,
          category,
          settingsConfig: payloadConfig,
          notes,
          websiteUrl,
        });
        onSaved(
          res.applied
            ? copy("pswitch.provider.applied_live", { name: res.provider.name })
            : copy("pswitch.provider.saved", { name: res.provider.name }),
        );
      } else {
        const res = await providerSwitchApi.createProvider(app, {
          name,
          category,
          settingsConfig: payloadConfig,
          notes,
          websiteUrl,
        });
        onSaved(copy("pswitch.provider.created", { name: res.provider.name }));
      }
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!open) return null;

  // Precomputed so the JSX below has no ternary chains after closing tags
  // (the ui-hardcode JSX text scan would otherwise see them as raw text).
  const showPresetGrid = !isEdit && presets.length !== 0;
  const showNoFieldsHint = !isEdit && fields.length === 0 && !!selectedPresetId;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]">
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:ring-oai-gray-800"
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? copy("pswitch.provider.dialog.edit_title") : copy("pswitch.provider.dialog.add_title")}
      >
        <div className="flex items-start justify-between gap-3 border-b border-oai-gray-100 px-5 py-4 dark:border-oai-gray-800">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-oai-black dark:text-white">
              {isEdit ? copy("pswitch.provider.dialog.edit_title") : copy("pswitch.provider.dialog.add_title")}
            </h2>
            <p className="mt-0.5 truncate text-sm text-oai-gray-500 dark:text-oai-gray-400">
              {copy("pswitch.provider.config_hint")}
            </p>
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

        <div className="space-y-5 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="text-sm text-oai-gray-400 dark:text-oai-gray-500">{copy("pswitch.provider.loading_live")}</p>
          ) : null}
          {fromLive ? (
            <div className="rounded-lg border border-oai-amber-dark/30 bg-oai-amber-50 px-3 py-2 text-xs text-oai-amber-dark dark:border-oai-amber-dark/40 dark:bg-oai-amber-dark/15 dark:text-oai-amber-light">
              {copy("pswitch.provider.live_prefill_hint")}
            </div>
          ) : null}

          {showPresetGrid ? (
            <div>
              <label className="mb-2 block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">
                {copy("pswitch.provider.preset")}
              </label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {presets.map((preset) => {
                  const selected = selectedPresetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applyPreset(preset)}
                      className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                        selected
                          ? "border-oai-brand-500 bg-oai-brand-50/60 dark:bg-oai-brand-950/30"
                          : "border-oai-gray-200 hover:border-oai-gray-300 dark:border-oai-gray-800 dark:hover:border-oai-gray-700"
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${presetAvatarClass(preset.color)}`}
                      >
                        <PresetIcon icon={preset.icon} color={preset.color} />
                      </span>
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium text-oai-black dark:text-white">
                            {preset.nameKey ? copy(preset.nameKey) : preset.name}
                          </span>
                          <span className="rounded-full bg-oai-gray-100 px-1.5 py-0.5 text-[10px] text-oai-gray-500 dark:bg-oai-gray-800 dark:text-oai-gray-400">
                            {preset.category === "official"
                              ? copy("pswitch.provider.category.official")
                              : copy("pswitch.provider.category.custom")}
                          </span>
                        </span>
                        {preset.hintKey ? (
                          <span className="mt-0.5 block text-xs leading-4 text-oai-gray-500 dark:text-oai-gray-400">
                            {copy(preset.hintKey)}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {fields.length ? (
            <div className="space-y-3">
              {fields.map((field) => (
                <div key={field.id}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className="block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">
                      {copy(field.labelKey)}
                    </label>
                    {app === "claude" && field.id === "api_key" ? (
                      <select
                        value={claudeApiKeyName}
                        onChange={(event) => switchClaudeApiKeyName(event.target.value)}
                        aria-label={copy("pswitch.field.api_key_name")}
                        className="rounded-md border border-oai-gray-200 bg-white px-1.5 py-0.5 font-mono text-xs text-oai-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-300"
                      >
                        <option value="ANTHROPIC_AUTH_TOKEN">{copy("pswitch.field.auth_token_option")}</option>
                        <option value="ANTHROPIC_API_KEY">{copy("pswitch.field.api_key_option")}</option>
                      </select>
                    ) : null}
                  </div>
                  {field.type === "select" ? (
                    <select
                      value={String(fieldValue(field) ?? "")}
                      onChange={(event) => setFieldValue(field, event.target.value)}
                      aria-label={copy(field.labelKey)}
                      className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                    >
                      {(field.options || []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {copy(option.labelKey)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.secret ? "password" : "text"}
                      value={String(fieldValue(field))}
                      onChange={(event) => setFieldValue(field, event.target.value)}
                      placeholder={field.placeholder || ""}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={copy(field.labelKey)}
                      className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 font-mono text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                    />
                  )}
                  {field.hintKey ? (
                    <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy(field.hintKey)}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {showNoFieldsHint ? (
            <p className="rounded-lg bg-oai-gray-50 px-3 py-2 text-sm text-oai-gray-500 dark:bg-oai-gray-900 dark:text-oai-gray-400">
              {copy("pswitch.provider.preset_no_fields")}
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">
                {copy("pswitch.provider.name")}
              </label>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={copy("pswitch.provider.name_placeholder")}
                className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">
                {copy("pswitch.provider.website_url")}
              </label>
              <input
                type="url"
                value={websiteUrl}
                onChange={(event) => setWebsiteUrl(event.target.value)}
                placeholder="https://…"
                className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">
              {copy("pswitch.provider.notes")}
            </label>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              className="w-full resize-y rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
            />
          </div>

          <div>
            <button
              type="button"
              onClick={() => (rawOpen ? closeRaw() : openRaw())}
              className="inline-flex items-center gap-1 text-sm font-medium text-oai-gray-500 transition-colors hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-white"
            >
              {rawOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {copy("pswitch.provider.raw_json")}
            </button>
            <Collapsible open={rawOpen}>
              <textarea
                value={rawText}
                onChange={(event) => setRawText(event.target.value)}
                spellCheck={false}
                rows={10}
                aria-label={copy("pswitch.provider.config")}
                className="mt-2 w-full resize-y rounded-lg border border-oai-gray-200 bg-oai-gray-50 p-3 font-mono text-xs text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:text-oai-gray-100"
              />
            </Collapsible>
          </div>

          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-oai-gray-100 px-5 py-3 dark:border-oai-gray-800">
          {isEdit && editing?.websiteUrl ? (
            <a
              href={editing.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-1 text-xs text-oai-gray-400 hover:text-oai-brand-600 dark:text-oai-gray-500 dark:hover:text-oai-brand-400"
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{editing.websiteUrl}</span>
            </a>
          ) : (
            <span />
          )}
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
              {copy("pswitch.action.cancel")}
            </Button>
            <Button size="sm" disabled={busy || loading || !name.trim()} onClick={() => void save()}>
              {copy("pswitch.action.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ProviderEditDialog;
