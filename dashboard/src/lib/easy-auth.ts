// Ported interaction logic from EasyCLIProxyAPI's credential (auth file)
// module: src/services/authFiles.ts, oauthModels.ts, oauthModelSettings.ts,
// authFileSettings.ts, authFileHealth.ts, authFileRequests.ts. Function bodies
// mirror the originals so the dashboard behaves exactly like the desktop app;
// only the transport and message catalogue are AiTool-specific.

import { copy } from "./copy";
import { isRecord, managementApi, readBoolean, readNumber, readString, type ManagementJson } from "./easy-providers";

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

export type AuthFileRecord = Record<string, unknown>;

export const formatDate = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = typeof value === "number" ? value : Number(value);
  const timestamp = Number.isFinite(numeric) && numeric > 0
    ? (numeric < 1e12 ? numeric * 1000 : numeric)
    : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return String(value);
  return new Date(timestamp).toLocaleString([], {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
};

const text = (key: string, vars?: Record<string, string | number>) => copy(key, vars);

// ---------------------------------------------------------------------------
// authFiles.ts
// ---------------------------------------------------------------------------

export const authFileName = (file: AuthFileRecord) =>
  readString(file, "name") || text("proxy.creds.unnamed");

export const isRuntimeOnlyAuthFile = (file: AuthFileRecord) =>
  readBoolean(file, "runtime_only", "runtimeOnly");

export const isOAuthCredentialFile = (file: AuthFileRecord): boolean => {
  if (!readString(file, "name").toLowerCase().endsWith(".json") || isRuntimeOnlyAuthFile(file)) return false;
  const kinds = ["account_type", "auth_kind", "authKind"].map((key) =>
    readString(file, key).toLowerCase().replace(/[-_]/g, ""));
  if (kinds.includes("apikey")) return false;
  const source = readString(file, "source").toLowerCase();
  return !source || source === "file";
};

export const setOAuthCredentialFileDisabled = async (file: AuthFileRecord, disabled: boolean): Promise<void> => {
  if (!isOAuthCredentialFile(file)) {
    throw new Error(text("proxy.creds.fileOnly"));
  }
  await managementApi.patch("/auth-files/status", { name: readString(file, "name"), disabled });
};

export const parseAuthFilePriority = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return undefined;
  const priority = Number(normalized);
  return Number.isSafeInteger(priority) ? priority : undefined;
};

export const normalizeAuthFilePriorityInput = (value: string): number | null => {
  const normalized = value.trim();
  if (!normalized) return 0;
  return parseAuthFilePriority(normalized) ?? null;
};

const normalizeOAuthProvider = (value: string) => {
  const provider = value.trim().toLowerCase();
  if (provider === "cognition") return "devin";
  if (provider === "anthropic") return "claude";
  if (provider === "anti-gravity") return "antigravity";
  if (provider === "openai") return "codex";
  return provider;
};

const authFileProvider = (file: AuthFileRecord) =>
  normalizeOAuthProvider(readString(file, "provider", "type"));

export const oauthModelProvidersFromAuthFiles = (files: AuthFileRecord[]): string[] =>
  [...new Set(files.filter(isOAuthCredentialFile).map(authFileProvider).filter(Boolean))].sort();

export const providerKeyForFile = (file: AuthFileRecord) => {
  const value = readString(file, "provider", "type", "account_type").toLowerCase();
  if (value === "cognition") return "devin";
  return value === "anthropic" ? "claude" : value === "anti-gravity" ? "antigravity" : value;
};

export const providerLabelForFile = (file: AuthFileRecord) => {
  const value = readString(file, "provider", "type", "account_type").toLowerCase();
  if (value === "anthropic") return "Claude";
  if (value === "anti-gravity") return "Antigravity";
  if (value === "xai") return "xAI";
  if (value === "cognition") return "Devin";
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : text("proxy.creds.unknownProvider");
};

type AuthFileSnapshot = Map<string, string>;

export const snapshotAuthFiles = (files: AuthFileRecord[]): AuthFileSnapshot => {
  const grouped = new Map<string, string[]>();
  files.forEach((file) => {
    const name = readString(file, "name");
    if (!name) return;
    const fingerprints = grouped.get(name) ?? [];
    fingerprints.push(JSON.stringify(file));
    grouped.set(name, fingerprints);
  });
  return new Map(Array.from(grouped, ([name, fingerprints]) => [
    name,
    fingerprints.sort().join("\n"),
  ]));
};

export const changedOAuthAuthFileNames = (
  before: AuthFileSnapshot,
  files: AuthFileRecord[],
  provider: string,
) => {
  const expectedProvider = normalizeOAuthProvider(provider);
  const after = snapshotAuthFiles(files);
  const names = new Set<string>();
  files.forEach((file) => {
    const name = readString(file, "name");
    if (!name || authFileProvider(file) !== expectedProvider) return;
    const priority = parseAuthFilePriority(file.priority);
    if (priority !== undefined && priority !== 0) return;
    if (before.get(name) !== after.get(name)) names.add(name);
  });
  return Array.from(names);
};

const hasMeaningfulValue = (value: unknown) => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

const authFileTimestamp = (file: AuthFileRecord) => {
  for (const value of [file.modtime, file.updated_at, file.last_refresh]) {
    if (value === null || value === undefined || value === "") continue;
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = new Date(String(value)).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
};

const authFilePriority = (file: AuthFileRecord) => {
  let score = 0;
  if (readString(file, "source").toLowerCase() === "file") score += 32;
  if (readString(file, "path")) score += 16;
  if (!isRuntimeOnlyAuthFile(file)) score += 8;
  if (!readBoolean(file, "disabled")) score += 4;
  if (authFileTimestamp(file) > 0) score += 2;
  return score;
};

const authFileSourceFields = new Set([
  "source", "path", "runtime_only", "runtimeOnly", "account_type", "auth_kind", "authKind",
]);

const mergeDuplicateAuthFiles = (entries: AuthFileRecord[]) => {
  const sorted = [...entries].sort((left, right) => {
    const priority = authFilePriority(right) - authFilePriority(left);
    if (priority !== 0) return priority;
    const timestamp = authFileTimestamp(right) - authFileTimestamp(left);
    if (timestamp !== 0) return timestamp;
    return Object.values(right).filter(hasMeaningfulValue).length
      - Object.values(left).filter(hasMeaningfulValue).length;
  });
  const merged = { ...sorted[0] };
  sorted.slice(1).forEach((entry) => {
    Object.entries(entry).forEach(([key, value]) => {
      if (authFileSourceFields.has(key)) return;
      if (key === "cooldowns" && Object.prototype.hasOwnProperty.call(merged, key)) return;
      if (!hasMeaningfulValue(merged[key]) && hasMeaningfulValue(value)) merged[key] = value;
    });
  });
  return merged;
};

export const dedupeAuthFiles = (files: AuthFileRecord[]) => {
  const grouped = new Map<string, AuthFileRecord[]>();
  files.forEach((file, index) => {
    const key = authFileName(file) || `unnamed-${index}`;
    const entries = grouped.get(key) ?? [];
    entries.push(file);
    grouped.set(key, entries);
  });
  return Array.from(grouped.values())
    .map(mergeDuplicateAuthFiles)
    .sort((left, right) =>
      authFileName(left).localeCompare(authFileName(right), undefined, { sensitivity: "base" }),
    );
};

// ---------------------------------------------------------------------------
// oauthModels.ts
// ---------------------------------------------------------------------------

export type OAuthModelDefinition = {
  id: string;
  displayName?: string;
};

export const oauthModelsFromPayload = (payload: unknown): OAuthModelDefinition[] => {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return [];
  const seen = new Set<string>();
  return payload.models.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = readString(item, "id", "name");
    const key = id.toLowerCase();
    if (!id || seen.has(key)) return [];
    seen.add(key);
    const displayName = readString(item, "display_name", "displayName");
    return [{ id, displayName: displayName && displayName !== id ? displayName : undefined }];
  });
};

export const oauthExcludedRulesFromPayload = (payload: unknown, provider: string): string[] => {
  if (!isRecord(payload)) return [];
  const source = isRecord(payload["oauth-excluded-models"])
    ? payload["oauth-excluded-models"]
    : payload;
  const value = source[provider.trim().toLowerCase()];
  if (!Array.isArray(value)) return [];
  return value
    .map(String)
    .map((rule) => rule.trim().toLowerCase())
    .filter((rule, index, rules) => rule && rules.indexOf(rule) === index);
};

const wildcardPattern = (rule: string) => new RegExp(
  `^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  "i",
);

export const modelMatchesRule = (modelId: string, rule: string) => {
  const normalizedRule = rule.trim();
  if (!normalizedRule) return false;
  return wildcardPattern(normalizedRule).test(modelId.trim());
};

export const openOAuthModelNames = (
  models: OAuthModelDefinition[],
  excludedRules: Iterable<string>,
) => {
  const rules = Array.from(excludedRules, (rule) => rule.trim()).filter(Boolean);
  return new Set(
    models
      .filter((model) => !rules.some((rule) => modelMatchesRule(model.id, rule)))
      .map((model) => model.id.toLowerCase()),
  );
};

export const normalizeOAuthExcludedRules = (rules: Iterable<string>): string[] =>
  [...new Set(Array.from(rules, (rule) => rule.trim().toLowerCase()).filter(Boolean))];

export const oauthModelCandidates = (
  models: OAuthModelDefinition[],
  rules: Iterable<string>,
): OAuthModelDefinition[] => {
  const candidates = new Map(models.map((model) => [model.id.toLowerCase(), model]));
  for (const rule of normalizeOAuthExcludedRules(rules)) {
    if (!rule.includes("*") && !candidates.has(rule)) candidates.set(rule, { id: rule });
  }
  return [...candidates.values()].sort((left, right) => left.id.localeCompare(right.id));
};

export const setOAuthModelsExcluded = (
  rules: Iterable<string>,
  models: OAuthModelDefinition[],
  excluded: boolean,
): string[] => {
  const normalized = normalizeOAuthExcludedRules(rules);
  if (excluded) return normalizeOAuthExcludedRules([...normalized, ...models.map((model) => model.id)]);
  const modelIds = new Set(models.map((model) => model.id.toLowerCase()));
  return normalized.filter((rule) => rule.includes("*") || !modelIds.has(rule));
};

// ---------------------------------------------------------------------------
// oauthModelSettings.ts
// ---------------------------------------------------------------------------

export type OAuthModelTarget = { provider: string; label: string } & (
  | { scope: "credential"; name: string }
  | { scope: "provider" }
);

export type OAuthModelSettings = {
  target: OAuthModelTarget;
  models: OAuthModelDefinition[];
  excludedRules: string[];
  catalogError: string;
};

export const authFileExcludedRulesFromPayload = (payload: unknown): string[] => {
  let metadata = payload;
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      throw new Error(text("proxy.creds.models.invalidMetadata"));
    }
  }
  if (!isRecord(metadata)) {
    throw new Error(text("proxy.creds.models.invalidMetadata"));
  }
  const rules = Object.prototype.hasOwnProperty.call(metadata, "excluded_models")
    ? metadata.excluded_models
    : metadata["excluded-models"];
  if (rules === undefined || rules === null) return [];
  if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== "string")) {
    throw new Error(text("proxy.creds.models.invalidExclusions"));
  }
  return normalizeOAuthExcludedRules(rules);
};

export const loadOAuthModelSettings = async (target: OAuthModelTarget): Promise<OAuthModelSettings> => {
  const [catalog, payload] = await Promise.all([
    (target.scope === "credential"
      ? managementApi.get("/auth-files/models", { name: target.name })
      : managementApi.get(`/model-definitions/${encodeURIComponent(target.provider)}`))
      .then((definitions) => ({ models: oauthModelsFromPayload(definitions), error: "" }))
      .catch((error: unknown) => ({ models: [] as OAuthModelDefinition[], error: String(error) })),
    target.scope === "credential"
      ? managementApi.get("/auth-files/download", { name: target.name })
      : managementApi.get("/oauth-excluded-models"),
  ]);
  const excludedRules = target.scope === "credential"
    ? authFileExcludedRulesFromPayload(payload)
    : oauthExcludedRulesFromPayload(payload, target.provider);
  return {
    target,
    models: oauthModelCandidates(catalog.models, excludedRules),
    excludedRules,
    catalogError: catalog.error,
  };
};

export const saveOAuthModelSettings = async (
  settings: OAuthModelSettings,
  rules: Iterable<string>,
): Promise<void> => {
  const excludedModels = normalizeOAuthExcludedRules(rules);
  if (excludedModels.length === settings.excludedRules.length
    && excludedModels.every((rule) => settings.excludedRules.includes(rule))) return;
  if (settings.target.scope === "credential") {
    await managementApi.patch("/auth-files/fields", {
      name: settings.target.name,
      excluded_models: excludedModels,
    });
  } else if (excludedModels.length > 0) {
    await managementApi.patch("/oauth-excluded-models", {
      provider: settings.target.provider,
      models: excludedModels,
    });
  } else if (settings.excludedRules.length > 0) {
    await managementApi.delete("/oauth-excluded-models", { query: { provider: settings.target.provider } });
  }
};

// ---------------------------------------------------------------------------
// authFileSettings.ts
// ---------------------------------------------------------------------------

export type BooleanOverride = "" | "true" | "false";
export type AuthFileSettingsDraft = {
  prefix: string;
  proxy_url: string;
  priority: string;
  weight: string;
  disable_cooling: BooleanOverride;
  websockets: BooleanOverride;
  excluded_models: string;
  headers: string;
  note: string;
};

const fail = (key: "metadata" | "headers" | "weight" | "priority") => {
  throw new Error(text(`proxy.creds.settings.invalid.${key}`));
};

const override = (value: unknown, allowNumber = false): BooleanOverride => {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (allowNumber && typeof value === "number" && Number.isFinite(value)) return value !== 0 ? "true" : "false";
  if (typeof value === "string") {
    if (["1", "t", "T", "TRUE", "true", "True"].includes(value.trim())) return "true";
    if (["0", "f", "F", "FALSE", "false", "False"].includes(value.trim())) return "false";
  }
  return "";
};

const headersFromText = (input: string): Record<string, string> => {
  let value: unknown;
  try { value = JSON.parse(input.trim() || "{}"); } catch { return fail("headers"); }
  if (!isRecord(value)) return fail("headers");
  const names = new Set<string>();
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const name = key.trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || typeof item !== "string"
      || /[\r\n\0]/.test(item) || names.has(name.toLowerCase())) return fail("headers");
    names.add(name.toLowerCase());
    if (item.trim()) result[name] = item.trim();
  }
  return result;
};

export const authFileSettingsFromPayload = (payload: unknown): AuthFileSettingsDraft => {
  let metadata = payload;
  if (typeof metadata === "string") {
    try { metadata = JSON.parse(metadata); } catch { return fail("metadata"); }
  }
  if (!isRecord(metadata)) return fail("metadata");
  const read = (key: string, legacy?: string) => Object.prototype.hasOwnProperty.call(metadata, key)
    ? metadata[key] : legacy ? metadata[legacy] : undefined;
  const asText = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "";
  const headers = metadata.headers == null ? {} : metadata.headers;
  if (!isRecord(headers) || Object.values(headers).some((value) => typeof value !== "string")) return fail("headers");
  return {
    prefix: asText(metadata.prefix),
    proxy_url: asText(read("proxy_url", "proxy-url")),
    priority: asText(metadata.priority),
    weight: asText(metadata.weight),
    disable_cooling: override(read("disable_cooling", "disable-cooling"), true),
    websockets: override(read("websockets", "websocket")),
    excluded_models: authFileExcludedRulesFromPayload(metadata).join("\n"),
    headers: JSON.stringify(headers, null, 2),
    note: asText(metadata.note),
  };
};

export const buildAuthFileSettingsPatch = (
  original: AuthFileSettingsDraft,
  draft: AuthFileSettingsDraft,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  for (const key of ["prefix", "proxy_url", "note"] as const) {
    if (draft[key].trim() !== original[key].trim()) patch[key] = draft[key].trim();
  }
  if (draft.priority !== original.priority) {
    const value = normalizeAuthFilePriorityInput(draft.priority);
    if (value === null) return fail("priority");
    if (value !== normalizeAuthFilePriorityInput(original.priority)) patch.priority = value;
  }
  if (draft.weight !== original.weight) {
    const asTextValue = draft.weight.trim();
    const value = asTextValue ? Number(asTextValue) : null;
    if (value !== null && (!/^-?\d+$/.test(asTextValue) || !Number.isSafeInteger(value) || value > 1_000_000)) return fail("weight");
    const normalized = value === null ? null : Math.max(0, value);
    const previous = original.weight.trim() ? Math.max(0, Number(original.weight)) : null;
    if (normalized !== previous) patch.weight = normalized;
  }
  for (const key of ["disable_cooling", "websockets"] as const) {
    if (draft[key] !== original[key]) patch[key] = draft[key] === "" ? null : draft[key] === "true";
  }
  const rules = (input: string) => normalizeOAuthExcludedRules(input.split(/\r?\n/));
  const nextRules = rules(draft.excluded_models);
  if (JSON.stringify([...nextRules].sort()) !== JSON.stringify(rules(original.excluded_models).sort())) {
    patch.excluded_models = nextRules;
  }
  if (draft.headers !== original.headers) {
    const previous = headersFromText(original.headers);
    const next = headersFromText(draft.headers);
    const headers: Record<string, string> = Object.create(null);
    for (const name of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (previous[name] !== next[name]) headers[name] = next[name] ?? "";
    }
    if (Object.keys(headers).length) patch.headers = headers;
  }
  return patch;
};

export const loadAuthFileSettings = async (name: string): Promise<AuthFileSettingsDraft> =>
  authFileSettingsFromPayload(await managementApi.get("/auth-files/download", { name }));

export const saveAuthFileSettings = async (
  name: string, original: AuthFileSettingsDraft, draft: AuthFileSettingsDraft,
): Promise<boolean> => {
  const patch = buildAuthFileSettingsPatch(original, draft);
  if (!Object.keys(patch).length) return false;
  await managementApi.patch("/auth-files/fields", { name, ...patch });
  return true;
};

// ---------------------------------------------------------------------------
// authFileHealth.ts
// ---------------------------------------------------------------------------

export type AuthFileCooldown = {
  scope: "credential" | "model";
  model?: string;
  reason: string;
  retryAt: string;
  remainingSeconds: number;
  httpStatus?: number;
  backoffLevel?: number;
};

export type AuthFileCooldownSnapshot = {
  receivedAtMs: number;
  observedAt?: string;
  records: AuthFileCooldown[] | null;
};

export type AuthFileHealth = {
  label: string;
  tone: "success" | "warning" | "error" | "neutral" | "info";
  message: string;
  status: string;
  disabled: boolean;
};

const reasonKeys: Record<string, string> = {
  quota: "proxy.creds.health.reason.quota",
  credential_quota: "proxy.creds.health.reason.credentialQuota",
  cloudflare_challenge: "proxy.creds.health.reason.cloudflare",
  invalid_grant: "proxy.creds.health.reason.invalidGrant",
  unauthorized: "proxy.creds.health.reason.unauthorized",
  payment_required: "proxy.creds.health.reason.accessDenied",
  not_found: "proxy.creds.health.reason.notFound",
  model_not_supported: "proxy.creds.health.reason.modelUnsupported",
  transient_error: "proxy.creds.health.reason.upstream",
  token_expired: "proxy.creds.health.reason.tokenExpired",
};

export function cooldownReasonKey(reason: string): string {
  return Object.prototype.hasOwnProperty.call(reasonKeys, reason)
    ? reasonKeys[reason] : "proxy.creds.health.reason.unknown";
}

export function cooldownTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : undefined;
}

function normalizeCooldown(value: unknown): AuthFileCooldown | null {
  if (!isRecord(value)) return null;
  const scope = value.scope;
  const model = typeof value.model_key === "string" ? value.model_key.trim() : "";
  const retryAt = cooldownTimestamp(value.retry_at);
  const remainingSeconds = value.remaining_seconds;
  if ((scope !== "credential" && scope !== "model") || (scope === "model" && !model)
    || !retryAt || typeof remainingSeconds !== "number"
    || !Number.isSafeInteger(remainingSeconds) || remainingSeconds <= 0
    || remainingSeconds > Number.MAX_SAFE_INTEGER / 1000) return null;
  const httpStatus = value.http_status;
  const backoffLevel = value.backoff_level;
  return {
    scope,
    ...(scope === "model" ? { model } : {}),
    retryAt,
    remainingSeconds,
    reason: readString(value, "reason") || "unknown",
    ...(typeof httpStatus === "number" && Number.isInteger(httpStatus)
      && httpStatus >= 400 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(typeof backoffLevel === "number" && Number.isSafeInteger(backoffLevel)
      && backoffLevel >= 0 ? { backoffLevel } : {}),
  };
}

export function normalizeAuthFileCooldowns(
  value: unknown,
  receivedAtMs: number,
  observedAt?: string,
): AuthFileCooldownSnapshot | undefined {
  if (value === undefined) return undefined;
  const snapshot = { receivedAtMs, observedAt: cooldownTimestamp(observedAt) };
  if (!Array.isArray(value)) return { ...snapshot, records: null };
  const records = value.map(normalizeCooldown);
  if (records.some((record) => record === null)) return { ...snapshot, records: null };
  return { ...snapshot, records: records as AuthFileCooldown[] };
}

export function summarizeAuthFileCooldowns(snapshot: AuthFileCooldownSnapshot | undefined, nowMs: number) {
  const elapsedSeconds = snapshot ? Math.max(0, nowMs - snapshot.receivedAtMs) / 1000 : 0;
  const rows = (snapshot?.records ?? []).map((record) => ({
    record,
    remainingSeconds: Math.max(0, Math.ceil(record.remainingSeconds - elapsedSeconds)),
  }));
  const active = rows.filter((row) => row.remainingSeconds > 0);
  return {
    rows,
    active,
    modelCount: new Set(active.filter(({ record }) => record.scope === "model").map(({ record }) => record.model)).size,
    credentialWide: active.some(({ record }) => record.scope === "credential"),
    earliestSeconds: active.length ? Math.min(...active.map((row) => row.remainingSeconds)) : 0,
    elapsed: rows.length > 0 && active.length === 0,
  };
}

const healthyMessages = new Set(["ok", "healthy", "ready", "success", "available", "active"]);
const messageReasons: Record<string, string> = {
  "quota exhausted": "quota",
  "cloudflare challenge": "cloudflare_challenge",
  "token expired": "token_expired",
  "transient upstream error": "transient_error",
};

export function authFileHealth(file: Record<string, unknown>): AuthFileHealth {
  const status = readString(file, "status").toLowerCase();
  const rawMessage = readString(file, "status_message", "statusMessage");
  const message = healthyMessages.has(rawMessage.toLowerCase()) ? "" : rawMessage;
  const disabled = readBoolean(file, "disabled") || status === "disabled";
  const base = { status, message, disabled };
  if (disabled) return { ...base, label: "proxy.creds.status.disabled", tone: "neutral" };
  if (readBoolean(file, "unavailable") || status === "error") {
    const marker = message.toLowerCase();
    const reason = Object.prototype.hasOwnProperty.call(messageReasons, marker) ? messageReasons[marker] : marker;
    const reasonKey = cooldownReasonKey(reason);
    return {
      ...base,
      label: reasonKey !== "proxy.creds.health.reason.unknown" ? reasonKey
        : readBoolean(file, "unavailable") ? "proxy.creds.status.unavailable" : "proxy.creds.health.error",
      tone: "error",
    };
  }
  if (status === "refreshing") return { ...base, label: "proxy.creds.health.refreshing", tone: "info" };
  if (status === "pending") return { ...base, label: "proxy.creds.health.pending", tone: "warning" };
  if (message) return { ...base, label: "proxy.creds.health.warning", tone: "warning" };
  if (status === "active" || status === "ready") return { ...base, label: "proxy.creds.health.active", tone: "success" };
  return { ...base, label: "proxy.creds.health.unknown", tone: "neutral" };
}

// ---------------------------------------------------------------------------
// authFileRequests.ts
// ---------------------------------------------------------------------------

export const AUTH_REQUEST_BUCKET_COUNT = 20;

export type AuthRequestBucket = {
  time: string;
  success: number;
  failure: number;
  rate: number | null;
};

export type AuthFileRequestStats = {
  success: number | null;
  failure: number | null;
  recentAvailable: boolean;
  buckets: AuthRequestBucket[];
  recentSuccess: number;
  recentFailure: number;
  recentRate: number | null;
};

function requestCount(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function authFileRequestStats(file: Record<string, unknown>): AuthFileRequestStats {
  const recent = file.recent_requests ?? file.recentRequests;
  const recentAvailable = Array.isArray(recent);
  const buckets: AuthRequestBucket[] = (recentAvailable ? recent : [])
    .slice(-AUTH_REQUEST_BUCKET_COUNT)
    .map((value: unknown) => {
      const bucket = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
      const success = requestCount(bucket.success) ?? 0;
      const failure = requestCount(bucket.failed) ?? 0;
      return {
        time: typeof bucket.time === "string" ? bucket.time.trim() : "",
        success,
        failure,
        rate: success + failure > 0 ? success / (success + failure) : null,
      };
    });
  while (buckets.length < AUTH_REQUEST_BUCKET_COUNT) {
    buckets.unshift({ time: "", success: 0, failure: 0, rate: null });
  }
  const recentSuccess = buckets.reduce((total, bucket) => total + bucket.success, 0);
  const recentFailure = buckets.reduce((total, bucket) => total + bucket.failure, 0);
  return {
    success: requestCount(file.success ?? file.successCount),
    failure: requestCount(file.failed ?? file.failureCount),
    recentAvailable,
    buckets,
    recentSuccess,
    recentFailure,
    recentRate: recentSuccess + recentFailure > 0
      ? recentSuccess / (recentSuccess + recentFailure) : null,
  };
}

export function requestRateColor(rate: number): string {
  const stops = [[239, 68, 68], [250, 204, 21], [34, 197, 94]];
  const normalized = Math.max(0, Math.min(1, rate));
  const segment = normalized < 0.5 ? 0 : 1;
  const progress = segment === 0 ? normalized * 2 : (normalized - 0.5) * 2;
  const color = stops[segment].map((value, index) =>
    Math.round(value + (stops[segment + 1][index] - value) * progress));
  return `rgb(${color.join(", ")})`;
}

// ---------------------------------------------------------------------------
// auth file listing transport (AuthFileManagementPage loadFiles)
// ---------------------------------------------------------------------------

export type AuthFileSnapshotPayload = {
  files: AuthFileRecord[];
  receivedAtMs: number;
  observedAt?: string;
};

export async function fetchAuthFiles(): Promise<AuthFileSnapshotPayload> {
  const payload = (await managementApi.get<ManagementJson>("/auth-files")) as unknown;
  const rows = isRecord(payload) && Array.isArray(payload.files)
    ? payload.files
    : Array.isArray(payload) ? payload : [];
  return {
    files: dedupeAuthFiles(rows.filter(isRecord)),
    receivedAtMs: Date.now(),
    observedAt: isRecord(payload) ? readString(payload, "observed_at") || undefined : undefined,
  };
}
