import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  AlertTriangle,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  Copy as CopyIcon,
  FolderOpen,
  Import,
  LoaderCircle,
  Moon,
  PauseCircle,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
  Zap,
  Feather,
} from "lucide-react";
import { copy } from "../lib/copy";
import { getLocalApiAuthHeaders } from "../lib/local-api-auth";
import { managementApi } from "../lib/easy-providers";
import {
  authFileName,
  authFileHealth,
  authFileRequestStats,
  cooldownReasonKey,
  fetchAuthFiles,
  isOAuthCredentialFile,
  isRuntimeOnlyAuthFile,
  loadAuthFileSettings,
  loadOAuthModelSettings,
  modelMatchesRule,
  normalizeAuthFileCooldowns,
  oauthModelCandidates,
  oauthModelProvidersFromAuthFiles,
  oauthModelsFromPayload,
  parseAuthFilePriority,
  providerKeyForFile,
  providerLabelForFile,
  requestRateColor,
  saveAuthFileSettings,
  saveOAuthModelSettings,
  setOAuthModelsExcluded,
  setOAuthCredentialFileDisabled,
  normalizeOAuthExcludedRules,
  summarizeAuthFileCooldowns,
} from "../lib/easy-auth";
import { Button, Card, ConfirmModal } from "../ui/components";
import { showToast } from "../ui/components/Toast";

// ---------------------------------------------------------------------------
// Credentials tab (凭据/OAuth 授权) — EasyCLIProxyAPI's AuthFileManagementPage,
// ported interaction-for-interaction: search + provider/status filters, per-
// credential cards with health cooldowns and request timelines, settings and
// model dialogs, OAuth model exclusions (per credential or per provider),
// enable/disable toggles, guarded deletes, and directory opening.
// ---------------------------------------------------------------------------

const PROVIDER_ICONS = {
  codex: SquareTerminal,
  claude: Feather,
  gemini: Sparkles,
  aistudio: Sparkles,
  vertex: Sparkles,
  antigravity: Boxes,
  kimi: Moon,
  xai: Zap,
  devin: Bot,
};

function CredsNotice({ message, tone = "error", onDismiss }) {
  if (!message) return null;
  const isError = tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${
        isError
          ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          : "border-oai-gray-200 bg-oai-gray-50 text-oai-gray-700 dark:border-oai-gray-800 dark:bg-oai-gray-800/60 dark:text-oai-gray-300"
      }`}
    >
      {isError ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <Check className="mt-0.5 h-4 w-4 shrink-0" />}
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={copy("proxy.upstream.common.close")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function CredsModal({ open, onClose, busy, title, subtitle, children, width = "max-w-2xl" }) {
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
          <Dialog.Popup className={`flex max-h-[88vh] w-full ${width} flex-col overflow-hidden rounded-2xl bg-white shadow-[0_20px_60px_-20px_rgba(0,0,0,0.25)] ring-1 ring-oai-gray-200 transition-[opacity,transform] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] data-[ending-style]:translate-y-2 data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0 dark:bg-oai-gray-950 dark:shadow-[0_20px_60px_-10px_rgba(0,0,0,0.65)] dark:ring-oai-gray-800`}>
            <div className="flex items-start justify-between gap-3 border-b border-oai-gray-100 px-5 py-4 dark:border-oai-gray-800">
              <div className="min-w-0">
                <Dialog.Title className="text-base font-semibold text-oai-black dark:text-white">{title}</Dialog.Title>
                {subtitle ? (
                  <Dialog.Description className="mt-0.5 truncate text-sm text-oai-gray-500 dark:text-oai-gray-400">
                    {subtitle}
                  </Dialog.Description>
                ) : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="shrink-0 rounded-md p-1.5 text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-black disabled:opacity-50 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                aria-label={copy("proxy.upstream.common.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const FieldLabel = ({ children }) => (
  <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{children}</span>
);

const inputClass = "h-9 w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700";

// --- health status (AuthFileHealthStatus port, with the shared 1s clock) ----

let clockNow = Date.now();
let clockTimer;
const clockListeners = new Set();
const subscribeClock = (listener) => {
  clockListeners.add(listener);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      clockListeners.forEach((notify) => notify());
    }, 1000);
  }
  return () => {
    clockListeners.delete(listener);
    if (!clockListeners.size) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
};
const getClockSnapshot = () => clockNow;

function formatDuration(seconds) {
  if (seconds < 60) return copy("proxy.creds.health.seconds", { count: seconds });
  if (seconds < 3600) return copy("proxy.creds.health.minutes", { count: Math.ceil(seconds / 60) });
  return copy("proxy.creds.health.hours", { count: Math.ceil(seconds / 3600) });
}

function CredentialHealthStatus({ file, receivedAtMs, observedAt }) {
  const snapshot = useMemo(
    () => normalizeAuthFileCooldowns(file.cooldowns, receivedAtMs, observedAt),
    [file, receivedAtMs, observedAt],
  );
  const hasTimers = Boolean(snapshot?.records?.length);
  const nowMs = useSyncExternalStore(
    hasTimers ? subscribeClock : (listener) => {
      listener();
      return () => {};
    },
    getClockSnapshot,
    getClockSnapshot,
  );
  const health = authFileHealth(file);
  const cooldown = summarizeAuthFileCooldowns(snapshot, nowMs);
  const healthy = health.label === "proxy.creds.health.active";
  if (healthy && !cooldown.rows.length && snapshot?.records !== null) return null;
  const reasonSet = new Set(cooldown.active.map(({ record }) => cooldownReasonKey(record.reason)));
  if (reasonSet.has("proxy.creds.health.reason.credentialQuota")) reasonSet.delete("proxy.creds.health.reason.quota");
  const reasons = Array.from(reasonSet);
  const title = health.disabled
    ? copy(health.label)
    : cooldown.elapsed
      ? copy("proxy.creds.health.elapsed")
      : cooldown.active.length
        ? reasons.map((key) => copy(key)).join(" · ")
        : healthy
          ? copy("proxy.creds.health.unknownCooldown")
          : copy(health.label);
  const tone = health.disabled || (healthy && !cooldown.rows.length)
    ? "neutral"
    : cooldown.rows.length ? "warning" : health.tone;
  const separateState = cooldown.rows.length > 0 && !health.disabled && (
    health.status === "pending" || health.status === "refreshing"
    || health.label === "proxy.creds.health.reason.invalidGrant"
    || health.label === "proxy.creds.health.reason.unauthorized"
    || health.label === "proxy.creds.health.reason.tokenExpired"
  );
  const Icon = health.disabled ? PauseCircle
    : cooldown.rows.length ? null
      : tone === "error" ? ShieldAlert
        : tone === "warning" || tone === "info" ? AlertTriangle : Check;
  const scope = cooldown.credentialWide
    ? cooldown.modelCount
      ? copy("proxy.creds.health.credentialModels", { count: cooldown.modelCount })
      : copy("proxy.creds.health.credential")
    : cooldown.modelCount
      ? copy("proxy.creds.health.models", { count: cooldown.modelCount })
      : "";
  const formatTimestamp = (value) => new Date(Date.parse(value)).toLocaleString([], {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const summary = (
    <>
      {cooldown.rows.length ? <PauseCircle className="h-4 w-4 shrink-0" /> : Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <strong className="font-medium">{title}</strong>
          {scope ? <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{scope}</span> : null}
        </span>
        {separateState ? (
          <span className="block text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {copy("proxy.creds.health.coreStatus", { status: copy(health.label) })}
          </span>
        ) : null}
        {health.message && !cooldown.rows.length && !health.label.startsWith("proxy.creds.health.reason.") ? (
          <span className="mt-0.5 block truncate text-xs text-oai-gray-500 dark:text-oai-gray-400" title={health.message}>
            {health.message}
          </span>
        ) : null}
        {cooldown.elapsed ? (
          <span className="block text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.creds.health.expiredHint")}</span>
        ) : null}
        {snapshot?.records === null && !healthy ? (
          <span className="block text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.creds.health.unknownCooldown")}</span>
        ) : null}
        {snapshot === undefined && health.tone === "error" ? (
          <span className="block text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.creds.health.missingCooldown")}</span>
        ) : null}
      </span>
      {cooldown.active.length > 0 ? (
        <span className="shrink-0 rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-medium tabular-nums text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          {copy("proxy.creds.health.earliest", { time: formatDuration(cooldown.earliestSeconds) })}
        </span>
      ) : null}
    </>
  );

  const toneClass = tone === "error"
    ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
    : tone === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
      : tone === "info"
        ? "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300"
        : "border-oai-gray-200 bg-oai-gray-50 text-oai-gray-600 dark:border-oai-gray-800 dark:bg-oai-gray-800/60 dark:text-oai-gray-300";

  if (!cooldown.rows.length && !health.message) {
    return <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${toneClass}`}>{summary}</div>;
  }
  return (
    <details className={`rounded-lg border px-3 py-2 text-sm ${toneClass}`}>
      <summary className="flex cursor-pointer items-start gap-2 marker:content-none [&::-webkit-details-marker]:hidden">{summary}</summary>
      <div className="mt-2 space-y-2 border-t border-current/20 pt-2 text-xs">
        {cooldown.rows.length && !healthy ? (
          <p>{copy("proxy.creds.health.coreStatus", { status: copy(health.label) })}</p>
        ) : null}
        {health.message ? (
          <p className="break-words"><span className="font-medium">{copy("proxy.creds.health.coreMessage")}</span> {health.message}</p>
        ) : null}
        <ul className="space-y-1.5">
          {cooldown.rows.map(({ record, remainingSeconds }, index) => (
            <li key={`${record.scope}:${record.model ?? ""}:${index}`} className="rounded-md bg-white/60 px-2 py-1.5 dark:bg-black/20">
              <div className="flex items-center justify-between gap-2">
                <strong className="font-medium">{record.scope === "credential" ? copy("proxy.creds.health.credentialScope") : record.model}</strong>
                <span className="tabular-nums">
                  {remainingSeconds > 0
                    ? copy("proxy.creds.health.remaining", { time: formatDuration(remainingSeconds) })
                    : copy("proxy.creds.health.waiting")}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-oai-gray-500 dark:text-oai-gray-400">
                <span>{copy(cooldownReasonKey(record.reason))}</span>
                {record.httpStatus !== undefined ? <span>HTTP {record.httpStatus}</span> : null}
                {record.backoffLevel !== undefined ? (
                  <span title={copy("proxy.creds.health.backoffHint")}>
                    {copy("proxy.creds.health.backoff", { level: record.backoffLevel })}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 text-oai-gray-500 dark:text-oai-gray-400">
                {copy("proxy.creds.health.deadline")} {formatTimestamp(record.retryAt)}
              </div>
            </li>
          ))}
        </ul>
        {snapshot?.observedAt ? (
          <p className="text-oai-gray-500 dark:text-oai-gray-400">
            {copy("proxy.creds.health.observed")} {formatTimestamp(snapshot.observedAt)}
          </p>
        ) : null}
        {cooldown.rows.length ? (
          <p className="text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.creds.health.note")}</p>
        ) : null}
      </div>
    </details>
  );
}

// --- request timeline (AuthFileRequestStatus port) ---------------------------

function CredentialRequestTimeline({ file }) {
  const stats = useMemo(() => authFileRequestStats(file), [file]);
  const [active, setActive] = useState(null);
  const percent = (rate) => (rate === null ? "—" : `${(rate * 100).toFixed(1)}%`);
  const count = (value) => (value === null ? "—" : String(value));
  const rateClass = stats.recentRate === null ? ""
    : stats.recentRate >= 0.9 ? "text-emerald-600 dark:text-emerald-400"
      : stats.recentRate >= 0.5 ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";
  const detail = active === null ? null : stats.buckets[active];
  return (
    <div className="space-y-1.5" role="group" aria-label={copy("proxy.creds.requests.title")}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.creds.requests.title")}</span>
        <span className="flex gap-2 tabular-nums" title={copy("proxy.creds.requests.totalsHint")}>
          <span className={stats.success ? "text-emerald-600 dark:text-emerald-400" : ""}>
            {copy("proxy.creds.requests.success", { count: count(stats.success) })}
          </span>
          <span className={stats.failure ? "text-red-600 dark:text-red-400" : ""}>
            {copy("proxy.creds.requests.failure", { count: count(stats.failure) })}
          </span>
        </span>
      </div>
      {stats.recentAvailable ? (
        <div className="flex items-center gap-2">
          <div
            className="flex h-6 flex-1 items-stretch gap-[2px]"
            onMouseLeave={() => setActive(null)}
            role="img"
            aria-label={copy("proxy.creds.requests.title")}
          >
            {stats.buckets.map((bucket, index) => (
              <button
                key={index}
                type="button"
                aria-label={`${bucket.time || index + 1} · ${percent(bucket.rate)}`}
                onMouseEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
                onClick={() => setActive(index)}
                className={`min-w-1.5 flex-1 rounded-[2px] transition-transform ${active === index ? "scale-y-110 outline outline-1 outline-oai-gray-400" : ""}`}
                style={bucket.rate === null ? { backgroundColor: "rgb(229 231 235 / 0.6)" } : { backgroundColor: requestRateColor(bucket.rate) }}
              />
            ))}
          </div>
          <span className={`w-12 shrink-0 text-right text-xs font-semibold tabular-nums ${rateClass}`} title={copy("proxy.creds.requests.recentRate")}>
            {percent(stats.recentRate)}
          </span>
        </div>
      ) : (
        <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.creds.requests.unavailable")}</p>
      )}
      {detail && active !== null ? (
        <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400" role="status">
          <strong>{detail.time || copy("proxy.creds.requests.interval", { index: active + 1 })}</strong>
          {" · "}
          {detail.rate === null
            ? copy("proxy.creds.requests.empty")
            : `${copy("proxy.creds.requests.success", { count: detail.success })} · ${copy("proxy.creds.requests.failure", { count: detail.failure })} · ${percent(detail.rate)}`}
        </p>
      ) : null}
    </div>
  );
}

// --- settings dialog (AuthFileSettingsDialog port) ---------------------------

function CredentialSettingsDialog({ name, onClose, onSaved }) {
  const [original, setOriginal] = useState(null);
  const [draft, setDraft] = useState(null);
  const [models, setModels] = useState([]);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(original);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setCatalogLoading(true);
    setCatalogError("");
    loadAuthFileSettings(name)
      .then((value) => {
        if (active) { setOriginal(value); setDraft(value); }
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (active) setLoading(false); });
    managementApi.get("/auth-files/models", { name })
      .then((payload) => {
        if (active) setModels(oauthModelsFromPayload(payload));
      })
      .catch((reason) => {
        if (active) setCatalogError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [name, attempt]);

  const close = () => {
    if (saving) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  const update = (key, value) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setError("");
    setDiscard(false);
  };
  const save = async () => {
    if (!draft || !original || saving) return;
    setSaving(true);
    setError("");
    setDiscard(false);
    try {
      const changed = await saveAuthFileSettings(name, original, draft);
      if (changed) onSaved();
      else onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  const rules = normalizeOAuthExcludedRules((draft?.excluded_models ?? "").split(/\r?\n/));
  const candidates = oauthModelCandidates(models, rules).filter((model) =>
    `${model.id} ${model.displayName ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));

  const textField = (key, placeholder) => (
    <label className="block space-y-1">
      <FieldLabel>
        {copy(`proxy.creds.settings.${key}`)} <code className="rounded bg-oai-gray-100 px-1 font-mono text-[10px] dark:bg-oai-gray-800">{key}</code>
      </FieldLabel>
      <input
        value={draft?.[key] ?? ""}
        onChange={(event) => update(key, event.currentTarget.value)}
        inputMode={key === "priority" || key === "weight" ? "numeric" : undefined}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={inputClass}
      />
      <span className="block text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy(`proxy.creds.settings.${key}Hint`)}</span>
    </label>
  );
  const booleanField = (key) => (
    <label className="block space-y-1">
      <FieldLabel>
        {copy(`proxy.creds.settings.${key}`)} <code className="rounded bg-oai-gray-100 px-1 font-mono text-[10px] dark:bg-oai-gray-800">{key}</code>
      </FieldLabel>
      <select
        value={draft?.[key] ?? ""}
        onChange={(event) => update(key, event.currentTarget.value)}
        className={inputClass}
      >
        <option value="">{copy("proxy.creds.settings.inherit")}</option>
        <option value="true">{copy("proxy.creds.action.enable")}</option>
        <option value="false">{copy("proxy.creds.action.disable")}</option>
      </select>
      <span className="block text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy(`proxy.creds.settings.${key}Hint`)}</span>
    </label>
  );

  return (
    <CredsModal
      open
      onClose={close}
      busy={saving}
      title={copy("proxy.creds.settings.title")}
      subtitle={name}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4" aria-busy={loading}>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-oai-gray-400">
              <LoaderCircle className="h-5 w-5 animate-spin" />
              {copy("proxy.upstream.loading")}
            </div>
          ) : draft ? (
            <fieldset disabled={saving} className="space-y-5">
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">{copy("proxy.creds.settings.routing")}</h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {textField("prefix")}
                  {textField("proxy_url", "socks5://127.0.0.1:1080")}
                  {textField("priority", "0")}
                  {textField("weight", "1")}
                  {booleanField("disable_cooling")}
                  {booleanField("websockets")}
                </div>
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">
                  {copy("proxy.creds.settings.excluded_models")}{" "}
                  <code className="rounded bg-oai-gray-100 px-1 font-mono text-[10px] dark:bg-oai-gray-800">excluded_models</code>
                </h3>
                <label className="block space-y-1">
                  <FieldLabel>{copy("proxy.creds.settings.rules")}</FieldLabel>
                  <textarea
                    rows={3}
                    value={draft.excluded_models}
                    onChange={(event) => update("excluded_models", event.currentTarget.value)}
                    spellCheck={false}
                    placeholder={"gpt-example\nclaude-*"}
                    className="w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700"
                  />
                  <span className="block text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.creds.settings.excludedHint")}</span>
                </label>
                <details className="rounded-lg border border-oai-gray-200 px-3 py-2 dark:border-oai-gray-700">
                  <summary className="cursor-pointer text-sm font-medium">
                    {copy("proxy.creds.settings.catalog", { count: models.length })}
                  </summary>
                  {catalogLoading ? (
                    <p className="mt-2 flex items-center gap-2 text-xs text-oai-gray-400">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      {copy("proxy.upstream.loading")}
                    </p>
                  ) : null}
                  {catalogError ? (
                    <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                      {copy("proxy.creds.settings.catalogError")}
                      <span className="block break-words">{catalogError}</span>
                    </p>
                  ) : null}
                  <input
                    aria-label={copy("proxy.creds.settings.searchModels")}
                    placeholder={copy("proxy.creds.settings.searchModels")}
                    value={search}
                    onChange={(event) => setSearch(event.currentTarget.value)}
                    className={`${inputClass} mt-2`}
                  />
                  <div className="mt-2 grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                    {candidates.map((model) => {
                      const wildcard = rules.some((rule) => rule.includes("*") && modelMatchesRule(model.id, rule));
                      return (
                        <label
                          key={model.id}
                          title={wildcard ? copy("proxy.creds.settings.wildcard") : model.displayName}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800"
                        >
                          <input
                            type="checkbox"
                            checked={rules.some((rule) => modelMatchesRule(model.id, rule))}
                            disabled={wildcard}
                            onChange={(event) => update(
                              "excluded_models",
                              setOAuthModelsExcluded(rules, [model], event.currentTarget.checked).join("\n"),
                            )}
                            className="h-3.5 w-3.5 rounded border-oai-gray-300 accent-oai-brand-600"
                          />
                          <span className="min-w-0 truncate font-mono">
                            {model.id}
                            {wildcard ? <small className="ml-1 text-oai-gray-400">{copy("proxy.creds.settings.wildcard")}</small> : null}
                          </span>
                        </label>
                      );
                    })}
                    {!catalogLoading && !candidates.length ? (
                      <p className="text-xs text-oai-gray-400">{copy("proxy.creds.settings.noModels")}</p>
                    ) : null}
                  </div>
                </details>
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">{copy("proxy.creds.settings.additional")}</h3>
                <label className="block space-y-1">
                  <FieldLabel>
                    {copy("proxy.creds.settings.headers")} <code className="rounded bg-oai-gray-100 px-1 font-mono text-[10px] dark:bg-oai-gray-800">headers</code>
                  </FieldLabel>
                  <textarea
                    rows={5}
                    value={draft.headers}
                    onChange={(event) => update("headers", event.currentTarget.value)}
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full rounded-lg border border-oai-gray-200 bg-oai-gray-50 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700 dark:bg-oai-gray-950"
                  />
                  <span className="block text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.creds.settings.headersHint")}</span>
                </label>
                <label className="block space-y-1">
                  <FieldLabel>
                    {copy("proxy.creds.settings.note")} <code className="rounded bg-oai-gray-100 px-1 font-mono text-[10px] dark:bg-oai-gray-800">note</code>
                  </FieldLabel>
                  <textarea
                    rows={2}
                    value={draft.note}
                    onChange={(event) => update("note", event.currentTarget.value)}
                    className="w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700"
                  />
                </label>
              </section>
            </fieldset>
          ) : null}
        </div>
        <div className="space-y-2 border-t border-oai-gray-100 px-5 py-3.5 dark:border-oai-gray-800">
          {error ? <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p> : null}
          {discard ? (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" role="alert">
              <span className="flex-1">{copy("proxy.creds.settings.unsaved")}</span>
              <Button size="sm" variant="secondary" onClick={() => setDiscard(false)}>
                {copy("proxy.creds.settings.keepEditing")}
              </Button>
              <Button size="sm" variant="ghost" className="!text-red-600 hover:!bg-red-50 dark:hover:!bg-red-950/40 dark:!text-red-400" onClick={onClose}>
                {copy("proxy.creds.settings.discard")}
              </Button>
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="secondary" disabled={saving} onClick={close}>
              {copy("proxy.upstream.common.cancel")}
            </Button>
            {!loading && !draft ? (
              <Button type="button" onClick={() => setAttempt((value) => value + 1)}>
                {copy("proxy.upstream.common.refresh")}
              </Button>
            ) : (
              <Button type="submit" disabled={!draft || loading || saving || !dirty}>
                {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {copy("proxy.upstream.common.save")}
              </Button>
            )}
          </div>
        </div>
      </form>
    </CredsModal>
  );
}

// --- models dialog (AuthFileModelsDialog port) -------------------------------

function CredentialModelsDialog({ name, onClose }) {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setModels([]);
    setError("");
    managementApi.get("/auth-files/models", { name })
      .then((payload) => { if (!cancelled) setModels(oauthModelsFromPayload(payload)); })
      .catch((requestError) => { if (!cancelled) setError(String(requestError)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [name]);

  const query = search.trim().toLowerCase();
  const visibleModels = models.filter((model) =>
    [model.id, model.displayName ?? ""].join(" ").toLowerCase().includes(query));
  const copyModel = async (id) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => (current === id ? "" : current)), 1500);
    } catch (copyError) {
      setError(String(copyError));
    }
  };

  return (
    <CredsModal
      open
      onClose={onClose}
      title={copy("proxy.creds.models.viewTitle")}
      subtitle={name}
      width="max-w-xl"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.creds.models.viewDescription")}</p>
        <div className="relative mt-3">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-oai-gray-400" />
          <input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={copy("proxy.creds.models.search")}
            className={`${inputClass} pl-8`}
          />
        </div>
        <div className="mt-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-oai-gray-400">
              <LoaderCircle className="h-5 w-5 animate-spin" />
              {copy("proxy.creds.models.loading")}
            </div>
          ) : (
            <>
              {error ? <CredsNotice message={error} onDismiss={() => setError("")} /> : null}
              {visibleModels.length === 0 ? (
                <p className="py-6 text-center text-sm text-oai-gray-400">
                  {copy(models.length ? "proxy.creds.models.noMatch" : "proxy.creds.models.viewEmpty")}
                </p>
              ) : (
                <ul className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
                  {visibleModels.map((model) => (
                    <li key={model.id}>
                      <button
                        type="button"
                        onClick={() => void copyModel(model.id)}
                        title={copy("proxy.creds.models.copyModel")}
                        className="flex w-full items-center justify-between gap-3 px-1 py-2 text-left text-sm hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/60"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-xs" title={model.id}>{model.id}</span>
                          {model.displayName ? (
                            <small className="block truncate text-xs text-oai-gray-400" title={model.displayName}>{model.displayName}</small>
                          ) : null}
                        </span>
                        {copied === model.id
                          ? <Check className="h-4 w-4 shrink-0 text-oai-brand-600" />
                          : <CopyIcon className="h-4 w-4 shrink-0 text-oai-gray-400" />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex justify-end border-t border-oai-gray-100 px-5 py-3.5 dark:border-oai-gray-800">
        <Button variant="secondary" onClick={onClose}>{copy("proxy.upstream.common.close")}</Button>
      </div>
    </CredsModal>
  );
}

// --- OAuth model exclusions (per-credential / per-provider) ------------------

function OauthModelsDialog({ target, onClose }) {
  const [settings, setSettings] = useState(null);
  const [rulesText, setRulesText] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);
  const saveRef = useRef(false);

  const openSettings = useCallback(async (nextTarget) => {
    if (saveRef.current) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setSettings(null);
    setRulesText("");
    setSearch("");
    setError("");
    setLoading(true);
    try {
      const loaded = await loadOAuthModelSettings(nextTarget);
      if (requestRef.current !== requestId) return;
      setSettings(loaded);
      setRulesText(loaded.excludedRules.join("\n"));
    } catch (requestError) {
      if (requestRef.current === requestId) setError(String(requestError));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void openSettings(target);
  }, [openSettings, target]);

  const close = () => {
    if (saveRef.current || saving) return;
    requestRef.current += 1;
    onClose();
  };

  const rules = normalizeOAuthExcludedRules(rulesText.split(/\r?\n/));
  const oauthModels = settings?.models ?? [];
  const openCount = oauthModels.filter((model) => !rules.some((rule) => modelMatchesRule(model.id, rule))).length;
  const excludedCount = oauthModels.length - openCount;
  const visibleModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return oauthModels;
    return oauthModels.filter((model) =>
      `${model.id} ${model.displayName ?? ""}`.toLowerCase().includes(query));
  }, [search, oauthModels]);

  const setExcluded = (models, excluded) => {
    if (saveRef.current) return;
    setRulesText((current) =>
      setOAuthModelsExcluded(current.split(/\r?\n/), models, excluded).join("\n"));
  };

  const save = async () => {
    if (!settings || loading || saveRef.current) return;
    saveRef.current = true;
    setSaving(true);
    setError("");
    try {
      await saveOAuthModelSettings(settings, rules);
      showToast(settings.target.scope === "credential"
        ? copy("proxy.creds.models.credentialUpdated", { name: settings.target.name })
        : copy("proxy.creds.models.updated", { provider: settings.target.label }), "success");
      saveRef.current = false;
      close();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      saveRef.current = false;
      setSaving(false);
    }
  };

  return (
    <CredsModal
      open
      onClose={close}
      busy={saving}
      title={copy(target.scope === "credential" ? "proxy.creds.models.title" : "proxy.creds.models.globalButton")}
      subtitle={target.scope === "credential" ? target.name : undefined}
      width="max-w-xl"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {target.scope === "provider" ? (
          <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {copy("proxy.creds.models.globalDescription", { provider: target.label })}
          </p>
        ) : (
          <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {copy("proxy.creds.models.description")}
          </p>
        )}
        <div className="relative mt-3">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-oai-gray-400" />
          <input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={copy("proxy.creds.models.search")}
            className={`${inputClass} pl-8`}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-oai-gray-500 dark:text-oai-gray-400">
            {copy("proxy.creds.models.summary", { total: oauthModels.length, excluded: excludedCount })}
          </span>
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={loading || saving || oauthModels.length === 0}
              onClick={() => setExcluded(oauthModels, true)}
              title={copy("proxy.creds.models.excludeAllHint")}
            >
              {copy("proxy.creds.models.excludeAll")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={loading || saving || oauthModels.length === 0}
              onClick={() => setExcluded(oauthModels, false)}
              title={copy("proxy.creds.models.clearHint")}
            >
              {copy("proxy.creds.models.clearSelected")}
            </Button>
          </span>
        </div>
        <div className="mt-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-oai-gray-400">
              <LoaderCircle className="h-5 w-5 animate-spin" />
              {copy("proxy.creds.models.loading")}
            </div>
          ) : error && !settings ? (
            <CredsNotice message={error} />
          ) : (
            <>
              {error ? <CredsNotice message={error} onDismiss={() => setError("")} /> : null}
              {settings?.catalogError ? (
                <p className="mb-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("proxy.creds.models.catalogUnavailable")}
                </p>
              ) : null}
              {visibleModels.length === 0 ? (
                <p className="py-6 text-center text-sm text-oai-gray-400">
                  {copy(oauthModels.length ? "proxy.creds.models.noMatch" : "proxy.creds.models.empty")}
                </p>
              ) : (
                <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                  {visibleModels.map((model) => {
                    const wildcardRule = rules.find((rule) => rule.includes("*") && modelMatchesRule(model.id, rule));
                    const checked = rules.some((rule) => modelMatchesRule(model.id, rule));
                    return (
                      <li key={model.id}>
                        <label
                          className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/60 ${checked ? "bg-oai-gray-50 dark:bg-oai-gray-800/80" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={saving || Boolean(wildcardRule)}
                            onChange={(event) => setExcluded([model], event.currentTarget.checked)}
                            className="h-4 w-4 rounded border-oai-gray-300 accent-oai-brand-600"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-xs" title={model.id}>{model.id}</span>
                            {model.displayName ? (
                              <small className="block truncate text-xs text-oai-gray-400" title={model.displayName}>{model.displayName}</small>
                            ) : null}
                            {wildcardRule ? (
                              <small className="block text-xs text-amber-600 dark:text-amber-400">
                                {copy("proxy.creds.models.wildcardBlocked", { rule: wildcardRule })}
                              </small>
                            ) : null}
                          </span>
                          {checked ? <Check className="h-4 w-4 shrink-0 text-oai-brand-600" /> : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
        <label className="mt-3 block space-y-1">
          <FieldLabel>{copy("proxy.creds.models.rulesLabel")}</FieldLabel>
          <textarea
            id="oauth-model-rules"
            rows={3}
            spellCheck={false}
            value={rulesText}
            disabled={loading || saving || !settings}
            onChange={(event) => setRulesText(event.currentTarget.value)}
            placeholder={copy("proxy.creds.models.rulesPlaceholder")}
            className="w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700"
          />
          <span className="block text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.creds.models.rulesHint")}</span>
        </label>
      </div>
      <div className="flex justify-end gap-2 border-t border-oai-gray-100 px-5 py-3.5 dark:border-oai-gray-800">
        <Button variant="secondary" disabled={saving} onClick={close}>
          {copy("proxy.upstream.common.cancel")}
        </Button>
        <Button onClick={() => void save()} disabled={loading || saving || !settings}>
          {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          {copy("proxy.creds.models.save", { count: rules.length })}
        </Button>
      </div>
    </CredsModal>
  );
}

// --- main tab ----------------------------------------------------------------

export function AuthFilesTab({ onDirty }) {
  const [snapshot, setSnapshot] = useState({ files: [], receivedAtMs: 0, observedAt: undefined });
  const [filter, setFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [settingsName, setSettingsName] = useState(null);
  const [modelViewName, setModelViewName] = useState(null);
  const [oauthModelTarget, setOauthModelTarget] = useState(null);
  const [deleteFile, setDeleteFile] = useState(null);
  const [copied, setCopied] = useState("");
  const fileInputRef = useRef(null);

  const { files, receivedAtMs, observedAt } = snapshot;

  const loadFiles = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError("");
    try {
      const next = await fetchAuthFiles();
      setSnapshot(next);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const providers = useMemo(
    () => Array.from(new Set(files.map(providerLabelForFile))).sort((left, right) => left.localeCompare(right)),
    [files],
  );

  const oauthModelProviders = useMemo(() => oauthModelProvidersFromAuthFiles(files)
    .map((provider) => ({ provider, label: providerLabelForFile({ provider }) }))
    .sort((a, b) => a.label.localeCompare(b.label)), [files]);

  const visibleFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return files.filter((file) => {
      const disabled = Boolean(file.disabled);
      const providerMatch = providerFilter === "all" || providerLabelForFile(file) === providerFilter;
      const runtimeMatch =
        statusFilter === "all"
        || (statusFilter === "disabled" && disabled)
        || (statusFilter === "enabled" && !disabled)
        || (statusFilter === "runtime" && isRuntimeOnlyAuthFile(file));
      const searchMatch =
        !query
        || [authFileName(file), providerLabelForFile(file), String(file.email ?? file.account ?? file.label ?? "")]
          .join(" ")
          .toLowerCase()
          .includes(query);
      return providerMatch && runtimeMatch && searchMatch;
    });
  }, [files, filter, providerFilter, statusFilter]);

  const handleUpload = async (event) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (selected.length === 0) return;
    setBusy(true);
    setError("");
    let uploaded = 0;
    const failures = [];
    const headers = await getLocalApiAuthHeaders();
    for (const file of selected) {
      try {
        const content = await file.text();
        // The core's upload endpoint is multipart/form-data; the local backend
        // route performs that translation, so raw JSON would be rejected.
        const response = await fetch("/api/proxy/auth-files", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ name: file.name, content }),
        });
        const payload = await response.json().catch(() => null);
        if (!payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
        uploaded += 1;
      } catch (requestError) {
        failures.push(`${file.name}: ${String(requestError)}`);
      }
    }
    try {
      await loadFiles(false);
      if (uploaded > 0) showToast(copy("proxy.creds.uploaded", { count: uploaded }), "success");
      if (failures.length > 0) {
        setError(copy("proxy.creds.uploadFailed", { count: failures.length, errors: failures.join("; ") }));
      }
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (file) => {
    setBusy(true);
    setError("");
    try {
      await setOAuthCredentialFileDisabled(file, !Boolean(file.disabled));
      await loadFiles(false);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (file) => {
    const name = authFileName(file);
    setBusy(true);
    setError("");
    try {
      await managementApi.delete("/auth-files", { query: { name } });
      showToast(copy("proxy.creds.deleted"), "success");
      await loadFiles();
      onDirty?.();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
      setDeleteFile(null);
    }
  };

  const openAuthFilesDirectory = async () => {
    setBusy(true);
    setError("");
    try {
      const headers = await getLocalApiAuthHeaders();
      const response = await fetch("/api/proxy/auth-files/open-directory", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      });
      const payload = await response.json().catch(() => null);
      if (!payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const copyName = async (name) => {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(name);
      window.setTimeout(() => setCopied((current) => (current === name ? "" : current)), 1500);
    } catch {
      setError(copy("proxy.creds.copyFailed"));
    }
  };

  const disabledCount = files.filter((file) => Boolean(file.disabled)).length;
  const runtimeCount = files.filter(isRuntimeOnlyAuthFile).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
          {copy("proxy.creds.summary", { files: files.length, disabled: disabledCount })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const provider = oauthModelProviders.find((item) => item.label === providerFilter) ?? oauthModelProviders[0];
              if (provider) setOauthModelTarget({ ...provider, scope: "provider" });
            }}
            disabled={loading || busy || oauthModelProviders.length === 0}
          >
            <Settings2 className="h-4 w-4" />
            {copy("proxy.creds.models.globalButton")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void loadFiles()} disabled={loading || busy}>
            <RefreshCw className="h-4 w-4" />
            {copy("proxy.upstream.common.refresh")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void openAuthFilesDirectory()} disabled={busy}>
            <FolderOpen className="h-4 w-4" />
            {copy("proxy.creds.openDirectory")}
          </Button>
          <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <Import className="h-4 w-4" />
            {copy("proxy.creds.import")}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            hidden
            onChange={(event) => void handleUpload(event)}
          />
        </div>
      </div>

      <CredsNotice message={error} onDismiss={() => setError("")} />

      <Card className="!p-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-oai-gray-100 px-4 py-3 dark:border-oai-gray-800">
          <Search className="h-4 w-4 text-oai-gray-400" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder={copy("proxy.creds.searchPlaceholder")}
            className="h-8 min-w-[140px] flex-1 rounded-lg border border-oai-gray-200 bg-transparent px-2.5 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700"
          />
          <select
            value={providerFilter}
            onChange={(event) => setProviderFilter(event.currentTarget.value)}
            className="h-8 rounded-lg border border-oai-gray-200 bg-transparent px-2 text-sm focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700"
          >
            <option value="all">{copy("proxy.creds.filter.allProviders")}</option>
            {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
          </select>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.currentTarget.value)}
            className="h-8 rounded-lg border border-oai-gray-200 bg-transparent px-2 text-sm focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700"
          >
            <option value="all">{copy("proxy.creds.filter.allStatuses")}</option>
            <option value="enabled">{copy("proxy.creds.filter.enabled")}</option>
            <option value="disabled">{copy("proxy.creds.filter.disabled")}</option>
            <option value="runtime">{copy("proxy.creds.filter.runtime")}</option>
          </select>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-oai-gray-400">
            <LoaderCircle className="h-5 w-5 animate-spin" />
            {copy("proxy.creds.loading")}
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-400">
              {copy(files.length ? "proxy.creds.empty.filtered" : "proxy.creds.empty.none")}
            </p>
            <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">
              {copy(files.length ? "proxy.creds.empty.tryFilter" : "proxy.creds.empty.upload")}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-2">
            {visibleFiles.map((file) => {
              const name = authFileName(file);
              const Icon = PROVIDER_ICONS[providerKeyForFile(file)] ?? Sparkles;
              const disabled = Boolean(file.disabled);
              const priority = parseAuthFilePriority(file.priority) ?? 0;
              const identity = String(file.email ?? file.project_id ?? file.label ?? "");
              const note = String(file.note ?? "");
              const isOauth = isOAuthCredentialFile(file);
              const runtimeOnly = isRuntimeOnlyAuthFile(file);
              const size = file.size == null ? null : Number(file.size);
              return (
                <article
                  key={`${name}-${String(file.auth_index ?? file.authIndex ?? "")}`}
                  className={`rounded-xl border bg-white p-3.5 dark:bg-oai-gray-900 ${
                    disabled
                      ? "border-oai-gray-200 opacity-75 dark:border-oai-gray-800"
                      : "border-oai-gray-200 dark:border-oai-gray-800"
                  }`}
                >
                  <header className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-oai-gray-100 text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-300">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium capitalize text-oai-gray-500 dark:text-oai-gray-400">
                          {providerLabelForFile(file)}
                        </span>
                        {runtimeOnly ? (
                          <span className="rounded bg-oai-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-oai-gray-500 dark:bg-oai-gray-800 dark:text-oai-gray-400">
                            {copy("proxy.creds.runtime")}
                          </span>
                        ) : null}
                      </div>
                      <strong className="block truncate text-sm" title={identity || name}>{identity || name}</strong>
                    </div>
                  </header>
                  {identity ? (
                    <p className="mt-1 truncate font-mono text-xs text-oai-gray-400 dark:text-oai-gray-500" title={name}>{name}</p>
                  ) : null}
                  <div className="mt-2.5">
                    <CredentialHealthStatus file={file} receivedAtMs={receivedAtMs} observedAt={observedAt} />
                  </div>
                  <div className="mt-2.5">
                    <CredentialRequestTimeline file={file} />
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs text-oai-gray-400 dark:text-oai-gray-500">
                    <span>
                      {copy("proxy.creds.priority.button", { priority })}
                      {" · "}
                      {size === null || !Number.isFinite(size)
                        ? copy("proxy.creds.unknownSize")
                        : `${Math.ceil(size / 1024)} KB`}
                    </span>
                    <span>{formatDateShort(file.modtime ?? file.updated_at ?? file.last_refresh)}</span>
                  </div>
                  {note ? (
                    <div className="mt-2.5 rounded-lg bg-oai-gray-50 px-2.5 py-1.5 text-xs dark:bg-oai-gray-800/60">
                      <span className="font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.creds.settings.note")}</span>
                      <p className="mt-0.5 break-words text-oai-gray-600 dark:text-oai-gray-300" title={note}>{note}</p>
                    </div>
                  ) : null}
                  <footer className="mt-3 flex flex-wrap items-center gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setSettingsName(name)}
                      disabled={busy || !isOauth}
                      title={isOauth ? copy("proxy.creds.settings.title") : copy("proxy.creds.fileOnly")}
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      {copy("proxy.creds.settings.button")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setModelViewName(name)}
                      disabled={busy}
                      title={copy("proxy.creds.models.viewTitle")}
                    >
                      {copy("proxy.creds.models.button")}
                    </Button>
                    <button
                      type="button"
                      onClick={() => void copyName(name)}
                      disabled={busy}
                      title={copy("proxy.creds.copyName")}
                      aria-label={copy("proxy.creds.copyName")}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-black disabled:opacity-50 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                    >
                      {copied === name ? <Check className="h-3.5 w-3.5 text-oai-brand-600" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    </button>
                    <Button
                      variant={disabled ? "primary" : "secondary"}
                      size="sm"
                      onClick={() => void toggleStatus(file)}
                      disabled={busy || !isOauth}
                      title={isOauth ? undefined : copy("proxy.creds.fileOnly")}
                      className="ml-auto"
                    >
                      {disabled ? copy("proxy.creds.action.enable") : copy("proxy.creds.action.disable")}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setDeleteFile(file)}
                      disabled={busy || runtimeOnly}
                      title={copy("proxy.upstream.common.delete")}
                      aria-label={copy("proxy.upstream.common.delete")}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-oai-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </Card>
      {runtimeCount > 0 ? (
        <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">
          {copy("proxy.creds.runtimeFootnote", { count: runtimeCount })}
        </p>
      ) : null}

      {settingsName ? (
        <CredentialSettingsDialog
          key={settingsName}
          name={settingsName}
          onClose={() => setSettingsName(null)}
          onSaved={() => {
            showToast(copy("proxy.creds.settings.updated", { name: settingsName }), "success");
            setSettingsName(null);
            void loadFiles(false);
          }}
        />
      ) : null}

      {modelViewName ? (
        <CredentialModelsDialog name={modelViewName} onClose={() => setModelViewName(null)} />
      ) : null}

      {oauthModelTarget ? (
        <OauthModelsDialog target={oauthModelTarget} onClose={() => setOauthModelTarget(null)} />
      ) : null}

      <ConfirmModal
        open={deleteFile !== null}
        title={copy("proxy.upstream.common.delete")}
        description={copy("proxy.creds.deleteConfirm", { name: deleteFile ? authFileName(deleteFile) : "" })}
        confirmLabel={copy("proxy.upstream.common.delete")}
        destructive
        busy={busy}
        onConfirm={() => void confirmDelete(deleteFile)}
        onCancel={() => setDeleteFile(null)}
      />
    </div>
  );
}

function formatDateShort(value) {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = typeof value === "number" ? value : Number(value);
  const timestamp = Number.isFinite(numeric) && numeric > 0
    ? (numeric < 1e12 ? numeric * 1000 : numeric)
    : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return String(value);
  return new Date(timestamp).toLocaleString([], {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
