// Ported interaction logic from EasyCLIProxyAPI's API 接入 module
// (src/services/managementApi.ts, modelService.ts, providerModels.ts,
// providerHealthCheck.ts and the pure helpers of ApiAccessPage.tsx).
// The function bodies mirror the originals so the dashboard behaves
// exactly like the desktop app; only the transport (Tauri invoke →
// /api/proxy/management-request) and the message catalogue (copy.csv)
// are AiTool-specific.

import { getLocalApiAuthHeaders } from "./local-api-auth";
import { copy } from "./copy";

// ---------------------------------------------------------------------------
// primitives (managementApi.ts)
// ---------------------------------------------------------------------------

export type ManagementJson = Record<string, unknown> | unknown[] | string | number | boolean | null;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown, ...keys: string[]): string {
  if (!isRecord(value)) return "";
  for (const key of keys) {
    const candidate = value[key];
    if (candidate === undefined || candidate === null) continue;
    const text = String(candidate).trim();
    if (text) return text;
  }
  return "";
}

export function readBoolean(value: unknown, ...keys: string[]): boolean {
  if (!isRecord(value)) return false;
  for (const key of keys) {
    if (typeof value[key] === "boolean") return value[key] as boolean;
  }
  return false;
}

export function readNumber(value: unknown, ...keys: string[]): number | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const candidate = value[key];
    const parsed = typeof candidate === "number" ? candidate : Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function responseList(payload: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(payload) || !Array.isArray(payload[key])) return [];
  return payload[key].filter(isRecord);
}

export function maskSecret(value: string): string {
  const normalized = value.trim();
  if (!normalized) return copy("proxy.upstream.notConfigured");
  if (normalized.length <= 8) return `${normalized.slice(0, 2)}••••`;
  return `${normalized.slice(0, 4)}••••${normalized.slice(-4)}`;
}

// Original i18n keys → TokenTracker copy keys ({{var}} interpolation).
const MESSAGES: Record<string, string> = {
  "aliases.error.invalidAlias": "proxy.upstream.error.invalidAlias",
  "model.error.baseUrlRequired": "proxy.upstream.error.baseUrlRequired",
  "model.error.invalidBaseUrl": "proxy.upstream.error.invalidBaseUrl",
  "model.error.unsupportedBaseUrl": "proxy.upstream.error.unsupportedBaseUrl",
  "model.error.noResponse": "proxy.upstream.error.noResponse",
  "apiAccess.error.headerMissingColon": "proxy.upstream.error.headerMissingColon",
  "apiAccess.error.headerInvalid": "proxy.upstream.error.headerInvalid",
  "apiAccess.error.priorityInteger": "proxy.upstream.error.priorityInteger",
  "management.notConfigured": "proxy.upstream.notConfigured",
  "management.error.upstream": "proxy.upstream.error.upstream",
  "management.error.upstreamHttp": "proxy.upstream.error.upstreamHttp",
};

const text = (key: string, vars?: Record<string, string | number>) =>
  copy(MESSAGES[key] ?? key, vars);

// ---------------------------------------------------------------------------
// management transport (managementApi.ts request())
// ---------------------------------------------------------------------------

type ManagementRequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: ManagementJson;
  timeoutMs?: number;
};

const normalizeQuery = (
  query?: ManagementRequestOptions["query"],
): Record<string, string> | undefined => {
  if (!query) return undefined;
  const normalized = Object.entries(query).reduce<Record<string, string>>((result, [key, value]) => {
    if (value !== undefined) result[key] = String(value);
    return result;
  }, {});
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

async function invokeManagement<T>(request: {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: ManagementJson;
  timeoutMs?: number;
}): Promise<T> {
  const headers = await getLocalApiAuthHeaders();
  const response = await fetch("/api/proxy/management-request", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ request }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { ok: boolean; value?: unknown; error?: string }
    | null;
  if (!payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload.value as T;
}

export async function managementRequest<T>(
  method: string,
  path: string,
  options: ManagementRequestOptions = {},
): Promise<T> {
  return invokeManagement<T>({
    method,
    path,
    query: normalizeQuery(options.query),
    body: options.body,
    timeoutMs: options.timeoutMs,
  });
}

async function optionalConfigValue(path: string, fallback: ManagementJson, options: ManagementRequestOptions): Promise<unknown> {
  try {
    return await invokeManagement<unknown>({
      method: "GET",
      path,
      query: normalizeQuery(options.query),
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    // Only an absent v8 config node is optional, not an unavailable endpoint or server.
    const message = error instanceof Error ? error.message : error;
    if (message === "Management API error (404): not_found") return fallback;
    throw error;
  }
}

const PROVIDER_PATHS = {
  "/gemini-api-key": { provider: "gemini", legacy: "gemini-api-key" },
  "/interactions-api-key": { provider: "interactions", legacy: "interactions-api-key" },
  "/vertex-api-key": { provider: "vertex", legacy: "vertex-api-key" },
  "/codex-api-key": { provider: "codex", legacy: "codex-api-key" },
  "/claude-api-key": { provider: "claude", legacy: "claude-api-key" },
  "/xai-api-key": { provider: "xai", legacy: "xai-api-key" },
  "/meta-api-key": { provider: "meta", legacy: "meta-api-key" },
  "/openai-compatibility": { provider: "openai-compatibility", legacy: "openai-compatibility" },
} as const;

type ProviderPath = keyof typeof PROVIDER_PATHS;

const SHARED_PROVIDER_FIELDS = new Set([
  "priority",
  "prefix",
  "proxy-url",
  "headers",
  "models",
  "excluded-models",
  "disable-cooling",
  "request-retry",
  "request-scoped-errors",
]);

const providerDefinition = (path: string) => PROVIDER_PATHS[path as ProviderPath];

export function flattenV8ProviderGroups(provider: string, payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(isRecord).flatMap((group) => {
    const keys = Array.isArray(group.keys) ? group.keys.filter(isRecord) : [];
    if (provider === "openai-compatibility") {
      const record: Record<string, unknown> = { ...group };
      delete record.keys;
      delete record["test-model"];
      delete record.testModel;
      if (keys.length > 0) record["api-key-entries"] = keys.map((key) => ({ ...key }));
      return [normalizeProviderModels(record)];
    }
    const shared = Object.fromEntries(
      Object.entries(group).filter(([key]) => key === "base-url" || SHARED_PROVIDER_FIELDS.has(key)),
    );
    const name = readString(group, "name");
    const generatedName = name.startsWith(`${provider}-`) && /^[0-9]+$/.test(name.slice(provider.length + 1));
    if (name && !generatedName) shared.name = name;
    return keys.map((key) => {
      const overrides = Object.fromEntries(Object.entries(key).filter(([, value]) => value !== null));
      return normalizeProviderModels({ ...shared, ...overrides });
    });
  });
}

export function groupLegacyProviderRecords(provider: string, payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(isRecord).map((input, index) => {
    const record = normalizeProviderModels(input);
    if (provider === "openai-compatibility") {
      const group: Record<string, unknown> = {
        ...record,
        keys: Array.isArray(record["api-key-entries"])
          ? record["api-key-entries"].filter(isRecord).map((key) => ({ ...key }))
          : [],
      };
      delete group["api-key-entries"];
      delete group["test-model"];
      delete group.testModel;
      return group;
    }
    const group: Record<string, unknown> = { name: readString(record, "name") || `${provider}-${index + 1}` };
    const key: Record<string, unknown> = {};
    Object.entries(record).forEach(([field, value]) => {
      if (field === "name") return;
      if (field === "base-url" || SHARED_PROVIDER_FIELDS.has(field)) group[field] = value;
      else if (value !== null) key[field] = value;
    });
    if (Object.keys(key).length > 0) group.keys = [key];
    return group;
  });
}

function legacyManagementConfigView(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const legacy: Record<string, unknown> = { ...payload };
  const upstream = isRecord(payload["api-keys"]) ? payload["api-keys"] : {};
  Object.values(PROVIDER_PATHS).forEach(({ provider, legacy: legacyKey }) => {
    legacy[legacyKey] = flattenV8ProviderGroups(provider, upstream[provider]);
  });
  const access = isRecord(payload.access) ? payload.access : null;
  if (access && Array.isArray(access["api-keys"])) legacy["api-keys"] = access["api-keys"];
  const oauth = isRecord(payload.oauth) ? payload.oauth : null;
  if (oauth && oauth["model-alias"] !== undefined) legacy["oauth-model-alias"] = oauth["model-alias"];
  const requests = isRecord(payload.requests) ? payload.requests : null;
  if (requests && requests.payload !== undefined) legacy.payload = requests.payload;
  return legacy;
}

async function request<T>(method: string, path: string, options: ManagementRequestOptions = {}): Promise<T> {
  if (path === "/oauth-excluded-models") {
    if (method === "PATCH" && isRecord(options.body)) {
      const provider = readString(options.body, "provider");
      if (!provider || !Array.isArray(options.body.models)) {
        throw new Error("Invalid OAuth model exclusion update");
      }
      return invokeManagement<T>({
        method: "PUT",
        path: `/config/oauth/excluded-models/${encodeURIComponent(provider)}`,
        body: options.body.models as ManagementJson,
      });
    }
    if (method === "DELETE") {
      const provider = options.query?.provider;
      if (typeof provider !== "string" || !provider.trim()) {
        throw new Error("Invalid OAuth model exclusion delete");
      }
      return invokeManagement<T>({
        method: "DELETE",
        path: `/config/oauth/excluded-models/${encodeURIComponent(provider.trim())}`,
      });
    }
    if (method === "GET") {
      const exclusions = await optionalConfigValue("/config/oauth/excluded-models", {}, options);
      return { "oauth-excluded-models": exclusions } as T;
    }
  }
  const definition = providerDefinition(path);
  if (method === "GET" && definition) {
    const groups = await optionalConfigValue(`/config/api-keys/${definition.provider}`, [], options);
    return { [definition.legacy]: flattenV8ProviderGroups(definition.provider, groups) } as T;
  }
  if (method === "PATCH" && path === "/openai-compatibility" && isRecord(options.body)) {
    const index = Number(options.body.index);
    const value = options.body.value;
    if (!Number.isInteger(index) || index < 0 || !isRecord(value)) {
      throw new Error("Invalid OpenAI compatibility update");
    }
    const groups = await invokeManagement<unknown>({ method: "GET", path: "/config/api-keys/openai-compatibility" });
    const records = flattenV8ProviderGroups("openai-compatibility", groups);
    if (!records[index]) throw new Error("OpenAI compatibility entry no longer exists");
    records[index] = { ...records[index], ...value };
    return invokeManagement<T>({
      method: "PUT",
      path: "/config/api-keys/openai-compatibility",
      body: groupLegacyProviderRecords("openai-compatibility", records) as ManagementJson,
    });
  }

  let apiPath = path;
  let body = options.body;
  if (definition) {
    apiPath = `/config/api-keys/${definition.provider}`;
    if (method === "PUT" || method === "PATCH") {
      body = groupLegacyProviderRecords(definition.provider, body) as ManagementJson;
    }
  } else if (path === "/api-call") {
    apiPath = "/requests/api-call";
  } else if (path === "/oauth-session") {
    apiPath = "/oauth/session";
  } else if (path.startsWith("/auth-files")) {
    apiPath = `/credentials${path.slice("/auth-files".length)}`;
  } else if (path.startsWith("/model-definitions/")) {
    apiPath = `/routing${path}`;
  }

  const payload = await invokeManagement<unknown>({
    method,
    path: apiPath,
    query: normalizeQuery(options.query),
    body,
    timeoutMs: options.timeoutMs,
  });
  if (method === "GET" && path === "/config") {
    return legacyManagementConfigView(payload) as T;
  }
  return payload as T;
}

export const managementApi = {
  get: <T = ManagementJson>(path: string, query?: ManagementRequestOptions["query"]) =>
    request<T>("GET", path, { query }),
  post: <T = ManagementJson>(
    path: string,
    body?: ManagementJson,
    options: Pick<ManagementRequestOptions, "timeoutMs"> = {},
  ) => request<T>("POST", path, { ...options, body }),
  put: <T = ManagementJson>(path: string, body?: ManagementJson) => request<T>("PUT", path, { body }),
  patch: <T = ManagementJson>(path: string, body?: ManagementJson) => request<T>("PATCH", path, { body }),
  delete: <T = ManagementJson>(path: string, options: { query?: ManagementRequestOptions["query"] } = {}) =>
    request<T>("DELETE", path, { query: options.query }),
};

const messageFromPayload = (value: unknown, depth = 0): string => {
  if (value === null || value === undefined || depth > 3) return "";
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return "";
    try {
      const nested = messageFromPayload(JSON.parse(raw), depth + 1);
      if (nested) return nested;
    } catch {}
    return raw;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = messageFromPayload(item, depth + 1);
      if (nested) return nested;
    }
    return "";
  }
  if (isRecord(value)) {
    for (const key of ["message", "error", "detail", "error_description", "title"]) {
      const nested = messageFromPayload(value[key], depth + 1);
      if (nested) return nested;
    }
  }
  return "";
};

export function apiCallErrorMessage(
  response: Record<string, unknown>,
  fallback = text("management.error.upstream"),
): string {
  const status = Number(response.status_code ?? response.statusCode ?? 0);
  const message = messageFromPayload(response.body ?? response.bodyText);
  if (message) return message;
  return status > 0 ? text("management.error.upstreamHttp", { status }) : fallback;
}

// ---------------------------------------------------------------------------
// providerModels.ts
// ---------------------------------------------------------------------------

export function normalizeThinkingConfig(value: Record<string, unknown>, discovered = false) {
  const next = { ...value };
  for (const [json, yaml] of [["zero_allowed", "zero-allowed"], ["dynamic_allowed", "dynamic-allowed"]]) {
    if (!(yaml in next) && json in next) next[yaml] = next[json];
    delete next[json];
  }
  if (!discovered) return next;
  return Object.fromEntries(Object.entries(next).filter(([key, item]) => {
    if (key === "min" || key === "max") return Number.isSafeInteger(item) && Number(item) >= 0;
    if (key === "zero-allowed" || key === "dynamic-allowed") return typeof item === "boolean";
    return key === "levels" && Array.isArray(item) && item.every((level) => typeof level === "string");
  }));
}

export function normalizeProviderModels(record: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(record.models)) return { ...record };
  return {
    ...record,
    models: record.models.map((model) => (
      isRecord(model) && isRecord(model.thinking)
        ? { ...model, thinking: normalizeThinkingConfig(model.thinking) }
        : model
    )),
  };
}

// ---------------------------------------------------------------------------
// modelService.ts
// ---------------------------------------------------------------------------

export type ModelOption = {
  name: string;
  alias?: string;
  displayName?: string;
  isAlias?: boolean;
  contextWindow?: number;
  inputModalities?: Array<"text" | "image">;
  thinking?: Record<string, unknown>;
};
export type ModelProvider = "gemini" | "codex" | "deepseek" | "claude" | "openai";
export type ModelSelectionMode = "initial" | "refresh";

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_CLAUDE_BASE_URL = "https://api.anthropic.com";
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

const modelKey = (name: string) => name.trim().toLowerCase();

export function usableModelAlias(value: string | undefined | null): string {
  const alias = value?.trim() ?? "";
  if (!alias || alias.length > 240) return "";
  for (const character of alias) {
    const code = character.charCodeAt(0);
    if (character.trim() === "" || code < 32 || code === 127) return "";
  }
  return alias;
}

export function modelSearchText(model: Pick<ModelOption, "name" | "alias" | "displayName">): string {
  return [model.name, model.alias, model.displayName].filter(Boolean).join(" ").toLowerCase();
}

export function mergeModelOptions(...groups: ModelOption[][]): ModelOption[] {
  const merged = new Map<string, ModelOption>();
  groups.flat().forEach((model) => {
    const name = model.name.trim();
    if (!name) return;
    const previous = merged.get(modelKey(name));
    const next: ModelOption = { ...previous, ...model, name };
    const alias = (model.alias ?? "").trim() || previous?.alias;
    const displayName = (model.displayName ?? "").trim() || previous?.displayName;
    if (alias && alias !== name) next.alias = alias;
    else delete next.alias;
    if (displayName && displayName !== name) next.displayName = displayName;
    else delete next.displayName;
    merged.set(modelKey(name), next);
  });
  return Array.from(merged.values());
}

export function reconcileModelSelection(
  discoveredModels: ModelOption[],
  configuredModels: ModelOption[],
  selectedModelNames: Iterable<string>,
  mode: ModelSelectionMode,
): Set<string> {
  const availableNames = new Set(
    mergeModelOptions(discoveredModels, configuredModels).map((model) => modelKey(model.name)),
  );
  const configuredNames = new Set(
    configuredModels.map((model) => modelKey(model.name)).filter(Boolean),
  );
  const previousSelection = new Set(Array.from(selectedModelNames, modelKey).filter(Boolean));
  const requestedSelection = mode === "refresh"
    ? previousSelection
    : configuredNames.size > 0
      ? configuredNames
      : new Set(discoveredModels.map((model) => modelKey(model.name)).filter(Boolean));
  return new Set(Array.from(requestedSelection).filter((name) => availableNames.has(name)));
}

export function normalizeBaseUrl(value: string): string {
  let raw = value.trim();
  if (!raw) return "";
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(text("model.error.invalidBaseUrl"));
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(text("model.error.unsupportedBaseUrl"));
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString()
    .replace(/\/(?:chat\/completions|messages|responses|generateContent)$/i, "")
    .replace(/\/+$/, "");
}

const stripKnownSuffix = (baseUrl: string) =>
  normalizeBaseUrl(baseUrl)
    .replace(/\/(?:v1beta|v1)\/models$/i, "")
    .replace(/\/models$/i, "");

export const modelEndpointCandidates = (provider: ModelProvider, baseUrl: string): string[] => {
  const resolvedBaseUrl = baseUrl.trim()
    || (provider === "gemini"
      ? DEFAULT_GEMINI_BASE_URL
      : provider === "claude"
        ? DEFAULT_CLAUDE_BASE_URL
        : provider === "deepseek"
          ? DEEPSEEK_BASE_URL
          : "");
  const normalized = normalizeBaseUrl(resolvedBaseUrl);
  if (!normalized) return [];
  if (provider === "openai") {
    return [/\/models$/i.test(normalized) ? normalized : `${normalized}/models`];
  }
  const base = stripKnownSuffix(normalized);
  const withoutVersion = base.replace(/\/(?:v1beta|v1)$/i, "");
  if (provider === "gemini") return [`${withoutVersion}/v1beta/models`];
  if (provider === "claude") return [`${withoutVersion}/v1/models`];
  if (provider === "deepseek") return [`${base}/models`];
  return [/\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`];
};

const normalizeModelList = (payload: unknown, preserveExistingAlias = false): ModelOption[] => {
  const parsed = typeof payload === "string" ? (() => {
    try { return JSON.parse(payload) as unknown; } catch { return payload; }
  })() : payload;
  const source = isRecord(parsed)
    ? (Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [])
    : Array.isArray(parsed) ? parsed : [];
  const seen = new Set<string>();
  return source.map((item): ModelOption | null => {
    const name = typeof item === "string" ? item : isRecord(item) ? readString(item, "id", "name", "model", "value") : "";
    if (!name || seen.has(name.toLowerCase())) return null;
    seen.add(name.toLowerCase());
    const record = isRecord(item) ? item : null;
    const rawAlias = record ? readString(record, "alias") : "";
    const alias = preserveExistingAlias ? rawAlias : usableModelAlias(rawAlias);
    const displayName = record ? readString(record, "display-name", "display_name", "displayName") : "";
    const thinking = record && isRecord(record.thinking)
      ? normalizeThinkingConfig(record.thinking, !preserveExistingAlias)
      : undefined;
    return {
      name,
      ...(alias && alias !== name ? { alias } : {}),
      ...(displayName && displayName !== name ? { displayName } : {}),
      ...(thinking && (preserveExistingAlias || Object.keys(thinking).length > 0) ? { thinking } : {}),
    };
  }).filter((item): item is ModelOption => item !== null);
};

export function modelsFromRecord(value: unknown): ModelOption[] {
  if (!Array.isArray(value)) return [];
  return normalizeModelList(value, true);
}

export function modelsFromDiscoveredPayload(payload: unknown): ModelOption[] {
  return normalizeModelList(payload);
}

export async function fetchModels(
  provider: ModelProvider,
  baseUrl: string,
  apiKey: string,
  authIndex?: string,
  customHeaders: Record<string, string> = {},
  timeoutMs?: number,
): Promise<ModelOption[]> {
  const normalized = baseUrl.trim() ? normalizeBaseUrl(baseUrl) : "";
  const candidates = modelEndpointCandidates(provider, normalized);
  if (candidates.length === 0) throw new Error(text("model.error.baseUrlRequired"));
  const headers: Record<string, string> = { ...customHeaders };
  const hasHeader = (name: string) =>
    Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
  const headerValue = (name: string) =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? "";
  const key = apiKey.trim();
  if (provider === "gemini") {
    if (key && !hasHeader("x-goog-api-key")) headers["x-goog-api-key"] = key;
    else if (authIndex && !hasHeader("x-goog-api-key")) headers["x-goog-api-key"] = "$TOKEN$";
  } else if (provider === "claude") {
    const bearerToken = headerValue("authorization").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
    if (key && !hasHeader("x-api-key")) headers["x-api-key"] = key;
    else if (bearerToken && !hasHeader("x-api-key")) headers["x-api-key"] = bearerToken;
    else if (authIndex && !hasHeader("x-api-key")) headers["x-api-key"] = "$TOKEN$";
    if (!hasHeader("anthropic-version")) headers["anthropic-version"] = "2023-06-01";
  } else if (key && !hasHeader("authorization")) {
    headers.Authorization = `Bearer ${key}`;
  } else if (authIndex && !hasHeader("authorization")) {
    headers.Authorization = "Bearer $TOKEN$";
  }

  let lastError = "";
  for (const url of candidates) {
    try {
      const collected: ModelOption[] = [];
      const seen = new Set<string>();
      let pageToken = "";

      for (let page = 0; page < (provider === "gemini" ? 20 : 1); page += 1) {
        const pageUrl = new URL(url);
        if (pageToken) pageUrl.searchParams.set("pageToken", pageToken);
        const response = await managementApi.post<Record<string, unknown>>("/api-call", {
          authIndex: authIndex?.trim() || undefined,
          method: "GET",
          url: pageUrl.toString(),
          header: Object.keys(headers).length ? headers : undefined,
        }, { timeoutMs });
        const status = Number(response.status_code ?? response.statusCode ?? 0);
        if (status < 200 || status >= 300) {
          lastError = apiCallErrorMessage(response);
          break;
        }

        const payload = response.body ?? response.bodyText;
        modelsFromDiscoveredPayload(payload).forEach((model) => {
          const name = provider === "gemini" ? model.name.replace(/^models\//i, "") : model.name;
          const dedupeKey = name.toLowerCase();
          if (!name || seen.has(dedupeKey)) return;
          seen.add(dedupeKey);
          collected.push(
            name === model.name
              ? model
              : { ...model, name, alias: model.alias === model.name ? undefined : model.alias },
          );
        });

        const parsedPayload = typeof payload === "string"
          ? (() => {
              try { return JSON.parse(payload) as unknown; } catch { return null; }
            })()
          : payload;
        pageToken = isRecord(parsedPayload) ? readString(parsedPayload, "nextPageToken") : "";
        if (!pageToken) break;
      }

      if (collected.length) return collected;

      if (provider === "openai" && Object.keys(headers).length > 0) {
        const response = await managementApi.post<Record<string, unknown>>("/api-call", {
          method: "GET",
          url,
        }, { timeoutMs });
        const status = Number(response.status_code ?? response.statusCode ?? 0);
        if (status >= 200 && status < 300) {
          const models = modelsFromDiscoveredPayload(response.body ?? response.bodyText);
          if (models.length) return models;
        }
      }
    } catch (error) {
      lastError = String(error);
      if (provider === "openai" && Object.keys(headers).length > 0) {
        try {
          const response = await managementApi.post<Record<string, unknown>>("/api-call", {
            method: "GET",
            url,
          }, { timeoutMs });
          const status = Number(response.status_code ?? response.statusCode ?? 0);
          if (status >= 200 && status < 300) {
            const models = modelsFromDiscoveredPayload(response.body ?? response.bodyText);
            if (models.length) return models;
          }
        } catch {
        }
      }
    }
  }
  throw new Error(lastError || text("model.error.noResponse"));
}

// ---------------------------------------------------------------------------
// providerHealthCheck.ts (probe request built here, executed by the Node layer)
// ---------------------------------------------------------------------------

export const PROVIDER_HEALTH_TIMEOUT_MS = 15_000;
export const PROVIDER_HEALTH_CONCURRENCY = 4;

export type ProviderHealthProbe = {
  url: string;
  header: Record<string, string>;
  data: string;
  protocol: "openai-chat" | "openai-responses" | "claude" | "gemini";
  model: string;
  source: string;
  authIndex: string;
};

export type ProviderHealthProbeResult = {
  success: boolean;
  firstTokenLatencyMs?: number;
  responseLatencyMs?: number;
  error?: string;
  timedOut?: boolean;
  errorCode?: "missing-direct-key";
};

export type ProviderModelHealthResult = ProviderHealthProbeResult & {
  model: string;
  status: "healthy" | "failed";
};

export type ProviderHealthCheckOptions = {
  provider: ModelProvider;
  baseUrl: string;
  apiKeys: string[];
  authIndex?: string;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
};

const defaultBaseUrl = (provider: ModelProvider) => {
  if (provider === "claude") return "https://api.anthropic.com";
  if (provider === "gemini") return "https://generativelanguage.googleapis.com";
  if (provider === "deepseek") return "https://api.deepseek.com";
  return "";
};

const endpointRoot = (provider: ModelProvider, baseUrl: string) => {
  const normalized = normalizeBaseUrl(baseUrl.trim() || defaultBaseUrl(provider));
  return normalized.replace(/\/(?:v1beta|v1)$/i, "");
};

const openAIChatCompletionsEndpoint = (baseUrl: string) => {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return "";
  return `${normalized}/chat/completions`;
};

const hasHeader = (headers: Record<string, string>, name: string) =>
  Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

const headerValue = (headers: Record<string, string>, name: string) =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? "";

const setHeaderIfMissing = (headers: Record<string, string>, name: string, value: string) => {
  if (!hasHeader(headers, name)) headers[name] = value;
};

export function primaryProviderHealthCredential(apiKeys: string[]): string {
  return apiKeys.map((key) => key.trim()).find(Boolean) ?? "";
}

export function mergeProviderHealthModels(
  discoveredModels: ModelOption[],
  configuredModels: ModelOption[],
): ModelOption[] {
  const configured = new Map<string, ModelOption>();
  configuredModels.forEach((model) => {
    const name = model.name.trim();
    if (!name) return;
    const key = name.toLowerCase();
    configured.set(key, { ...configured.get(key), ...model, name });
  });
  discoveredModels.forEach((model) => {
    const key = model.name.trim().toLowerCase();
    const selected = configured.get(key);
    if (!selected) return;
    configured.set(key, { ...model, ...selected });
  });
  return Array.from(configured.values()).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

export function buildProviderHealthProbe(
  provider: ModelProvider,
  baseUrl: string,
  model: string,
  apiKey: string,
  authIndex = "",
  customHeaders: Record<string, string> = {},
): ProviderHealthProbe {
  const root = endpointRoot(provider, baseUrl);
  const headers = { ...customHeaders };
  const key = apiKey.trim();
  const normalizedModel = provider === "gemini"
    ? model.trim().replace(/^models\//i, "")
    : model.trim();
  const metadata = {
    model: normalizedModel,
    source: key,
    authIndex: authIndex.trim(),
  };
  setHeaderIfMissing(headers, "Content-Type", "application/json");

  if (provider === "gemini") {
    if (key) setHeaderIfMissing(headers, "x-goog-api-key", key);
    else if (authIndex) setHeaderIfMissing(headers, "x-goog-api-key", "$TOKEN$");
    return {
      ...metadata,
      url: `${root}/v1beta/models/${encodeURIComponent(normalizedModel)}:generateContent?alt=sse`,
      header: headers,
      protocol: "gemini",
      data: JSON.stringify({
        contents: [{ parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
    };
  }

  if (provider === "claude") {
    const bearerToken = headerValue(headers, "authorization").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
    if (key) setHeaderIfMissing(headers, "x-api-key", key);
    else if (bearerToken) setHeaderIfMissing(headers, "x-api-key", bearerToken);
    else if (authIndex) setHeaderIfMissing(headers, "x-api-key", "$TOKEN$");
    setHeaderIfMissing(headers, "anthropic-version", "2023-06-01");
    return {
      ...metadata,
      url: `${root}/v1/messages`,
      header: headers,
      protocol: "claude",
      data: JSON.stringify({
        model: normalizedModel,
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    };
  }

  if (key) setHeaderIfMissing(headers, "Authorization", `Bearer ${key}`);
  else if (authIndex) setHeaderIfMissing(headers, "Authorization", "Bearer $TOKEN$");

  if (provider === "codex" || provider === "deepseek") {
    return {
      ...metadata,
      url: provider === "deepseek"
        ? `${normalizeBaseUrl(baseUrl.trim() || defaultBaseUrl(provider))}/responses`
        : `${root}/v1/responses`,
      header: headers,
      protocol: "openai-responses",
      data: JSON.stringify({
        model: normalizedModel,
        input: "hi",
        stream: true,
      }),
    };
  }

  return {
    ...metadata,
    url: openAIChatCompletionsEndpoint(baseUrl),
    header: headers,
    protocol: "openai-chat",
    data: JSON.stringify({
      model: normalizedModel,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
  };
}

const isTimeoutError = (message: string) =>
  /timed?\s*out|timeout|deadline has elapsed|超时/i.test(message);

const errorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message.trim() || error.name;
  return String(error).replace(/^Error:\s*/i, "").trim();
};

async function checkProviderHealthProbe(
  provider: ModelProvider,
  baseUrl: string,
  model: string,
  apiKey: string,
  authIndex = "",
  customHeaders: Record<string, string> = {},
  timeoutMs = PROVIDER_HEALTH_TIMEOUT_MS,
): Promise<ProviderHealthProbeResult> {
  try {
    const probe = buildProviderHealthProbe(provider, baseUrl, model, apiKey, authIndex, customHeaders);
    if (Object.values(probe.header).some((value) => value.includes("$TOKEN$"))) {
      return { success: false, errorCode: "missing-direct-key" };
    }
    const headers = await getLocalApiAuthHeaders();
    const response = await fetch("/api/proxy/provider-health-probe", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ request: { protocol: probe.protocol, timeoutMs, data: probe.data, header: probe.header, url: probe.url, model: probe.model, source: probe.source, authIndex: probe.authIndex } }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok: boolean; result?: { firstTokenLatencyMs?: number; responseLatencyMs: number }; error?: string }
      | null;
    if (!payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    const raw = payload.result as { firstTokenLatencyMs?: number; responseLatencyMs: number } | undefined;
    const firstTokenLatencyMs = raw && Number.isFinite(raw.firstTokenLatencyMs)
      ? Math.max(1, Math.round(raw.firstTokenLatencyMs as number))
      : undefined;
    const responseLatencyMs = raw && Number.isFinite(raw.responseLatencyMs)
      ? Math.max(1, Math.round(raw.responseLatencyMs))
      : firstTokenLatencyMs;
    return {
      success: true,
      ...(firstTokenLatencyMs === undefined ? {} : { firstTokenLatencyMs }),
      ...(responseLatencyMs === undefined ? {} : { responseLatencyMs }),
    };
  } catch (error) {
    const message = errorMessage(error);
    return { success: false, error: message, timedOut: isTimeoutError(message) };
  }
}

export async function checkProviderModelHealth(
  options: ProviderHealthCheckOptions,
  model: string,
): Promise<ProviderModelHealthResult> {
  const result = await checkProviderHealthProbe(
    options.provider,
    options.baseUrl,
    model,
    primaryProviderHealthCredential(options.apiKeys),
    options.authIndex,
    options.customHeaders,
    options.timeoutMs,
  );
  return {
    model,
    status: result.success ? "healthy" : "failed",
    ...result,
  };
}

export async function runProviderModelHealthChecks(
  models: ModelOption[],
  checkModel: (model: ModelOption, index: number) => Promise<ProviderModelHealthResult>,
  onModelChecked?: (result: ProviderModelHealthResult, index: number) => void,
  concurrency = PROVIDER_HEALTH_CONCURRENCY,
  signal?: AbortSignal,
): Promise<ProviderModelHealthResult[]> {
  const results: ProviderModelHealthResult[] = new Array(models.length);
  let nextIndex = 0;
  const workerCount = Math.min(models.length, Math.max(1, Math.floor(concurrency)));

  const runWorker = async () => {
    while (nextIndex < models.length && !signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const model = models[index];
      if (!model) continue;
      const result = await checkModel(model, index);
      if (signal?.aborted) break;
      results[index] = result;
      onModelChecked?.(result, index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results.filter((result) => result !== undefined);
}

export async function checkProviderModelsHealth(
  options: ProviderHealthCheckOptions,
  models: ModelOption[],
  onModelChecked?: (result: ProviderModelHealthResult, index: number) => void,
  concurrency = PROVIDER_HEALTH_CONCURRENCY,
  signal?: AbortSignal,
): Promise<ProviderModelHealthResult[]> {
  return runProviderModelHealthChecks(
    models,
    (model) => checkProviderModelHealth(options, model.name),
    onModelChecked,
    concurrency,
    signal,
  );
}

// providerProxy.ts
export function normalizeProviderProxyUrl(value: string): string {
  const proxyUrl = value.trim();
  if (!proxyUrl) return "";
  if (/^(direct|none)$/i.test(proxyUrl)) return proxyUrl.toLowerCase();

  try {
    if (/\s/.test(proxyUrl)) throw new Error("invalid");
    const url = new URL(proxyUrl);
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)
      || !url.hostname
      || (!url.port && !["http:", "https:"].includes(url.protocol))
      || !["", "/"].includes(url.pathname)
      || url.search
      || url.hash) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error(copy("proxy.upstream.error.proxyUrlInvalid"));
  }
  return proxyUrl;
}

// ---------------------------------------------------------------------------
// provider remarks (GUI-only notes, stored by the Node layer)
// ---------------------------------------------------------------------------

export type ApiAccessRemarkLocator = {
  providerName: string;
  baseUrl: string;
  apiKeys: string[];
  configIdentity?: string;
};

export async function resolveApiAccessRemarks(
  queries: Array<{ providerSection: string } & ApiAccessRemarkLocator>,
): Promise<string[]> {
  const headers = await getLocalApiAuthHeaders();
  const response = await fetch("/api/proxy/provider-remarks/resolve", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ queries }),
  });
  const payload = (await response.json().catch(() => null)) as { ok: boolean; remarks?: string[] } | null;
  if (!payload?.ok) throw new Error(`HTTP ${response.status}`);
  return payload.remarks ?? [];
}

export async function saveApiAccessRemark(update: {
  providerSection: string;
  previousRecords: ApiAccessRemarkLocator[];
  records: ApiAccessRemarkLocator[];
  allRecords: ApiAccessRemarkLocator[];
  remark: string;
}): Promise<void> {
  const headers = await getLocalApiAuthHeaders();
  const response = await fetch("/api/proxy/provider-remarks", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ update }),
  });
  const payload = (await response.json().catch(() => null)) as { ok: boolean; error?: string } | null;
  if (!payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
}

// ---------------------------------------------------------------------------
// ApiAccessPage.tsx pure helpers
// ---------------------------------------------------------------------------

export type ProviderSection =
  | "gemini-api-key"
  | "codex-api-key"
  | "claude-api-key"
  | "openai-compatibility";

export type ProviderCategory = ProviderSection | "deepseek";

export const OPENAI_THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;

export type ProviderDefinition = {
  id: ProviderCategory;
  section: ProviderSection;
  responseKey: string;
  openAi: boolean;
};

export type ProviderRow = {
  section: ProviderSection;
  index: number;
  record: Record<string, unknown>;
  name: string;
  apiKey: string;
  apiKeys: string[];
  baseUrl: string;
  models: ModelOption[];
  disabled: boolean;
  priority: number | null;
  authIndex: string;
  remark: string;
};

export type ProviderSaveResult =
  | { saved: true }
  | { saved: false; error: string; target: "form" | "models" };

export const requestErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export type ProviderDraft = {
  groupKeys?: ProviderKeyDraft[];
  name: string;
  apiKey: string;
  remark: string;
  baseUrl: string;
  proxyUrl?: string;
  proxyUrlEdited?: boolean;
  proxyUrlMixed?: boolean;
  priority: string;
  models: ModelOption[];
  modelSelectionCatalog?: ModelOption[];
  prefix?: string;
  headersText?: string;
  excludedModelsText?: string;
  disableCooling?: boolean | null;
  websockets?: boolean;
  thinkingLevels?: string[];
  thinkingLevelsEdited?: boolean;
  disabled?: boolean;
  cloakMode?: string;
  cloakStrictMode?: boolean;
  cloakSensitiveWordsText?: string;
  cloakCacheUserId?: boolean | null;
};

export const providerDefinitions: ProviderDefinition[] = [
  { id: "codex-api-key", section: "codex-api-key", responseKey: "codex-api-key", openAi: false },
  { id: "openai-compatibility", section: "openai-compatibility", responseKey: "openai-compatibility", openAi: true },
  { id: "deepseek", section: "codex-api-key", responseKey: "codex-api-key", openAi: false },
  { id: "claude-api-key", section: "claude-api-key", responseKey: "claude-api-key", openAi: false },
  { id: "gemini-api-key", section: "gemini-api-key", responseKey: "gemini-api-key", openAi: false },
];

export const providerSectionOrder = providerDefinitions.map((definition) => definition.id);

export const providerLoadDefinitions = providerDefinitions.filter(
  (definition, index, definitions) =>
    definitions.findIndex((item) => item.section === definition.section) === index,
);

export const emptyRecords = (): Record<ProviderSection, Record<string, unknown>[]> => ({
  "gemini-api-key": [],
  "codex-api-key": [],
  "claude-api-key": [],
  "openai-compatibility": [],
});

export const definitionFor = (category: ProviderCategory) =>
  providerDefinitions.find((item) => item.id === category) ?? providerDefinitions[0];

export const isDeepSeekRecord = (record: Record<string, unknown>) => {
  const name = readString(record, "name").trim().toLowerCase();
  const baseUrl = readString(record, "base-url", "baseUrl").trim().toLowerCase();
  return name.includes("deepseek") || /^https?:\/\/api\.deepseek\.com(?:\/|$)/i.test(baseUrl);
};

export const providerCategoryMatchesRecord = (
  category: ProviderCategory,
  record: Record<string, unknown>,
  section: ProviderSection = definitionFor(category).section,
) => {
  if (category === "deepseek") {
    return section === "codex-api-key" && isDeepSeekRecord(record);
  }
  if (category === "codex-api-key") {
    return section === "codex-api-key" && !isDeepSeekRecord(record);
  }
  if (category === "openai-compatibility") {
    return section === "openai-compatibility";
  }
  return true;
};

export const sectionRecordsFromConfig = (payload: unknown, section: ProviderSection) =>
  isRecord(payload) && Array.isArray(payload[section])
    ? payload[section].filter(isRecord)
    : [];

// --- native v8 provider groups (EasyCLIProxyAPI be9a2b6) ---------------------
// A group record carries `keys[]`; each key inherits the group's fields unless
// it overrides them (null = explicit inherit). Rows and saves must keep this
// structure intact — the flattened legacy view erases it.

export type ProviderKeyDraft = {
  id: string;
  value: Record<string, unknown>;
  text?: Record<string, string>;
};

export const providerGroupKeys = (group: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(group.keys) ? group.keys.filter(isRecord) : [];

export function providerKeyDraft(value: Record<string, unknown> = {}): ProviderKeyDraft {
  return { id: crypto.randomUUID(), value: structuredClone(value) };
}

export function cleanProviderGroup(group: Record<string, unknown>): Record<string, unknown> {
  const clean = normalizeProviderModels(group);
  for (const field of ["auth-index", "authIndex", "auth_index", "test-model", "testModel"]) delete clean[field];
  if (Array.isArray(clean.keys)) clean.keys = clean.keys.filter(isRecord).map(cleanProviderGroup);
  return clean;
}

export function providerGroupIdentity(group: Record<string, unknown>): string {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
    : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
  return JSON.stringify(sort(cleanProviderGroup(group)));
}

// Lists and maps replace the group setting; null and absent fields inherit it.
export function effectiveProviderKey(group: Record<string, unknown>, key: Record<string, unknown>) {
  const { keys: _keys, ...shared } = group;
  return { ...shared, ...Object.fromEntries(Object.entries(key).filter(([, value]) => value !== null)) };
}

export const providerKeyIsDisabled = (group: Record<string, unknown>, key: Record<string, unknown>) => {
  const effective = effectiveProviderKey(group, key);
  return group.disabled === true || effective.disabled === true
    || (Array.isArray(effective["excluded-models"]) && effective["excluded-models"].some((item) => String(item).trim() === "*"));
};

export function providerGroupStatus(group: Record<string, unknown>): "enabled" | "partial" | "disabled" {
  const keys = providerGroupKeys(group);
  if (!keys.length) return group.disabled === true ? "disabled" : "enabled";
  const active = keys.filter((key) => !providerKeyIsDisabled(group, key)).length;
  return active === 0 ? "disabled" : active === keys.length ? "enabled" : "partial";
}

export function providerKeyOverrides(key: Record<string, unknown>): string[] {
  return Object.keys(key).filter((field) => !["api-key", "auth-index", "authIndex", "auth_index", "weight"].includes(field)
    && key[field] != null);
}

export function validateProviderGroupKeys(keys: ProviderKeyDraft[]): string | null {
  for (const { value } of keys) {
    if (!readString(value, "api-key").trim()) return "key";
    if (Array.isArray(value.models) && value.models.some((model) => !isRecord(model) || !readString(model, "name").trim())) return "models";
    for (const field of ["priority", "weight", "request-retry"]) {
      const valueField = value[field];
      if (valueField == null) continue;
      if (typeof valueField !== "number" || !Number.isSafeInteger(valueField)) return field;
      if (field === "weight" && (valueField < 0 || valueField > 1_000_000)) return field;
    }
  }
  return null;
}

export function serializeProviderKey(draft: ProviderKeyDraft): Record<string, unknown> {
  const value = cleanProviderGroup(draft.value);
  for (const [field, text] of Object.entries(draft.text ?? {})) {
    if (field === "cloak-words") value.cloak = { ...(isRecord(value.cloak) ? value.cloak : {}),
      "sensitive-words": text.split(/[\n,]/).map((line) => line.trim()).filter(Boolean) };
    if (field === "excluded-models") value[field] = text.split(/[\n,]/).map((line) => line.trim()).filter(Boolean);
    if (field === "headers") {
      const headers: Record<string, string> = {};
      for (const line of text.split("\n").filter((line) => line.trim())) {
        const colon = line.indexOf(":");
        if (colon <= 0 || !/^[!#$%&'*+.^_`|~\w-]+$/.test(line.slice(0, colon).trim())) throw new Error("Invalid key header");
        headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      }
      value[field] = headers;
    }
  }
  value["api-key"] = readString(value, "api-key").trim();
  return value;
}

// Native v8 groups: callers keep keys and overrides intact through every edit.
export const providerGroupsApi = {
  get: async (section: ProviderSection): Promise<Record<string, unknown>[]> => {
    const value = await optionalConfigValue(`/config/api-keys/${section.replace(/-api-key$/, "")}`, [], {});
    if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Invalid provider group response");
    return value;
  },
  put: (section: ProviderSection, groups: Record<string, unknown>[]) =>
    invokeManagement<ManagementJson>({
      method: "PUT",
      path: `/config/api-keys/${section.replace(/-api-key$/, "")}`,
      body: groups as ManagementJson,
    }),
};

export const rowFromRecord = (
  section: ProviderSection,
  record: Record<string, unknown>,
  index: number,
): ProviderRow => {
  const grouped = Array.isArray(record.keys);
  const entries = grouped
    ? providerGroupKeys(record)
    : definitionFor(section).openAi && Array.isArray(record["api-key-entries"])
      ? record["api-key-entries"].filter(isRecord)
      : [];
  const entry = entries[0] ?? null;
  const apiKeys = entries
    .map((item) => readString(item, "api-key", "apiKey"))
    .filter(Boolean);
  const singleApiKey = readString(record, "api-key", "apiKey");
  const excludedModels = Array.isArray(record["excluded-models"])
    ? record["excluded-models"].map(String)
    : [];
  return {
    section,
    index,
    record,
    name: grouped || definitionFor(section).openAi
      ? readString(record, "name") || copy("proxy.upstream.compatibleName", { number: index + 1 })
      : section,
    apiKey: entry ? readString(entry, "api-key", "apiKey") : singleApiKey,
    apiKeys: entry ? apiKeys : singleApiKey ? [singleApiKey] : [],
    baseUrl: readString(record, "base-url", "baseUrl"),
    models: grouped && Array.isArray(record.models)
      ? record.models.flatMap((model) => modelsFromRecord([model]))
      : modelsFromRecord(record.models),
    disabled: grouped
      ? providerGroupStatus(record) === "disabled"
      : definitionFor(section).openAi
        ? readBoolean(record, "disabled")
        : excludedModels.some((model) => model.trim() === "*"),
    priority: readNumber(record, "priority"),
    authIndex: entry
      ? readString(entry, "auth-index", "authIndex")
      : readString(record, "auth-index", "authIndex"),
    remark: "",
  };
};

export const providerModelType = (
  section: ProviderSection,
  record?: Record<string, unknown>,
): ModelProvider => {
  if (section === "gemini-api-key") return "gemini";
  if (section === "claude-api-key") return "claude";
  if (section === "codex-api-key" && record && isDeepSeekRecord(record)) return "deepseek";
  if (section === "codex-api-key") return "codex";
  return "openai";
};

export const providerHeadersFromRecord = (record: Record<string, unknown>) =>
  isRecord(record.headers)
    ? Object.fromEntries(Object.entries(record.headers).map(([key, value]) => [key, String(value)]))
    : {};

export const stripResponseFields = (record: Record<string, unknown>) => {
  if (Array.isArray(record.keys)) return cleanProviderGroup(record);
  const next = normalizeProviderModels(record);
  delete next["test-model"];
  delete next.testModel;
  delete next["auth-index"];
  delete next.authIndex;
  delete next.auth_index;
  if (Array.isArray(next["api-key-entries"])) {
    next["api-key-entries"] = next["api-key-entries"]
      .filter(isRecord)
      .map((entry) => {
        const clean = { ...entry };
        delete clean["auth-index"];
        delete clean.authIndex;
        delete clean.auth_index;
        return clean;
      });
  }
  return next;
};

const normalizeProviderIdentity = (value: unknown): unknown => {
  if (value == null || value === "") return undefined;
  if (Array.isArray(value)) return value.length ? value.map(normalizeProviderIdentity) : undefined;
  if (isRecord(value)) {
    const entries = Object.keys(value).sort().flatMap((key) => {
      const normalized = normalizeProviderIdentity(value[key]);
      return normalized === undefined ? [] : [[key, normalized]];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
};

const providerConfigIdentity = (record: Record<string, unknown>) => {
  if (Array.isArray(record.keys)) return providerGroupIdentity(record);
  const config = stripResponseFields(record);
  if (config.priority === 0) delete config.priority;
  if (config.websockets === false) delete config.websockets;
  if (config.disabled === false) delete config.disabled;
  return JSON.stringify(normalizeProviderIdentity(config) ?? {});
};

export const providerRemarkConfigIdentity = (record: Record<string, unknown>) => {
  const config = stripResponseFields(record);
  for (const key of ["name", "api-key", "apiKey", "api-key-entries", "keys", "base-url", "baseUrl", "disabled"]) {
    delete config[key];
  }
  if (Array.isArray(config["excluded-models"])) {
    config["excluded-models"] = config["excluded-models"].filter((model) => String(model).trim() !== "*");
  }
  return providerConfigIdentity(config);
};

export const hasDuplicateProviderRecord = (
  section: ProviderSection,
  records: Record<string, unknown>[],
  candidates: Record<string, unknown>[],
  targetIndex = -1,
) => records.some((record, index) => index !== targetIndex && candidates.some((candidate) => {
  if (Array.isArray(candidate.keys)) return readString(record, "name") === readString(candidate, "name");
  if (definitionFor(section).openAi) return readString(record, "name") === readString(candidate, "name");
  if (section === "gemini-api-key") {
    return readString(record, "api-key", "apiKey") === readString(candidate, "api-key", "apiKey")
      && readString(record, "base-url", "baseUrl") === readString(candidate, "base-url", "baseUrl");
  }
  const { name: _recordName, ...recordConfig } = record;
  const { name: _candidateName, ...candidateConfig } = candidate;
  return providerConfigIdentity(recordConfig) === providerConfigIdentity(candidateConfig);
}));

export const mergeModelRecords = (current: unknown, selected: ModelOption[]) => {
  const existing = Array.isArray(current) ? current : [];
  const consumedExistingIndexes = new Set<number>();
  const selectedNames = new Set<string>();
  const seen = new Set<string>();
  const models = selected.reduce<Record<string, unknown>[]>((result, model) => {
    const name = model.name.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return result;
    seen.add(key);
    selectedNames.add(key);
    const requested = (model.alias ?? "").trim();
    const requestedAlias = requested.toLowerCase();
    let matchedIndex = existing.findIndex((item, index) => (
      !consumedExistingIndexes.has(index)
      && isRecord(item)
      && readString(item, "name").toLowerCase() === key
      && readString(item, "alias").toLowerCase() === requestedAlias
    ));
    if (matchedIndex < 0) {
      matchedIndex = existing.findIndex((item, index) => (
        !consumedExistingIndexes.has(index)
        && isRecord(item)
        && readString(item, "name").toLowerCase() === key
      ));
    }
    if (matchedIndex >= 0) consumedExistingIndexes.add(matchedIndex);
    const matched = matchedIndex >= 0 ? existing[matchedIndex] : undefined;
    const next: Record<string, unknown> = isRecord(matched) ? { ...matched } : {};
    next.name = name;
    const storedAlias = readString(next, "alias");
    const alias = usableModelAlias(requested);
    if (alias && alias !== name) {
      next.alias = alias;
    } else if (
      requested
      && storedAlias
      && requested.toLowerCase() === storedAlias.toLowerCase()
      && requested.toLowerCase() !== name.toLowerCase()
    ) {
      next.alias = storedAlias;
    } else if (requested && requested !== name) {
      throw new Error(text("aliases.error.invalidAlias"));
    } else {
      delete next.alias;
    }
    if (model.thinking) next.thinking = { ...model.thinking };
    result.push(next);
    return result;
  }, []);

  existing.forEach((item, index) => {
    if (
      consumedExistingIndexes.has(index)
      || !isRecord(item)
      || !selectedNames.has(readString(item, "name").toLowerCase())
    ) return;
    models.push({ ...item });
  });

  return models;
};

export const exclusionsForModelSelection = (
  currentText: string,
  discoveredModels: ModelOption[],
  selectedModels: ModelOption[],
) => {
  const discovered = new Map<string, string>();
  discoveredModels.forEach((model) => {
    const name = model.name.trim();
    if (name && !discovered.has(name.toLowerCase())) discovered.set(name.toLowerCase(), name);
  });
  const selected = new Set(
    selectedModels.map((model) => model.name.trim().toLowerCase()).filter(Boolean),
  );
  const selectedClientNames = new Set(
    selectedModels
      .filter((model) => model.name.trim())
      .map((model) => (model.alias?.trim() || model.name.trim()).toLowerCase()),
  );
  const rules = currentText
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const next = rules.filter((rule) => !discovered.has(rule.toLowerCase()));

  if (selected.size > 0) {
    discovered.forEach((name, key) => {
      if (!selected.has(key) && !selectedClientNames.has(key)) next.push(name);
    });
  }

  return next
    .filter((rule, index, values) =>
      values.findIndex((value) => value.toLowerCase() === rule.toLowerCase()) === index)
    .join("\n");
};

export const modelSelectionForDiscovery = (
  configuredModels: ModelOption[],
  discoveredModels: ModelOption[],
  excludedModelsText: string,
) => {
  const configured = new Set(
    configuredModels.map((model) => model.name.trim().toLowerCase()).filter(Boolean),
  );
  if (configured.size > 0) return configured;

  const excludedRules = excludedModelsText
    .split(/[,\n]/)
    .map((rule) => rule.trim())
    .filter(Boolean);
  return new Set(
    discoveredModels
      .filter((model) => !excludedRules.some((rule) => modelMatchesRule(model.name, rule)))
      .map((model) => model.name.toLowerCase()),
  );
};

// oauthModels.ts wildcard matching (model-old-*, model-preview)
const wildcardPattern = (rule: string) => new RegExp(
  `^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  "i",
);

export const modelMatchesRule = (modelId: string, rule: string) => {
  const normalizedRule = rule.trim();
  if (!normalizedRule) return false;
  return wildcardPattern(normalizedRule).test(modelId.trim());
};

export const parseProviderApiKeys = (value: string) => value
  .split(/\r?\n/)
  .map((item) => item.trim())
  .filter((item, index, values) => item && values.indexOf(item) === index);

const mergeOpenAiApiKeyEntries = (current: unknown, apiKey: string) => {
  const entries = Array.isArray(current) ? current.filter(isRecord) : [];
  const keys = parseProviderApiKeys(apiKey);
  const usedIndexes = new Set<number>();
  return keys.map((key, index) => {
    let matchedIndex = entries.findIndex(
      (entry, entryIndex) =>
        !usedIndexes.has(entryIndex) && readString(entry, "api-key", "apiKey") === key,
    );
    if (matchedIndex < 0 && entries[index] && !usedIndexes.has(index)) matchedIndex = index;
    if (matchedIndex >= 0) usedIndexes.add(matchedIndex);
    const next = matchedIndex >= 0 ? stripResponseFields(entries[matchedIndex]) : {};
    next["api-key"] = key;
    return next;
  });
};

const thinkingLevelsFromModels = (models: ModelOption[]): string[] => {
  const levels: string[] = [];
  models.forEach((model) => {
    const configured = model.thinking?.levels;
    if (!Array.isArray(configured)) return;
    configured.forEach((level) => {
      const normalized = String(level).trim().toLowerCase();
      if (normalized && !levels.includes(normalized)) levels.push(normalized);
    });
  });
  return levels;
};

export const providerProxyDraftFromRecord = (
  section: ProviderSection,
  record: Record<string, unknown>,
): Pick<ProviderDraft, "proxyUrl" | "proxyUrlEdited" | "proxyUrlMixed"> => {
  if (Array.isArray(record.keys)) return { proxyUrl: readString(record, "proxy-url"), proxyUrlEdited: false, proxyUrlMixed: false };
  const entries = definitionFor(section).openAi && Array.isArray(record["api-key-entries"])
    ? record["api-key-entries"].filter(isRecord)
    : [];
  const proxyUrlMixed = entries.some((entry) =>
    readString(entry, "proxy-url", "proxyUrl") !== readString(entries[0], "proxy-url", "proxyUrl"));
  return {
    proxyUrl: definitionFor(section).openAi
      ? proxyUrlMixed ? "" : readString(entries[0], "proxy-url", "proxyUrl")
      : readString(record, "proxy-url", "proxyUrl"),
    proxyUrlEdited: false,
    proxyUrlMixed,
  };
};

export const draftFromRow = (row: ProviderRow): ProviderDraft => {
  const definition = definitionFor(row.section);
  const isDeepSeek = row.section === "codex-api-key" && isDeepSeekRecord(row.record);
  const grouped = Array.isArray(row.record.keys);
  // Legacy flat records carry key material outside keys[]; seed drafts from it
  // so an edit round-trip upgrades to a group instead of dropping the key.
  const groupKeyValues = grouped
    ? providerGroupKeys(row.record)
    : definition.openAi && Array.isArray(row.record["api-key-entries"])
      ? row.record["api-key-entries"].filter(isRecord)
      : readString(row.record, "api-key", "apiKey")
        ? [{ "api-key": readString(row.record, "api-key", "apiKey") }]
        : [];
  return {
    ...(grouped || groupKeyValues.length
      ? { groupKeys: groupKeyValues.map(providerKeyDraft) }
      : {}),
    name: grouped ? row.name : isDeepSeek ? "DeepSeek" : row.name,
    apiKey: definition.openAi ? row.apiKeys.join("\n") : row.apiKey,
    remark: row.remark || (!grouped && definition.openAi && !isDeepSeek ? row.name : ""),
    baseUrl: row.baseUrl,
    ...providerProxyDraftFromRecord(row.section, row.record),
    priority: row.priority === null ? "" : String(row.priority),
    models: row.models,
    prefix: readString(row.record, "prefix"),
    headersText: isRecord(row.record.headers)
      ? Object.entries(row.record.headers)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join("\n")
      : "",
    excludedModelsText: Array.isArray(row.record["excluded-models"])
      ? row.record["excluded-models"].map(String).filter((model) => model.trim() !== "*").join("\n")
      : "",
    disableCooling: typeof row.record["disable-cooling"] === "boolean" ? row.record["disable-cooling"] : null,
    websockets: readBoolean(row.record, "websockets"),
    thinkingLevels: definition.openAi ? thinkingLevelsFromModels(row.models) : undefined,
    thinkingLevelsEdited: false,
    disabled: row.disabled,
    cloakMode: isRecord(row.record.cloak) ? readString(row.record.cloak, "mode") : "",
    cloakStrictMode: isRecord(row.record.cloak)
      ? readBoolean(row.record.cloak, "strict-mode", "strictMode")
      : false,
    cloakSensitiveWordsText:
      isRecord(row.record.cloak) && Array.isArray(row.record.cloak["sensitive-words"])
        ? row.record.cloak["sensitive-words"].map(String).join("\n")
        : "",
    cloakCacheUserId: isRecord(row.record.cloak) && typeof row.record.cloak["cache-user-id"] === "boolean"
      ? row.record.cloak["cache-user-id"] as boolean
      : null,
  };
};

export const emptyProviderDraft = (): ProviderDraft => ({
  name: "",
  apiKey: "",
  remark: "",
  baseUrl: "",
  proxyUrl: "",
  priority: "",
  models: [],
  prefix: "",
  headersText: "",
  excludedModelsText: "",
  disableCooling: null,
  websockets: false,
  disabled: false,
  cloakMode: "",
  cloakStrictMode: false,
  cloakSensitiveWordsText: "",
  cloakCacheUserId: null,
});

export const createProviderDraft = (category: ProviderCategory): ProviderDraft => {
  const draft = emptyProviderDraft();
  if (category === "openai-compatibility") return { ...draft, thinkingLevels: [], thinkingLevelsEdited: false };
  if (category !== "deepseek") return draft;
  return {
    ...draft,
    name: "DeepSeek",
    remark: "",
    baseUrl: DEEPSEEK_BASE_URL,
  };
};

export const applyProviderRemarkIdentity = (
  category: ProviderCategory,
  draft: ProviderDraft,
): ProviderDraft => draft.groupKeys
  ? draft
  : category === "deepseek"
    ? { ...draft, name: draft.name.trim() || "DeepSeek" }
    : definitionFor(category).openAi
      ? { ...draft, name: draft.remark.trim() }
      : draft;

export const applyProviderPreset = (
  category: ProviderCategory,
  draft: ProviderDraft,
): ProviderDraft => {
  if (!definitionFor(category).openAi || draft.thinkingLevels === undefined || draft.thinkingLevelsEdited === false) return draft;
  const levels = draft.thinkingLevels;
  return {
    ...draft,
    models: draft.models.map((model) => {
      const thinking = { ...model.thinking };
      if (levels.length > 0) thinking.levels = [...levels];
      else delete thinking.levels;
      const { thinking: _thinking, ...withoutThinking } = model;
      return Object.keys(thinking).length > 0
        ? { ...withoutThinking, thinking }
        : withoutThinking;
    }),
  };
};

export const parseProviderHeaders = (value: string): Record<string, string> => {
  const headers: Record<string, string> = {};
  value.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      throw new Error(text("apiAccess.error.headerMissingColon", { number: index + 1 }));
    }
    const key = trimmed.slice(0, separator).trim();
    const headerValue = trimmed.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || !headerValue) {
      throw new Error(text("apiAccess.error.headerInvalid", { number: index + 1 }));
    }
    const duplicateKey = Object.keys(headers).find(
      (current) => current.toLowerCase() === key.toLowerCase(),
    );
    if (duplicateKey) delete headers[duplicateKey];
    headers[key] = headerValue;
  });
  return headers;
};

const applyAdvancedFields = (
  next: Record<string, unknown>,
  section: ProviderSection,
  draft: ProviderDraft,
) => {
  if (draft.prefix !== undefined) {
    const prefix = draft.prefix.trim();
    if (prefix) next.prefix = prefix;
    else delete next.prefix;
  }
  if (draft.headersText !== undefined) {
    const headers = parseProviderHeaders(draft.headersText);
    if (Object.keys(headers).length > 0) next.headers = headers;
    else delete next.headers;
  }
  if (draft.excludedModelsText !== undefined && section !== "openai-compatibility") {
    const excludedModelsText = draft.modelSelectionCatalog && draft.models.some((model) => model.name.trim())
      ? exclusionsForModelSelection(
          draft.excludedModelsText,
          draft.modelSelectionCatalog,
          (Array.isArray(next.models) ? next.models : []).filter(isRecord).map((model) => ({
            name: readString(model, "name"),
            alias: readString(model, "alias"),
          })),
        )
      : draft.excludedModelsText;
    const excludedModels = excludedModelsText
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter((value, index, values) =>
        value && values.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index);
    if (draft.disabled && !excludedModels.includes("*")) excludedModels.push("*");
    if (excludedModels.length > 0) next["excluded-models"] = excludedModels;
    else delete next["excluded-models"];
  }
  if (draft.disableCooling !== undefined) {
    if (draft.disableCooling === null) delete next["disable-cooling"];
    else next["disable-cooling"] = draft.disableCooling;
  }
  if (draft.websockets !== undefined && section === "codex-api-key") {
    next.websockets = draft.websockets;
  }
  if (
    section === "claude-api-key"
    && (
      draft.cloakMode !== undefined
      || draft.cloakStrictMode !== undefined
      || draft.cloakSensitiveWordsText !== undefined
      || draft.cloakCacheUserId !== undefined
    )
  ) {
    const cloak: Record<string, unknown> = isRecord(next.cloak) ? { ...next.cloak } : {};
    if (draft.cloakMode !== undefined) {
      const mode = draft.cloakMode.trim();
      if (mode) cloak.mode = mode;
      else delete cloak.mode;
    }
    if (draft.cloakStrictMode !== undefined) {
      delete cloak.strictMode;
      if (draft.cloakStrictMode) cloak["strict-mode"] = true;
      else delete cloak["strict-mode"];
    }
    if (draft.cloakSensitiveWordsText !== undefined) {
      const sensitiveWords = draft.cloakSensitiveWordsText.split(/[,\n]/)
        .map((value) => value.trim())
        .filter((value, index, values) => value && values.indexOf(value) === index);
      delete cloak.sensitiveWords;
      if (sensitiveWords.length > 0) cloak["sensitive-words"] = sensitiveWords;
      else delete cloak["sensitive-words"];
    }
    if (draft.cloakCacheUserId !== undefined) {
      delete cloak.cacheUserId;
      if (draft.cloakCacheUserId === null) delete cloak["cache-user-id"];
      else cloak["cache-user-id"] = draft.cloakCacheUserId;
    }
    if (Object.keys(cloak).length > 0) next.cloak = cloak;
    else delete next.cloak;
  }
  return next;
};

export const buildProviderRecord = (
  section: ProviderSection,
  draft: ProviderDraft,
  current?: Record<string, unknown>,
) => {
  const record = current ? stripResponseFields(current) : {};
  const priorityText = draft.priority.trim();
  const priority = priorityText ? Number(priorityText) : null;
  if (priority !== null && !Number.isSafeInteger(priority)) {
    throw new Error(text("apiAccess.error.priorityInteger"));
  }
  const models = mergeModelRecords(record.models, draft.models);
  if (definitionFor(section).openAi) {
    if (draft.thinkingLevels !== undefined && draft.thinkingLevelsEdited !== false) {
      for (const model of models) {
        const thinking = isRecord(model.thinking) ? { ...model.thinking } : {};
        if (draft.thinkingLevels.length) thinking.levels = [...draft.thinkingLevels];
        else delete thinking.levels;
        if (Object.keys(thinking).length) model.thinking = thinking;
        else delete model.thinking;
      }
    }
    const entries = mergeOpenAiApiKeyEntries(record["api-key-entries"], draft.apiKey.trim());
    if (draft.proxyUrlEdited !== false && draft.proxyUrl !== undefined) {
      const proxyUrl = draft.proxyUrl.trim();
      entries.forEach((entry) => {
        if (proxyUrl) entry["proxy-url"] = proxyUrl;
        else delete entry["proxy-url"];
      });
    }
    const next: Record<string, unknown> = {
      ...record,
      name: draft.name.trim(),
      "base-url": draft.baseUrl.trim(),
      "api-key-entries": entries,
      models,
    };
    if (priority !== null && Number.isFinite(priority)) next.priority = priority;
    else delete next.priority;
    return applyAdvancedFields(next, section, draft);
  }

  const next: Record<string, unknown> = {
    ...record,
    "api-key": draft.apiKey.trim(),
    models,
  };
  if (section === "codex-api-key" && draft.name.trim().toLowerCase() === "deepseek") {
    next.name = "DeepSeek";
  }
  if (draft.baseUrl.trim()) next["base-url"] = draft.baseUrl.trim();
  else delete next["base-url"];
  if (draft.proxyUrl !== undefined && draft.proxyUrlEdited !== false) {
    const proxyUrl = draft.proxyUrl.trim();
    if (proxyUrl) next["proxy-url"] = proxyUrl;
    else delete next["proxy-url"];
  }
  if (priority !== null && Number.isFinite(priority)) next.priority = priority;
  else delete next.priority;
  return applyAdvancedFields(next, section, draft);
};

export const buildProviderGroupRecord = (
  section: ProviderSection,
  draft: ProviderDraft,
  current?: Record<string, unknown>,
): Record<string, unknown> => {
  const sharedDraft: ProviderDraft = { ...draft, apiKey: "", proxyUrlEdited: true,
    websockets: undefined, cloakMode: undefined, cloakStrictMode: undefined,
    cloakSensitiveWordsText: undefined, cloakCacheUserId: undefined,
    disabled: Array.isArray(current?.["excluded-models"]) && current["excluded-models"].includes("*"),
  };
  const next = buildProviderRecord(section, sharedDraft, current);
  // Native groups expose every mapping, including multiple aliases of the same
  // upstream ID. Match each row independently so edits/removals are explicit.
  const existing = Array.isArray(current?.models) ? current.models : [];
  const used = new Set<number>();
  next.models = draft.models.filter((model) => model.name.trim()).flatMap((model) => {
    let index = existing.findIndex((item, position) => !used.has(position) && isRecord(item)
      && readString(item, "name") === model.name && readString(item, "alias") === (model.alias ?? ""));
    if (index < 0) index = existing.findIndex((item, position) => !used.has(position) && isRecord(item) && readString(item, "name") === model.name);
    if (index >= 0) used.add(index);
    return mergeModelRecords(index >= 0 ? [existing[index]] : [], [model]);
  });
  if (section === "openai-compatibility" && draft.thinkingLevelsEdited) {
    for (const model of next.models as Record<string, unknown>[]) {
      const thinking = isRecord(model.thinking) ? { ...model.thinking } : {};
      if (draft.thinkingLevels?.length) thinking.levels = [...draft.thinkingLevels];
      else delete thinking.levels;
      if (Object.keys(thinking).length) model.thinking = thinking;
      else delete model.thinking;
    }
  }
  applyAdvancedFields(next, section, sharedDraft);
  delete next["api-key"];
  delete next["api-key-entries"];
  next.name = draft.name.trim();
  if (draft.proxyUrl?.trim()) next["proxy-url"] = draft.proxyUrl.trim();
  else delete next["proxy-url"];
  next.keys = (draft.groupKeys ?? []).map(serializeProviderKey);
  // Preserve absent/null/empty fields when the corresponding shared setting was
  // not edited. In v8 these values can have different inheritance semantics.
  if (current) {
    const baseline = draftFromRow(rowFromRecord(section, current, 0));
    const fields: [keyof ProviderDraft, string][] = [
      ["baseUrl", "base-url"], ["proxyUrl", "proxy-url"], ["priority", "priority"],
      ["prefix", "prefix"], ["headersText", "headers"], ["excludedModelsText", "excluded-models"],
      ["disableCooling", "disable-cooling"], ["models", "models"],
    ];
    for (const [field, configField] of fields) {
      if (field === "models" && draft.thinkingLevelsEdited) continue;
      if (field === "excludedModelsText" && draft.modelSelectionCatalog) continue;
      if (JSON.stringify(draft[field]) !== JSON.stringify(baseline[field])) continue;
      if (Object.prototype.hasOwnProperty.call(current, configField)) next[configField] = structuredClone(current[configField]);
      else delete next[configField];
    }
  }
  return next;
};

export type ProviderRecordIdentity = Pick<
  ProviderRow,
  "section" | "index" | "name" | "apiKey" | "baseUrl"
> & Partial<Pick<ProviderRow, "record">>;

const providerIdentityMatches = (
  row: ProviderRecordIdentity,
  record: Record<string, unknown>,
) => {
  if (Array.isArray(record.keys)) return readString(record, "name") === row.name;
  if (definitionFor(row.section).openAi) {
    return readString(record, "name") === row.name;
  }
  return (
    readString(record, "api-key", "apiKey") === row.apiKey
    && readString(record, "base-url", "baseUrl") === row.baseUrl
  );
};

const providerPrimaryIdentityMatches = (
  row: ProviderRecordIdentity,
  record: Record<string, unknown>,
) => Array.isArray(record.keys) || definitionFor(row.section).openAi
  ? readString(record, "name") === row.name
  : readString(record, "api-key", "apiKey") === row.apiKey;

export const resolveProviderRecordIndex = (
  records: Record<string, unknown>[],
  row: ProviderRecordIdentity,
) => {
  if (row.record) {
    const identity = providerConfigIdentity(row.record);
    const matches = records.flatMap((record, index) => (
      providerConfigIdentity(record) === identity ? [index] : []
    ));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return matches.includes(row.index) ? row.index : -1;

    const withoutBaseUrl = (record: Record<string, unknown>) => {
      const { "base-url": _baseUrl, baseUrl: _camelBaseUrl, ...rest } = record;
      return providerConfigIdentity(rest);
    };
    const defaultUrlMatches = records.flatMap((record, index) => (
      providerPrimaryIdentityMatches(row, record)
      && (!readString(record, "base-url", "baseUrl") || !row.baseUrl)
      && withoutBaseUrl(record) === withoutBaseUrl(row.record!) ? [index] : []
    ));
    return defaultUrlMatches.length === 1 ? defaultUrlMatches[0] : -1;
  }

  const exactMatches = records.flatMap((record, index) => providerIdentityMatches(row, record) ? [index] : []);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) return -1;

  const indexedRecord = records[row.index];
  if (indexedRecord && providerPrimaryIdentityMatches(row, indexedRecord)) {
    return row.index;
  }

  const primaryMatches = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => providerPrimaryIdentityMatches(row, record));
  return primaryMatches.length === 1 ? primaryMatches[0].index : -1;
};

export const reorderProviderRecords = (
  records: Record<string, unknown>[],
  scopeRows: ProviderRecordIdentity[],
  source: ProviderRecordIdentity,
  target: ProviderRecordIdentity,
) => {
  const sourceIndex = resolveProviderRecordIndex(records, source);
  const targetIndex = resolveProviderRecordIndex(records, target);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return null;

  const scopedIndexes = scopeRows
    .map((row) => resolveProviderRecordIndex(records, row))
    .filter((index, position, indexes) => index >= 0 && indexes.indexOf(index) === position)
    .sort((left, right) => left - right);
  const sourcePosition = scopedIndexes.indexOf(sourceIndex);
  const targetPosition = scopedIndexes.indexOf(targetIndex);
  if (sourcePosition < 0 || targetPosition < 0) return null;

  const reordered = scopedIndexes.map((index) => stripResponseFields(records[index]));
  const [moved] = reordered.splice(sourcePosition, 1);
  reordered.splice(targetPosition, 0, moved);

  const next = records.map(stripResponseFields);
  scopedIndexes.forEach((recordIndex, position) => {
    next[recordIndex] = reordered[position];
  });
  return next;
};

export const providerRecordWithDisabledState = (
  section: ProviderSection,
  record: Record<string, unknown>,
  disabled: boolean,
) => {
  const nextRecord = stripResponseFields(record);
  if (definitionFor(section).openAi) {
    nextRecord.disabled = disabled;
    return nextRecord;
  }

  const excludedModels = Array.isArray(nextRecord["excluded-models"])
    ? nextRecord["excluded-models"].map(String).filter((model) => model.trim() !== "*")
    : [];
  if (disabled) excludedModels.push("*");
  if (excludedModels.length > 0) nextRecord["excluded-models"] = excludedModels;
  else delete nextRecord["excluded-models"];
  return nextRecord;
};

export const providerDragId = (
  row: Pick<ProviderRow, "section" | "index" | "name" | "apiKey" | "baseUrl">,
) => {
  const identity = `${row.section}\u0000${row.name}\u0000${row.apiKey}\u0000${row.baseUrl}`;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${row.section}:${(hash >>> 0).toString(36)}:${row.index}`;
};

export const providerRemarkIdentity = (
  section: ProviderSection,
  locator: ApiAccessRemarkLocator,
) => JSON.stringify([section, locator.providerName, locator.baseUrl, locator.apiKeys, locator.configIdentity ?? ""]);

export const apiAccessRemarkLocatorFromRecord = (
  section: ProviderSection,
  record: Record<string, unknown>,
): ApiAccessRemarkLocator => {
  const row = rowFromRecord(section, record, 0);
  return {
    providerName: readString(record, "name"),
    baseUrl: row.baseUrl,
    apiKeys: row.apiKeys,
    configIdentity: providerRemarkConfigIdentity(record),
  };
};

export const apiAccessRemarkLocatorFromRow = (row: ProviderRow): ApiAccessRemarkLocator =>
  apiAccessRemarkLocatorFromRecord(row.section, row.record);

export const providerHealthIdentity = (row: ProviderRow) => [
  row.section,
  row.index,
  row.name,
  row.baseUrl,
  row.authIndex,
  row.apiKeys.join("\u0000"),
  row.models.map((model) => model.name).join("\u0000"),
].join("\u0001");
