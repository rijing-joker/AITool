import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, ExternalLink, Eye, EyeOff, Wand2, X } from "lucide-react";
import { copy } from "../lib/copy";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { Button } from "../ui/components";
import { showToast } from "../ui/components/Toast";
import { EndpointSpeedTestDialog } from "./provider-speed-test";
import { ProviderIconPicker, iconComponentFor } from "./provider-icon-picker";
import { CodexCatalogEditor } from "./provider-codex-catalog";
import { ModelDropdown, ModelInputAction } from "./provider-model-dropdown";

// Add/edit provider dialog — an interaction port of cc-switch's
// AddProviderDialog / EditProviderDialog / ProviderForm: preset cards with
// search (add mode), structured per-preset fields written into the
// settingsConfig template at dotted paths, per-app advanced sections
// (endpoint speed test, full-URL switch, claude model mapping with 1M flags
// and one-click fill, model list fetching, apiFormat, custom User-Agent,
// request overrides), the always-visible config-file JSON editor with quick
// toggles + format above the action buttons (cc-switch's CommonConfigEditor),
// an icon picker, and soft validation before save. When editing the
// currently-active provider the initial values are read back from the live
// config files (read_live_provider_settings).

const AVATAR_COLORS = {
  orange: "bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400",
  blue: "bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400",
  green: "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
  sky: "bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-400",
  violet: "bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400",
  indigo: "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400",
  rose: "bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400",
  amber: "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
  teal: "bg-teal-100 text-teal-600 dark:bg-teal-500/15 dark:text-teal-400",
  gray: "bg-oai-gray-100 text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-300",
};

export function presetAvatarClass(color) {
  return AVATAR_COLORS[color] || AVATAR_COLORS.gray;
}

export function PresetIcon({ icon, color, className = "h-4 w-4" }) {
  const Icon = iconComponentFor(icon) || iconComponentFor("boxes");
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

function deletePath(obj, dottedPath) {
  const keys = dottedPath.split(".");
  const clone = JSON.parse(JSON.stringify(obj ?? {}));
  let current = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current == null || typeof current[keys[i]] !== "object") return clone;
    current = current[keys[i]];
  }
  delete current[keys[keys.length - 1]];
  return clone;
}

// ---------------------------------------------------------------------------
// Claude model roles (cc-switch's modelRoleRows) — display name + request
// model + [1m] context flag per role; the subagent row has no display name.
// ---------------------------------------------------------------------------

const CLAUDE_MODEL_ROLES = [
  {
    key: "sonnet",
    labelKey: "pswitch.role.sonnet",
    namePath: "env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    modelPath: "env.ANTHROPIC_DEFAULT_SONNET_MODEL",
    supportsOneM: true,
  },
  {
    key: "opus",
    labelKey: "pswitch.role.opus",
    namePath: "env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    modelPath: "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
    supportsOneM: true,
  },
  {
    key: "fable",
    labelKey: "pswitch.role.fable",
    namePath: "env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    modelPath: "env.ANTHROPIC_DEFAULT_FABLE_MODEL",
    supportsOneM: true,
  },
  {
    key: "haiku",
    labelKey: "pswitch.role.haiku",
    namePath: "env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    modelPath: "env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
    supportsOneM: false,
  },
  {
    key: "subagent",
    labelKey: "pswitch.role.subagent",
    namePath: null,
    modelPath: "env.ANTHROPIC_DEFAULT_SUBAGENT_MODEL",
    supportsOneM: false,
  },
];

const DEFAULT_MODEL_PATH = { claude: "env.ANTHROPIC_MODEL", codex: "config.model", gemini: "env.GEMINI_MODEL" };
const ENDPOINT_PATH = {
  claude: "env.ANTHROPIC_BASE_URL",
  codex: "config.model_providers.custom.base_url",
  gemini: "env.GOOGLE_GEMINI_BASE_URL",
};
const API_KEY_PATH = { claude: null, codex: "auth.OPENAI_API_KEY", gemini: "env.GEMINI_API_KEY" };

function withoutOneM(value) {
  return String(value || "").replace(/\[1m\]$/, "");
}

// cc-switch's pickCodexApiKey: the row's key lives in auth.OPENAI_API_KEY,
// falling back to an experimental_bearer_token already present in the stored
// config (route table first, then top level — the Codex Mobile 兼容形态).
function codexBearerTokenOf(config) {
  if (!config || typeof config !== "object") return "";
  const providers = config.model_providers;
  const table = providers && typeof providers === "object" ? providers.custom : null;
  if (table && typeof table === "object") {
    const token = String(table.experimental_bearer_token ?? "").trim();
    if (token) return token;
  }
  return String(config.experimental_bearer_token ?? "").trim();
}

function codexApiKeyOf(draft) {
  const authKey = String(getPath(draft, "auth.OPENAI_API_KEY") ?? "").trim();
  return authKey || codexBearerTokenOf(draft && draft.config);
}

// cc-switch's handleCodexApiKeyChange: the input always writes
// auth.OPENAI_API_KEY, and additionally updates an experimental_bearer_token
// that already exists in the stored config (route table / top level) — an
// empty value deletes it so the read fallback cannot resurrect the old token.
// Never adds a new bearer token: plain rows keep the key in auth and the
// switch projection injects it into the live route table.
function setCodexApiKeyInDraft(draft, value) {
  const auth = { ...(draft.auth || {}) };
  auth.OPENAI_API_KEY = value;
  let config = draft.config && typeof draft.config === "object" ? { ...draft.config } : {};
  const syncEntry = (holder, key) => {
    if (!holder || typeof holder !== "object" || !(key in holder)) return holder;
    const next = { ...holder };
    if (String(value).trim()) next[key] = value;
    else delete next[key];
    return next;
  };
  if (config.model_providers && typeof config.model_providers === "object" && config.model_providers.custom && typeof config.model_providers.custom === "object") {
    config = {
      ...config,
      model_providers: {
        ...config.model_providers,
        custom: syncEntry(config.model_providers.custom, "experimental_bearer_token"),
      },
    };
  }
  config = syncEntry(config, "experimental_bearer_token");
  return { ...draft, auth, config };
}

// ---------------------------------------------------------------------------
// Shared small controls
// ---------------------------------------------------------------------------

function FieldLabel({ label, required, children }) {
  return (
    <div className="mb-1 flex items-center justify-between gap-2">
      <label className="block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>
      {children}
    </div>
  );
}

function SecretInput({ value, onChange, placeholder, ariaLabel }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        value={String(value ?? "")}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder || ""}
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 pr-9 font-mono text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
      />
      {String(value ?? "") ? (
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-oai-gray-400 hover:text-oai-black dark:hover:text-white"
          aria-label={visible ? copy("pswitch.field.hide_key") : copy("pswitch.field.show_key")}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      ) : null}
    </div>
  );
}

function EndpointField({ label, value, onChange, isFullUrl, onFullUrlChange, onManage, hint }) {
  return (
    <div>
      <FieldLabel label={label}>
        {onFullUrlChange ? (
          <button
            type="button"
            onClick={() => onFullUrlChange(!isFullUrl)}
            className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
              isFullUrl
                ? "border-oai-brand-500 bg-oai-brand-50 text-oai-brand-600 dark:bg-oai-brand-950/40 dark:text-oai-brand-400"
                : "border-oai-gray-200 text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400"
            }`}
            aria-pressed={!!isFullUrl}
          >
            {copy("pswitch.field.full_url")}
          </button>
        ) : null}
        {onManage ? (
          <button
            type="button"
            onClick={onManage}
            className="text-xs font-medium text-oai-brand-600 hover:underline dark:text-oai-brand-400"
          >
            {copy("pswitch.speed.manage")}
          </button>
        ) : null}
      </FieldLabel>
      <input
        type="text"
        value={String(value ?? "")}
        onChange={(event) => onChange(event.target.value)}
        placeholder="https://your-api-endpoint.com"
        spellCheck={false}
        aria-label={label}
        className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 font-mono text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
      />
      {hint ? (
        <div className="mt-2 rounded-lg border border-oai-amber-dark/30 bg-oai-amber-50 px-3 py-2 dark:border-oai-amber-dark/40 dark:bg-oai-amber-dark/15">
          <p className="text-xs text-oai-amber-dark dark:text-oai-amber-light">{hint}</p>
        </div>
      ) : null}
    </div>
  );
}

function ModelInput({ label, value, onChange, models, fetchState, onFetch, placeholder, hint }) {
  return (
    <div>
      <FieldLabel label={label} />
      <div className="flex gap-1">
        <input
          type="text"
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder || ""}
          spellCheck={false}
          aria-label={label}
          className="w-full min-w-0 rounded-lg border border-oai-gray-200 bg-white px-3 py-2 font-mono text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
        />
        <ModelInputAction
          models={models}
          fetchState={fetchState}
          onFetch={onFetch}
          onSelect={onChange}
        />
      </div>
      {hint ? <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">{hint}</p> : null}
    </div>
  );
}

function JsonTextarea({ value, onChange, rows = 8, error, label }) {
  const ref = useRef(null);
  // Embedded webviews can drop React's synthetic onChange for textareas while
  // still delivering real input events; this native listener keeps the commit
  // path alive there. Running alongside React's onChange is idempotent.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const forward = () => onChange(node.value);
    node.addEventListener("input", forward);
    return () => node.removeEventListener("input", forward);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChange]);
  return (
    <div>
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        rows={rows}
        aria-label={label}
        className={`w-full resize-y rounded-lg border bg-oai-gray-50 p-3 font-mono text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:bg-oai-gray-950 ${
          error
            ? "border-red-400 text-oai-black dark:text-oai-gray-100"
            : "border-oai-gray-200 text-oai-black dark:border-oai-gray-800 dark:text-oai-gray-100"
        }`}
      />
      {error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

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
  const [presetQuery, setPresetQuery] = useState("");
  const [sortAZ, setSortAZ] = useState(false);
  const [draft, setDraft] = useState({});
  const [meta, setMeta] = useState({});
  const [icon, setIcon] = useState("");
  const [iconColor, setIconColor] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("custom");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [claudeApiKeyName, setClaudeApiKeyName] = useState("ANTHROPIC_AUTH_TOKEN");
  const [rawText, setRawText] = useState("");
  const [rawError, setRawError] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState(null);
  const [fromLive, setFromLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [speedTestOpen, setSpeedTestOpen] = useState(false);
  const [fetchedModels, setFetchedModels] = useState(null);
  const [fetchState, setFetchState] = useState("idle");
  const [pendingIssues, setPendingIssues] = useState(null);

  const isEdit = !!editing;
  const selectedPreset = useMemo(() => {
    return presets.find((preset) => preset.id === selectedPresetId) || null;
  }, [presets, selectedPresetId]);

  // Structured fields for the current selection (add mode) or the app's
  // default field set (edit mode — stored providers don't remember their
  // preset origin).
  const fields = useMemo(() => {
    if (isEdit) {
      const custom = presets.find((preset) => preset.group === "custom");
      return custom ? custom.formFields : [];
    }
    return selectedPreset ? selectedPreset.formFields : [];
  }, [isEdit, presets, selectedPresetId]);

  const currentEndpoint = String(getPath(draft, ENDPOINT_PATH[app]) ?? "");
  const currentApiKey =
    app === "claude"
      ? String(getPath(draft, `env.${claudeApiKeyName}`) ?? "")
      : app === "codex"
        ? codexApiKeyOf(draft)
        : String(getPath(draft, API_KEY_PATH[app]) ?? "");

  const endpointCandidates = useMemo(() => {
    const list = [...(selectedPreset?.endpointCandidates || []), ...(meta.customEndpoints || [])];
    if (editing) {
      const fromConfig = String(getPath(editing.settingsConfig, ENDPOINT_PATH[app]) ?? "").replace(/\/+$/, "");
      if (fromConfig && !list.includes(fromConfig)) list.unshift(fromConfig);
    }
    return [...new Set(list.filter(Boolean))];
  }, [selectedPreset, meta.customEndpoints, editing, app]);

  const applyPreset = useCallback((preset) => {
    // cc-switch's handlePresetChange: picking a preset resets the basic
    // fields to the preset's values, not only the config template.
    setSelectedPresetId(preset.id);
    setDraft(JSON.parse(JSON.stringify(preset.settingsConfig ?? {})));
    setCategory(preset.group === "official" ? "official" : "custom");
    setName(preset.nameKey ? copy(preset.nameKey) : preset.name);
    setWebsiteUrl(preset.websiteUrl || "");
    setIcon(preset.icon || "");
    setIconColor(preset.color || "");
    setError(null);
  }, []);

  // Initialize each time the dialog opens. rawText is intentionally not
  // touched here — the mirror effect below repopulates it from the new draft
  // (resetting it here would desync rawText from rawTextRef and leave the
  // editor blank).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setRawError(null);
    setPendingIssues(null);
    setFetchedModels(null);
    setFetchState("idle");
    setIconPickerOpen(false);
    setSpeedTestOpen(false);
    setFromLive(false);
    if (editing) {
      setName(editing.name);
      setCategory(editing.category);
      setWebsiteUrl(editing.websiteUrl || "");
      setNotes(editing.notes || "");
      setIcon(editing.icon || "");
      setIconColor(editing.iconColor || "");
      setMeta({ ...(editing.meta || {}) });
      setDraft(JSON.parse(JSON.stringify(editing.settingsConfig ?? {})));
      if (app === "claude" && editing.settingsConfig?.env) {
        if ("ANTHROPIC_API_KEY" in editing.settingsConfig.env) setClaudeApiKeyName("ANTHROPIC_API_KEY");
      }
      const editingMeta = editing.meta || {};
      if (app === "claude" && claudeHasAdvancedValues(editing.settingsConfig ?? {}, editingMeta)) {
        setAdvancedOpen(true);
      }
      if (app === "codex" && codexHasAdvancedValues(editingMeta)) {
        setAdvancedOpen(true);
      }
      // cc-switch's read_live_provider_settings: editing the current provider
      // starts from what is actually in the live files.
      if (appState?.current === editing.id) {
        setLoading(true);
        providerSwitchApi
          .getEditorView(app, editing.id)
          .then((view) => {
            const nextDraft = JSON.parse(JSON.stringify(view.settingsConfig ?? {}));
            setDraft(nextDraft);
            setFromLive(!!view.fromLive);
            if (app === "claude" && claudeHasAdvancedValues(nextDraft, editing.meta || {})) {
              setAdvancedOpen(true);
            }
            if (app === "codex" && codexHasAdvancedValues(editing.meta || {})) {
              setAdvancedOpen(true);
            }
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setLoading(false));
      }
    } else {
      setName("");
      setCategory("custom");
      setWebsiteUrl("");
      setNotes("");
      setIcon("");
      setIconColor("");
      setMeta({});
      setPresetQuery("");
      // cc-switch opens the add dialog on the Custom template, not the first
      // preset card.
      const first = presets.find((preset) => preset.group === "custom") || presets[0] || null;
      setSelectedPresetId(first ? first.id : null);
      setDraft(first ? JSON.parse(JSON.stringify(first.settingsConfig ?? {})) : {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, app, appState?.current]);

  // Advanced section auto-expands when it already carries values (cc-switch's
  // hasAnyAdvancedValue). Computed from the config being loaded, not the
  // (stale) draft state.
  const codexHasAdvancedValues = (metaObject) => {
    const rows = metaObject && metaObject.codexCatalogModels;
    return (
      !!metaObject.customUserAgent ||
      !!metaObject.localProxyRequestOverrides ||
      (Array.isArray(rows) && rows.length > 0)
    );
  };
  const claudeHasAdvancedValues = (config, metaObject) => {
    const env = config && config.env && typeof config.env === "object" ? config.env : {};
    const hasMapping = CLAUDE_MODEL_ROLES.some((role) => {
      const keys = role.modelPath.split(".");
      let current = config;
      for (const key of keys) {
        if (current == null || typeof current !== "object") return false;
        current = current[key];
      }
      return current != null && current !== "";
    });
    return (
      hasMapping ||
      (metaObject.apiFormat && metaObject.apiFormat !== "anthropic") ||
      !!metaObject.customUserAgent ||
      !!metaObject.localProxyRequestOverrides ||
      Object.keys(env).some((key) => key.startsWith("ANTHROPIC_DEFAULT_"))
    );
  };

  const setMetaValue = (key, value) =>
    setMeta((current) => ({ ...current, [key]: value === undefined || value === "" || value === false ? undefined : value }));

  const setFieldValue = (field, value) => {
    if (app === "claude" && field.id === "api_key") {
      setDraft((current) => {
        const env = { ...(current.env || {}) };
        for (const keyName of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
          if (keyName !== claudeApiKeyName) delete env[keyName];
        }
        env[claudeApiKeyName] = value;
        return { ...current, env };
      });
      return;
    }
    if (app === "codex" && field.id === "api_key") {
      setDraft((current) => setCodexApiKeyInDraft(current, value));
      return;
    }
    setDraft((current) => setPath(current, field.path, value));
  };

  const switchClaudeApiKeyName = (keyName) => {
    const previous = claudeApiKeyName;
    setClaudeApiKeyName(keyName);
    if (keyName === previous) return;
    setMetaValue("apiKeyField", keyName === "ANTHROPIC_API_KEY" ? "ANTHROPIC_API_KEY" : undefined);
    setDraft((current) => {
      const env = { ...(current.env || {}) };
      if (previous in env) {
        env[keyName] = env[previous];
        delete env[previous];
      }
      return { ...current, env };
    });
  };

  // --- model list fetching (cc-switch's fetchModelsForConfig) ---
  const fetchModels = useCallback(async () => {
    if (fetchState === "loading") return;
    setFetchState("loading");
    try {
      const res = await providerSwitchApi.fetchModels({
        baseUrl: currentEndpoint,
        apiKey: currentApiKey,
        modelsUrl: selectedPreset?.modelsUrl,
        isFullUrl: !!meta.isFullUrl,
      });
      setFetchedModels(res.models);
      setFetchState("done");
      if (res.models.length > 0) {
        showToast({ title: copy("pswitch.models.fetch_success", { count: res.models.length }) });
      } else {
        showToast({ title: copy("pswitch.models.fetch_empty") });
      }
    } catch (err) {
      setFetchState("idle");
      showToast({
        title: copy("pswitch.models.fetch_failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  }, [currentApiKey, currentEndpoint, fetchState, meta.isFullUrl, selectedPreset]);

  // --- claude model roles helpers ---
  const oneMOn = (role) => String(getPath(draft, role.modelPath) ?? "").endsWith("[1m]");
  const toggleOneM = (role, on) => {
    setDraft((current) => {
      const value = String(getPath(current, role.modelPath) ?? "").trim();
      if (!value) return current;
      const suffix = on ? "[1m]" : "";
      return setPath(current, role.modelPath, `${withoutOneM(value)}${suffix}`);
    });
  };
  const fillAllRoles = () => {
    setDraft((current) => {
      const candidates = [
        getPath(current, DEFAULT_MODEL_PATH.claude),
        ...CLAUDE_MODEL_ROLES.map((role) => getPath(current, role.modelPath)),
      ].map((value) => withoutOneM(String(value ?? "").trim()));
      const model = candidates.find(Boolean);
      if (!model) return current;
      let next = current;
      for (const role of CLAUDE_MODEL_ROLES) {
        next = setPath(next, role.modelPath, model);
      }
      return next;
    });
  };

  // --- endpoint speed test ---
  const openSpeedTest = () => setSpeedTestOpen(true);
  const closeSpeedTest = (picked, listChanged, list) => {
    setSpeedTestOpen(false);
    if (picked) {
      setDraft((current) => setPath(current, ENDPOINT_PATH[app], picked.url));
      if (picked.autoSelect) setMetaValue("endpointAutoSelect", true);
    }
    if (listChanged) {
      setMeta((current) => ({ ...current, customEndpoints: list }));
    }
  };

  // --- claude quick toggles over the config JSON (cc-switch's six checkboxes) ---
  const quickToggles = [
    {
      key: "attribution",
      labelKey: "pswitch.quick.hide_attribution",
      get: () => !!getPath(draft, "attribution"),
      set: (on) =>
        setDraft((current) => {
          if (!on) return deletePath(current, "attribution");
          return { ...current, attribution: { commit: "", pr: "", sessionUrl: false } };
        }),
    },
    {
      key: "teams",
      labelKey: "pswitch.quick.teams",
      get: () => getPath(draft, "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS") === "1",
      set: (on) =>
        setDraft((current) =>
          on
            ? setPath(current, "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1")
            : deletePath(current, "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"),
        ),
    },
    {
      key: "tool_search",
      labelKey: "pswitch.quick.tool_search",
      get: () => getPath(draft, "env.ENABLE_TOOL_SEARCH") === "true",
      set: (on) =>
        setDraft((current) =>
          on ? setPath(current, "env.ENABLE_TOOL_SEARCH", "true") : deletePath(current, "env.ENABLE_TOOL_SEARCH"),
        ),
    },
    {
      key: "effort",
      labelKey: "pswitch.quick.max_effort",
      get: () => getPath(draft, "env.CLAUDE_CODE_EFFORT_LEVEL") === "max",
      set: (on) =>
        setDraft((current) =>
          on ? setPath(current, "env.CLAUDE_CODE_EFFORT_LEVEL", "max") : deletePath(current, "env.CLAUDE_CODE_EFFORT_LEVEL"),
        ),
    },
    {
      key: "autoupdater",
      labelKey: "pswitch.quick.disable_autoupdater",
      get: () => getPath(draft, "env.DISABLE_AUTOUPDATER") === "1",
      set: (on) =>
        setDraft((current) =>
          on ? setPath(current, "env.DISABLE_AUTOUPDATER", "1") : deletePath(current, "env.DISABLE_AUTOUPDATER"),
        ),
    },
    {
      key: "artifact",
      labelKey: "pswitch.quick.disable_artifact",
      get: () => getPath(draft, "env.CLAUDE_CODE_DISABLE_ARTIFACT") === "1",
      set: (on) =>
        setDraft((current) =>
          on ? setPath(current, "env.CLAUDE_CODE_DISABLE_ARTIFACT", "1") : deletePath(current, "env.CLAUDE_CODE_DISABLE_ARTIFACT"),
        ),
    },
  ];

  // --- 配置文件 editor (cc-switch's CommonConfigEditor) ---
  // Two-way mirror between the form draft and the JSON text: form edits
  // re-serialize into the textarea, typed edits parse back into the draft
  // (and therefore the form) as soon as they are valid JSON. In-progress
  // invalid text stays in the textarea and is flagged via rawError.
  // rawTextRef mirrors rawText exactly (every writer updates both) so save()
  // can rely on it; the repopulate decision reads the rawText state itself.
  const rawTextRef = useRef("");
  const configInvalid = (err) =>
    copy("pswitch.provider.invalid_json", { error: err instanceof Error ? err.message : String(err) });
  useEffect(() => {
    let parsed = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
    if (JSON.stringify(parsed) !== JSON.stringify(draft ?? {})) {
      const next = JSON.stringify(draft ?? {}, null, 2);
      rawTextRef.current = next;
      setRawText(next);
      setRawError(null);
    }
    // rawText is read, not tracked: typed edits commit through
    // handleConfigTextChange and must not re-trigger repopulation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  const handleConfigTextChange = (text) => {
    rawTextRef.current = text;
    setRawText(text);
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("config must be a JSON object");
      setDraft(parsed);
      setRawError(null);
    } catch (err) {
      setRawError(configInvalid(err));
    }
  };
  const formatConfigText = () => {
    try {
      const next = JSON.stringify(JSON.parse(rawTextRef.current), null, 2);
      rawTextRef.current = next;
      setRawText(next);
      setRawError(null);
    } catch (err) {
      setRawError(configInvalid(err));
    }
  };

  // --- soft validation (cc-switch aggregates missing name/key/endpoint) ---
  const collectIssues = () => {
    const issues = [];
    if (!name.trim()) issues.push(copy("pswitch.validate.name"));
    if (!officialSelected && showEndpointField && !currentEndpoint.trim()) {
      issues.push(copy(`pswitch.validate.endpoint.${app}`));
    }
    if (!officialSelected && showApiKeyField && !currentApiKey.trim()) {
      issues.push(copy(`pswitch.validate.key.${app}`));
    }
    return issues;
  };

  const save = async (force) => {
    // The visible JSON text is the save source (cc-switch keeps the config
    // string in its form state the same way) — it mirrors the draft exactly
    // unless the user is mid-edit on invalid JSON, which blocks saving.
    let payloadConfig;
    try {
      payloadConfig = JSON.parse(rawTextRef.current);
    } catch (err) {
      setRawError(configInvalid(err));
      return;
    }
    if (!force) {
      const issues = collectIssues();
      if (issues.length) {
        setPendingIssues(issues);
        return;
      }
    }
    setPendingIssues(null);
    const cleanMeta = {};
    for (const [key, value] of Object.entries(meta)) {
      if (value !== undefined && value !== "" && value !== false) cleanMeta[key] = value;
    }
    try {
      const payload = {
        name,
        category,
        settingsConfig: payloadConfig,
        notes,
        websiteUrl,
        icon,
        iconColor,
        meta: cleanMeta,
      };
      if (isEdit) {
        const res = await providerSwitchApi.updateProvider(app, editing.id, payload);
        onSaved(
          res.applied
            ? copy("pswitch.provider.applied_live", { name: res.provider.name })
            : copy("pswitch.provider.saved", { name: res.provider.name }),
        );
      } else {
        const res = await providerSwitchApi.createProvider(app, payload);
        onSaved(copy("pswitch.provider.created", { name: res.provider.name }));
      }
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  // Preset grid: search + official → community → custom order, with an A→Z
  // toggle (cc-switch's ProviderPresetSelector).
  const presetGrid = useMemo(() => {
    const q = presetQuery.trim().toLowerCase();
    const displayName = (preset) => (preset.nameKey ? copy(preset.nameKey) : preset.name);
    let list = presets.filter((preset) => !q || displayName(preset).toLowerCase().includes(q));
    const rank = { official: 0, community: 1, custom: 2 };
    list = [...list].sort((a, b) => {
      if (sortAZ) return displayName(a).localeCompare(displayName(b));
      return (rank[a.group] ?? 3) - (rank[b.group] ?? 3);
    });
    return list;
  }, [presets, presetQuery, sortAZ]);

  if (!open) return null;

  // Precomputed so the JSX below has no ternary chains after closing tags
  // (the ui-hardcode JSX text scan would otherwise see them as raw text).
  const showPresetGrid = !isEdit && presets.length !== 0;
  const showNoFieldsHint = !isEdit && fields.length === 0 && !!selectedPresetId;
  // cc-switch gates the endpoint/model/key fields on the provider category:
  // official providers authenticate by their own login and never show them.
  const officialSelected = isEdit ? editing.category === "official" : !!selectedPreset && selectedPreset.group === "official";
  // Written as a loop: an arrow function here leaves a bare `>` in source
  // that the ui-hardcode JSX text scan reads as raw text.
  let showApiKeyField = false;
  for (const field of fields) {
    if (field.id === "api_key") showApiKeyField = true;
  }
  const showEndpointField = !officialSelected && (app === "claude" || app === "codex" || app === "gemini");
  const showAdvancedToggle = app === "claude" || app === "codex";
  const showQuickToggles = app === "claude";
  const apiKeyWebsite = selectedPreset?.websiteUrl || websiteUrl;
  const showApiKeyLink = !!apiKeyWebsite && selectedPreset?.group === "community";
  const endpointHint =
    app === "codex" ? copy("pswitch.field.codex_endpoint_hint") : app === "claude" ? copy("pswitch.field.endpoint_hint") : null;
  const avatarIconName = icon || (selectedPreset ? selectedPreset.icon : "") || "";
  // cc-switch renders the endpoint (and model) field for every non-official
  // preset even when the template pre-fills it — community presets carry
  // endpoints but no base_url field of their own.
  let hasBaseUrlField = false;
  let hasModelField = false;
  for (const field of fields) {
    if (field.id === "base_url") hasBaseUrlField = true;
    if (field.id === "model") hasModelField = true;
  }
  const showEndpointForEdit = isEdit && showEndpointField && !hasBaseUrlField;
  const showModelForEdit = isEdit && !hasModelField;
  const showEndpointForAdd = !isEdit && showEndpointField && !hasBaseUrlField;
  const showModelForAdd = !isEdit && !hasModelField;
  const claudeAdvancedOpen = advancedOpen && app === "claude";
  const codexAdvancedOpen = advancedOpen && app === "codex";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]">
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:ring-oai-gray-800"
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? copy("pswitch.provider.dialog.edit_title") : copy("pswitch.provider.dialog.add_title")}
      >
        <div className="flex items-start justify-between gap-3 border-b border-oai-gray-100 px-5 py-4 dark:border-oai-gray-800">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-oai-black dark:text-white">
              {isEdit ? copy("pswitch.provider.dialog.edit_title") : copy("pswitch.provider.dialog.add_title")}
            </h2>
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
              <div className="mb-2 flex items-center justify-between gap-2">
                <label className="block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">
                  {copy("pswitch.provider.preset")}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={presetQuery}
                    onChange={(event) => setPresetQuery(event.target.value)}
                    placeholder={copy("pswitch.preset.search")}
                    aria-label={copy("pswitch.preset.search")}
                    className="w-36 rounded-lg border border-oai-gray-200 bg-white px-2.5 py-1 text-xs text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                  />
                  <button
                    type="button"
                    onClick={() => setSortAZ((current) => !current)}
                    className="rounded-lg border border-oai-gray-200 px-2 py-1 text-xs text-oai-gray-500 transition-colors hover:text-oai-black dark:border-oai-gray-800 dark:text-oai-gray-400 dark:hover:text-white"
                    aria-pressed={sortAZ}
                  >
                    {sortAZ ? copy("pswitch.preset.sort_default") : copy("pswitch.preset.sort_az")}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {presetGrid.map((preset) => {
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
                            {copy(`pswitch.preset.badge.${preset.group}`)}
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

          {/* Basic info (cc-switch's BasicFormFields): centered icon picker,
              then name + notes, then website URL — always ahead of the
              credential fields. */}
          <div>
            <div className="mb-4 flex justify-center">
              <button
                type="button"
                onClick={() => setIconPickerOpen(true)}
                className={`flex h-20 w-20 items-center justify-center rounded-xl border-2 bg-oai-gray-50 transition-colors hover:border-oai-brand-500 dark:bg-oai-gray-900 ${
                  avatarIconName ? "border-oai-gray-200 dark:border-oai-gray-800" : "border-dashed border-oai-gray-300 dark:border-oai-gray-700"
                }`}
                title={icon ? copy("pswitch.icon.change") : copy("pswitch.icon.select")}
                aria-label={icon ? copy("pswitch.icon.change") : copy("pswitch.icon.select")}
              >
                {avatarIconName ? (
                  <PresetIcon icon={avatarIconName} color={iconColor} className="h-10 w-10" />
                ) : (
                  <span className={`text-xl font-semibold ${presetAvatarClass(iconColor)}`}>
                    {name.trim() ? name.trim().charAt(0).toUpperCase() : "P"}
                  </span>
                )}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <FieldLabel label={copy("pswitch.provider.name")} />
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={copy("pswitch.provider.name_placeholder")}
                  aria-label={copy("pswitch.provider.name")}
                  className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                />
              </div>
              <div>
                <FieldLabel label={copy("pswitch.provider.notes")} />
                <input
                  type="text"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder={copy("pswitch.provider.notes_placeholder")}
                  aria-label={copy("pswitch.provider.notes")}
                  className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                />
              </div>
            </div>
            <div className="mt-4">
              <FieldLabel label={copy("pswitch.provider.website_url")} />
              <input
                type="url"
                value={websiteUrl}
                onChange={(event) => setWebsiteUrl(event.target.value)}
                placeholder={copy("pswitch.provider.website_placeholder")}
                aria-label={copy("pswitch.provider.website_url")}
                className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
              />
            </div>
          </div>

          {fields.length ? (
            <div className="space-y-3">
              {fields.map((field) => {
                if (field.id === "api_key") {
                  return (
                    <div key={field.id}>
                      <FieldLabel label={copy(field.labelKey)}>
                        {app === "claude" ? (
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
                        {showApiKeyLink ? (
                          <a
                            href={apiKeyWebsite}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-oai-brand-600 hover:underline dark:text-oai-brand-400"
                          >
                            <ExternalLink className="h-3 w-3" />
                            {copy("pswitch.field.get_api_key")}
                          </a>
                        ) : null}
                      </FieldLabel>
                      <SecretInput
                        value={app === "codex" ? codexApiKeyOf(draft) : String(getPath(draft, field.path) ?? "")}
                        onChange={(value) => setFieldValue(field, value)}
                        placeholder={field.placeholderKey ? copy(field.placeholderKey) : field.placeholder}
                        ariaLabel={copy(field.labelKey)}
                      />
                      {field.hintKey ? (
                        <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy(field.hintKey)}</p>
                      ) : null}
                    </div>
                  );
                }
                if (field.id === "base_url") {
                  return (
                    <EndpointField
                      key={field.id}
                      label={copy("pswitch.field.endpoint")}
                      value={String(getPath(draft, field.path) ?? "")}
                      onChange={(value) => setDraft((current) => setPath(current, field.path, value))}
                      isFullUrl={!!meta.isFullUrl}
                      onFullUrlChange={(on) => setMetaValue("isFullUrl", on || undefined)}
                      onManage={openSpeedTest}
                      hint={endpointHint}
                    />
                  );
                }
                if (field.id === "model") {
                  return (
                    <ModelInput
                      key={field.id}
                      label={copy(field.labelKey)}
                      value={String(getPath(draft, field.path) ?? "")}
                      onChange={(value) => setDraft((current) => setPath(current, field.path, value))}
                      models={fetchedModels}
                      fetchState={fetchState}
                      onFetch={fetchModels}
                      hint={field.hintKey ? copy(field.hintKey) : null}
                    />
                  );
                }
                if (field.type === "select") {
                  return (
                    <div key={field.id}>
                      <FieldLabel label={copy(field.labelKey)} />
                      <select
                        value={String(getPath(draft, field.path) ?? "")}
                        onChange={(event) => setDraft((current) => setPath(current, field.path, event.target.value))}
                        aria-label={copy(field.labelKey)}
                        className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                      >
                        {(field.options || []).map((option) => (
                          <option key={option.value} value={option.value}>
                            {copy(option.labelKey)}
                          </option>
                        ))}
                      </select>
                      {field.hintKey ? (
                        <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy(field.hintKey)}</p>
                      ) : null}
                    </div>
                  );
                }
                return (
                  <div key={field.id}>
                    <FieldLabel label={copy(field.labelKey)} />
                    <input
                      type={field.secret ? "password" : "text"}
                      value={String(getPath(draft, field.path) ?? "")}
                      onChange={(event) => setDraft((current) => setPath(current, field.path, event.target.value))}
                      placeholder={field.placeholder || ""}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={copy(field.labelKey)}
                      className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 font-mono text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                    />
                    {field.hintKey ? (
                      <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy(field.hintKey)}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {showNoFieldsHint ? (
            <p className="rounded-lg bg-oai-gray-50 px-3 py-2 text-sm text-oai-gray-500 dark:bg-oai-gray-900 dark:text-oai-gray-400">
              {copy("pswitch.provider.preset_no_fields")}
            </p>
          ) : null}

          {showEndpointForAdd ? (
            <EndpointField
              label={copy("pswitch.field.endpoint")}
              value={currentEndpoint}
              onChange={(value) => setDraft((current) => setPath(current, ENDPOINT_PATH[app], value))}
              isFullUrl={!!meta.isFullUrl}
              onFullUrlChange={(on) => setMetaValue("isFullUrl", on || undefined)}
              onManage={openSpeedTest}
              hint={endpointHint}
            />
          ) : null}
          {showModelForAdd ? (
            <ModelInput
              label={copy("pswitch.field.model")}
              value={String(getPath(draft, DEFAULT_MODEL_PATH[app]) ?? "")}
              onChange={(value) => setDraft((current) => setPath(current, DEFAULT_MODEL_PATH[app], value))}
              models={fetchedModels}
              fetchState={fetchState}
              onFetch={fetchModels}
              hint={copy("pswitch.field.model_hint")}
            />
          ) : null}

          {showEndpointForEdit ? (
            <EndpointField
              label={copy("pswitch.field.endpoint")}
              value={currentEndpoint}
              onChange={(value) => setDraft((current) => setPath(current, ENDPOINT_PATH[app], value))}
              isFullUrl={!!meta.isFullUrl}
              onFullUrlChange={(on) => setMetaValue("isFullUrl", on || undefined)}
              onManage={openSpeedTest}
              hint={endpointHint}
            />
          ) : null}
          {showModelForEdit ? (
            <ModelInput
              label={copy("pswitch.field.model")}
              value={String(getPath(draft, DEFAULT_MODEL_PATH[app]) ?? "")}
              onChange={(value) => setDraft((current) => setPath(current, DEFAULT_MODEL_PATH[app], value))}
              models={fetchedModels}
              fetchState={fetchState}
              onFetch={fetchModels}
              hint={copy("pswitch.field.model_hint")}
            />
          ) : null}

          {showAdvancedToggle ? (
            <div className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800">
              <button
                type="button"
                onClick={() => setAdvancedOpen((current) => !current)}
                className="flex w-full items-center gap-1.5 px-4 py-3 text-left"
                aria-expanded={advancedOpen}
              >
                {advancedOpen ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-oai-gray-400" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-oai-gray-400" />
                )}
                <span className="text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">
                  {copy("pswitch.advanced.title")}
                </span>
              </button>
              {claudeAdvancedOpen ? (
                <div className="space-y-4 border-t border-oai-gray-100 px-4 py-4 dark:border-oai-gray-800">
                  <div>
                    <FieldLabel label={copy("pswitch.advanced.model_mapping")}>
                      <span className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={fillAllRoles}
                          className="inline-flex items-center gap-1 text-xs font-medium text-oai-brand-600 hover:underline dark:text-oai-brand-400"
                        >
                          <Wand2 className="h-3.5 w-3.5" />
                          {copy("pswitch.advanced.fill_all")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void fetchModels()}
                          disabled={fetchState === "loading"}
                          className="inline-flex items-center gap-1 text-xs font-medium text-oai-brand-600 hover:underline disabled:opacity-50 dark:text-oai-brand-400"
                        >
                          <Download className="h-3.5 w-3.5" />
                          {fetchState === "loading" ? copy("pswitch.models.fetching") : copy("pswitch.models.fetch")}
                        </button>
                      </span>
                    </FieldLabel>
                    <div className="space-y-2">
                      {CLAUDE_MODEL_ROLES.map((role) => (
                        <div
                          key={role.key}
                          className="grid grid-cols-[84px_1fr_1fr_auto] items-center gap-2 rounded-lg bg-oai-gray-50 px-2.5 py-2 dark:bg-oai-gray-900"
                        >
                          <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">
                            {copy(role.labelKey)}
                          </span>
                          {role.namePath ? (
                            <input
                              type="text"
                              value={String(getPath(draft, role.namePath) ?? "")}
                              onChange={(event) => setDraft((current) => setPath(current, role.namePath, event.target.value))}
                              placeholder={copy("pswitch.advanced.display_name")}
                              aria-label={`${copy(role.labelKey)} ${copy("pswitch.advanced.display_name")}`}
                              className="w-full rounded-md border border-oai-gray-200 bg-white px-2 py-1.5 text-xs text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:text-white"
                            />
                          ) : (
                            <span className="text-xs text-oai-gray-400 dark:text-oai-gray-500">
                              {copy("pswitch.advanced.no_display_name")}
                            </span>
                          )}
                          <div className="flex min-w-0 gap-1">
                            <input
                              type="text"
                              value={withoutOneM(String(getPath(draft, role.modelPath) ?? ""))}
                              onChange={(event) =>
                                setDraft((current) => {
                                  const suffix = oneMOn(role) ? "[1m]" : "";
                                  return setPath(current, role.modelPath, `${event.target.value}${suffix}`);
                                })
                              }
                              placeholder="claude-sonnet-4-6"
                              aria-label={`${copy(role.labelKey)} model`}
                              className="w-full min-w-0 rounded-md border border-oai-gray-200 bg-white px-2 py-1.5 font-mono text-xs text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:text-white"
                            />
                            {fetchedModels && fetchedModels.length ? (
                              <ModelDropdown
                                models={fetchedModels}
                                onSelect={(model) =>
                                  setDraft((current) => {
                                    const suffix = oneMOn(role) ? "[1m]" : "";
                                    return setPath(current, role.modelPath, `${model}${suffix}`);
                                  })
                                }
                              />
                            ) : null}
                          </div>
                          {role.supportsOneM ? (
                            <label className="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
                              <input
                                type="checkbox"
                                checked={oneMOn(role)}
                                onChange={(event) => toggleOneM(role, event.target.checked)}
                                className="h-3.5 w-3.5 rounded border-oai-gray-300 accent-oai-brand-500"
                              />
                              {copy("pswitch.advanced.one_m")}
                            </label>
                          ) : (
                            <span className="w-3" />
                          )}
                        </div>
                      ))}
                    </div>
                    <p className="mt-1.5 text-xs text-oai-gray-400 dark:text-oai-gray-500">
                      {copy("pswitch.advanced.mapping_hint")}
                    </p>
                  </div>
                  <div>
                    <FieldLabel label={copy("pswitch.advanced.api_format")} />
                    <select
                      value={meta.apiFormat || "anthropic"}
                      onChange={(event) =>
                        setMetaValue("apiFormat", event.target.value === "anthropic" ? undefined : event.target.value)
                      }
                      aria-label={copy("pswitch.advanced.api_format")}
                      className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                    >
                      <option value="anthropic">{copy("pswitch.advanced.format_anthropic")}</option>
                      <option value="openai_chat">{copy("pswitch.advanced.format_openai_chat")}</option>
                      <option value="openai_responses">{copy("pswitch.advanced.format_openai_responses")}</option>
                      <option value="gemini_native">{copy("pswitch.advanced.format_gemini_native")}</option>
                    </select>
                    <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">
                      {copy("pswitch.advanced.api_format_hint")}
                    </p>
                  </div>
                  <ModelInput
                    label={copy("pswitch.advanced.default_model")}
                    value={withoutOneM(String(getPath(draft, DEFAULT_MODEL_PATH.claude) ?? ""))}
                    onChange={(value) => setDraft((current) => setPath(current, DEFAULT_MODEL_PATH.claude, value))}
                    models={fetchedModels}
                    fetchState={fetchState}
                    hint={copy("pswitch.advanced.default_model_hint")}
                  />
                  <div>
                    <FieldLabel label={copy("pswitch.advanced.user_agent")} />
                    <input
                      type="text"
                      value={meta.customUserAgent || ""}
                      onChange={(event) => setMetaValue("customUserAgent", event.target.value)}
                      placeholder="Mozilla/5.0 …"
                      aria-label={copy("pswitch.advanced.user_agent")}
                      className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 font-mono text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <FieldLabel label={copy("pswitch.advanced.override_headers")} />
                      <JsonTextarea
                        value={(meta.localProxyRequestOverrides && meta.localProxyRequestOverrides.headers) || ""}
                        onChange={(value) =>
                          setMeta((current) => ({
                            ...current,
                            localProxyRequestOverrides: {
                              ...(current.localProxyRequestOverrides || {}),
                              headers: value || undefined,
                            },
                          }))
                        }
                        rows={3}
                        label={copy("pswitch.advanced.override_headers")}
                      />
                    </div>
                    <div>
                      <FieldLabel label={copy("pswitch.advanced.override_body")} />
                      <JsonTextarea
                        value={(meta.localProxyRequestOverrides && meta.localProxyRequestOverrides.body) || ""}
                        onChange={(value) =>
                          setMeta((current) => ({
                            ...current,
                            localProxyRequestOverrides: {
                              ...(current.localProxyRequestOverrides || {}),
                              body: value || undefined,
                            },
                          }))
                        }
                        rows={3}
                        label={copy("pswitch.advanced.override_body")}
                      />
                    </div>
                  </div>
                </div>
              ) : null}
              {codexAdvancedOpen ? (
                <div className="space-y-4 border-t border-oai-gray-100 px-4 py-4 dark:border-oai-gray-800">
                  <CodexCatalogEditor
                    models={Array.isArray(meta.codexCatalogModels) ? meta.codexCatalogModels : []}
                    onChange={(rows) => setMetaValue("codexCatalogModels", rows)}
                    fetchedModels={fetchedModels}
                    fetchState={fetchState}
                    onFetch={() => void fetchModels()}
                    defaultModel={String(getPath(draft, DEFAULT_MODEL_PATH.codex) ?? "")}
                    onAddToMapping={() =>
                      setMeta((current) => {
                        const list = Array.isArray(current.codexCatalogModels) ? current.codexCatalogModels : [];
                        const model = String(getPath(draft, DEFAULT_MODEL_PATH.codex) ?? "").trim();
                        if (!model) return current;
                        return { ...current, codexCatalogModels: [...list, { model, displayName: model, contextWindow: "", reasoningLevels: [], defaultReasoningLevel: "" }] };
                      })
                    }
                  />
                  <div>
                    <FieldLabel label={copy("pswitch.advanced.user_agent")} />
                    <input
                      type="text"
                      value={meta.customUserAgent || ""}
                      onChange={(event) => setMetaValue("customUserAgent", event.target.value)}
                      placeholder="Mozilla/5.0 …"
                      aria-label={copy("pswitch.advanced.user_agent")}
                      className="w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 font-mono text-sm text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
                    />
                    <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">
                      {copy("pswitch.advanced.codex_ua_hint")}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <FieldLabel label={copy("pswitch.advanced.override_headers")} />
                      <JsonTextarea
                        value={(meta.localProxyRequestOverrides && meta.localProxyRequestOverrides.headers) || ""}
                        onChange={(value) =>
                          setMeta((current) => ({
                            ...current,
                            localProxyRequestOverrides: {
                              ...(current.localProxyRequestOverrides || {}),
                              headers: value || undefined,
                            },
                          }))
                        }
                        rows={3}
                        label={copy("pswitch.advanced.override_headers")}
                      />
                    </div>
                    <div>
                      <FieldLabel label={copy("pswitch.advanced.override_body")} />
                      <JsonTextarea
                        value={(meta.localProxyRequestOverrides && meta.localProxyRequestOverrides.body) || ""}
                        onChange={(value) =>
                          setMeta((current) => ({
                            ...current,
                            localProxyRequestOverrides: {
                              ...(current.localProxyRequestOverrides || {}),
                              body: value || undefined,
                            },
                          }))
                        }
                        rows={3}
                        label={copy("pswitch.advanced.override_body")}
                      />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <div>
            <FieldLabel label={copy("pswitch.provider.config")} />
            <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">
              {copy("pswitch.provider.config_editor_hint")}
            </p>
            {showQuickToggles ? (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                {quickToggles.map((toggle) => (
                  <label
                    key={toggle.key}
                    className="flex cursor-pointer items-center gap-1.5 text-xs text-oai-gray-600 dark:text-oai-gray-300"
                  >
                    <input
                      type="checkbox"
                      checked={toggle.get()}
                      onChange={(event) => toggle.set(event.target.checked)}
                      className="h-3.5 w-3.5 rounded border-oai-gray-300 accent-oai-brand-500"
                    />
                    {copy(toggle.labelKey)}
                  </label>
                ))}
              </div>
            ) : null}
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={formatConfigText}
                className="text-xs font-medium text-oai-brand-600 hover:underline dark:text-oai-brand-400"
              >
                {copy("pswitch.json.format")}
              </button>
            </div>
            <JsonTextarea
              value={rawText}
              onChange={handleConfigTextChange}
              rows={12}
              error={rawError}
              label={copy("pswitch.provider.config")}
            />
          </div>

          {pendingIssues ? (
            <div className="rounded-lg border border-oai-amber-dark/30 bg-oai-amber-50 px-3 py-2.5 text-xs text-oai-amber-dark dark:border-oai-amber-dark/40 dark:bg-oai-amber-dark/15 dark:text-oai-amber-light">
              <p className="font-medium">{copy("pswitch.validate.title")}</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {pendingIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
              <div className="mt-2 flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => setPendingIssues(null)}>
                  {copy("pswitch.validate.go_back")}
                </Button>
                <Button size="sm" onClick={() => void save(true)}>
                  {copy("pswitch.validate.save_anyway")}
                </Button>
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-oai-gray-100 px-5 py-3 dark:border-oai-gray-800">
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
              {copy("pswitch.action.cancel")}
            </Button>
            <Button size="sm" disabled={busy || loading || !name.trim()} onClick={() => void save(false)}>
              {copy("pswitch.action.save")}
            </Button>
          </div>
        </div>
      </div>

      <ProviderIconPicker
        open={iconPickerOpen}
        value={icon}
        color={iconColor}
        onPick={(picked, color) => {
          setIcon(picked);
          setIconColor(color);
          setIconPickerOpen(false);
        }}
        onClose={() => setIconPickerOpen(false)}
      />

      <EndpointSpeedTestDialog
        open={speedTestOpen}
        app={app}
        currentUrl={currentEndpoint}
        presetCandidates={endpointCandidates}
        onClose={closeSpeedTest}
      />
    </div>
  );
}

export default ProviderEditDialog;
