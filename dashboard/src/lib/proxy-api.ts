// REST client for the AiTool proxy layer (/api/proxy/* served by the local
// CLI server). Reads are open; mutations carry the same local-auth header as
// the other dashboard mutations (see local-api-auth.ts).

import { getLocalApiAuthHeaders } from "./local-api-auth";

async function parseResponse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok || (body && typeof body === "object" && body.ok === false)) {
    const message =
      (body && typeof body === "object" && typeof body.error === "string" && body.error) ||
      `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

async function get<T>(path: string): Promise<T> {
  return parseResponse<T>(await fetch(path, { cache: "no-store" }));
}

async function mutate<T>(path: string, method: string, body?: unknown): Promise<T> {
  const headers = await getLocalApiAuthHeaders();
  return parseResponse<T>(
    await fetch(path, {
      method,
      headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}

export interface ProxyCoreStatus {
  installed: boolean;
  binary: string | null;
  version: string | null;
  running: boolean;
  pid: number | null;
  port: number;
  host: string;
  authDir: string;
  managementReachable: boolean;
  managementAuthError: boolean;
  autoStart: boolean;
  logFile: string;
}

export interface ProxyBridgeStatus {
  running: boolean;
  connecting: boolean;
  lastEventAt: string | null;
  lastError: string | null;
  eventsSeenSinceConnect: number;
  bucketCount: number;
}

export interface ProxyStatus {
  ok: true;
  core: ProxyCoreStatus;
  bridge: ProxyBridgeStatus;
}

export interface ProxyUsageOverview {
  total_requests: number;
  success_count: number;
  failure_count: number;
  canceled_count: number;
  success_rate: number | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  rpm: number;
  tpm: number;
  average_latency_ms: number | null;
  models: Array<{ model: string; requests: number; input_tokens: number; output_tokens: number; total_tokens: number }>;
  providers: Array<{ provider: string; requests: number; total_tokens: number; failures: number }>;
  timeline: Array<{ hour_start: string; requests: number; failures: number; total_tokens: number }>;
}

export interface ProxyRecord {
  id?: string;
  timestamp: string;
  latency_ms?: number;
  provider?: string;
  source?: string;
  model?: string;
  alias?: string;
  response_model?: string;
  failed?: boolean;
  canceled?: boolean;
  failure_status?: number;
  api_key_display?: string;
  auth_index?: string;
  tokens?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    totalTokens?: number;
  };
}

export interface ProxyAuthFile {
  name?: string;
  provider?: string;
  type?: string;
  status?: string;
  disabled?: boolean;
  models?: string[];
  email?: string;
  project_id?: string;
  [key: string]: unknown;
}

export const proxyApi = {
  status: () => get<ProxyStatus>("/api/proxy/status"),
  start: () => mutate<{ ok: true }>("/api/proxy/start", "POST"),
  stop: () => mutate<{ ok: true }>("/api/proxy/stop", "POST"),
  install: () => mutate<{ ok: true }>("/api/proxy/install", "POST"),
  setSettings: (settings: { autoStart?: boolean }) =>
    mutate<{ ok: true }>("/api/proxy/settings", "PUT", settings),

  overview: () => get<{ ok: true; overview: ProxyUsageOverview; bridge: ProxyBridgeStatus }>(
    "/api/proxy/usage/overview",
  ),
  records: (params: { page?: number; pageSize?: number; failed?: "true" | "false"; model?: string; provider?: string }) => {
    const query = new URLSearchParams();
    if (params.page !== undefined) query.set("page", String(params.page));
    if (params.pageSize !== undefined) query.set("pageSize", String(params.pageSize));
    if (params.failed) query.set("failed", params.failed);
    if (params.model) query.set("model", params.model);
    if (params.provider) query.set("provider", params.provider);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return get<{ ok: true; total: number; page: number; pageSize: number; records: ProxyRecord[] }>(
      `/api/proxy/usage/records${suffix}`,
    );
  },

  authFiles: () =>
    get<{ ok: true; files: ProxyAuthFile[]; statuses: unknown }>("/api/proxy/auth-files"),
  uploadAuthFile: (payload: { name: string; content: string }) =>
    mutate<{ ok: true }>("/api/proxy/auth-files", "POST", payload),
  deleteAuthFile: (name: string) =>
    mutate<{ ok: true }>(`/api/proxy/auth-files?name=${encodeURIComponent(name)}`, "DELETE"),
  refreshAuthFiles: () => mutate<{ ok: true }>("/api/proxy/auth-files/refresh", "POST"),

  keys: () => get<{ ok: true; keys: string[] | { items?: string[] } }>("/api/proxy/keys"),
  putKeys: (keys: string[]) => mutate<{ ok: true }>("/api/proxy/keys", "PUT", keys),

  configYaml: () => get<{ ok: true; yaml: string }>("/api/proxy/config.yaml"),
  putConfigYaml: (yaml: string) => mutate<{ ok: true }>("/api/proxy/config.yaml", "PUT", { yaml }),

  // --- OAuth channel model aliases ---
  oauthAliases: () => get<{ ok: true; aliases: Record<string, OAuthModelAlias[]> }>("/api/proxy/aliases/oauth"),
  saveOauthChannel: (channel: string, aliases: OAuthModelAlias[]) =>
    mutate<{ ok: true }>("/api/proxy/aliases/oauth", "PATCH", { channel, aliases }),
};

export interface OAuthModelAlias {
  name: string;
  alias: string;
  fork?: boolean;
  "display-name"?: string;
  "force-mapping"?: boolean;
}
