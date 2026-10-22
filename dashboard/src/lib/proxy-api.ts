// REST client for the AiTool proxy layer (/api/proxy/* served by the local
// CLI server). Reads are open; mutations carry the same local-auth header as
// the other dashboard mutations (see local-api-auth.ts).

import { getLocalApiAuthHeaders } from "./local-api-auth";
import { copy } from "./copy";

export function configErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "PROXY_CONFIG_CONFLICT" ? copy("proxy.settings.conflict")
    : message === "PROXY_CONFIG_REVISION_REQUIRED" ? copy("proxy.settings.revision_required") : message;
}

async function parseResponse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok || (body && typeof body === "object" && body.ok === false)) {
    const message =
      (body && typeof body === "object" && typeof body.error === "string" && body.error) ||
      `HTTP ${res.status}`;
    throw new Error(configErrorMessage(message));
  }
  return body as T;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return parseResponse<T>(await fetch(path, { cache: "no-store", signal }));
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

export interface OpenCodeFreeCatalog {
  models: Array<{ id: string; name: string; protocol: string; policy: string; policyUrl: string }>;
  updatedAt: string | null;
  lastError: string | null;
}
export interface OpenCodeFreeStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  selectedModels: string[];
  catalog: OpenCodeFreeCatalog;
  lastInference: { at: string; model?: string; ok: boolean; code?: string; status?: number } | null;
}
export const opencodeFreeApi = {
  status: () => get<OpenCodeFreeStatus>("/api/proxy/opencode-free"),
  refresh: () => mutate<{ catalog: OpenCodeFreeCatalog }>("/api/proxy/opencode-free/refresh", "POST"),
  configure: (enabled: boolean, models: string[]) => mutate<OpenCodeFreeStatus>("/api/proxy/opencode-free", "POST", { enabled, models }),
};

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
  lifecycle?: string;
  recovery?: { state: string; armed: boolean; attempts: number; nextAttemptAt: number | null };
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
    cacheCreation1hTokens?: number;
    accountingVersion?: number;
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

// Progress snapshot of the core-binary install task (EasyCLIProxyAPI's
// CoreInstallTask, polled while the progress dialog is open).
export interface CoreInstallTask {
  running: boolean;
  cancellable: boolean;
  phase:
    | "checking"
    | "stopping"
    | "downloading"
    | "switching"
    | "extracting"
    | "restarting"
    | "complete"
    | "failed"
    | "canceled";
  source: string | null;
  downloaded: number;
  total: number | null;
  percent: number | null;
  message: string | null;
  error: string | null;
  result: { skipped: boolean; version: string; path: string; source: string } | null;
  startedAt: string;
  finishedAt: string | null;
}

export type CoreUpdateCheck = {
  installed: string | null;
  latest: string;
  source: string;
  hasUpdate: boolean;
};

export const proxyApi = {
  copilotStatus(): Promise<{ ok: true; clients: Array<{ client: "cli" | "vscode"; installed?: boolean; path: string; configured: boolean; canRestore: boolean; model?: string; error?: string }> }> {
    return get("/api/proxy/copilot");
  },
  connectCopilot(client: "cli" | "vscode", apiKey: string, model: string): Promise<{ ok: true; path: string }> {
    return mutate("/api/proxy/copilot/connect", "POST", { client, apiKey, model });
  },
  restoreCopilot(client: "cli" | "vscode"): Promise<{ ok: true }> {
    return mutate("/api/proxy/copilot/restore", "POST", { client });
  },
  copilotModels(apiKey: string): Promise<{ ok: true; models: string[] }> {
    return mutate("/api/proxy/copilot/models", "POST", { apiKey });
  },
  status: (signal?: AbortSignal) => get<ProxyStatus>("/api/proxy/status", signal),
  start: () => mutate<{ ok: true }>("/api/proxy/start", "POST"),
  stop: () => mutate<{ ok: true }>("/api/proxy/stop", "POST"),
  restart: () => mutate<{ ok: true }>("/api/proxy/restart", "POST"),
  coreUpdateCheck: (signal?: AbortSignal) =>
    get<{ ok: true; update: CoreUpdateCheck }>("/api/proxy/core-update", signal),
  install: () => mutate<{ ok: true; task: CoreInstallTask }>("/api/proxy/install", "POST"),
  installStatus: () => get<{ ok: true; task: CoreInstallTask | null }>("/api/proxy/install"),
  installCancel: () => mutate<{ ok: true; task: CoreInstallTask | null }>("/api/proxy/install/cancel", "POST"),
  setSettings: (settings: { autoStart?: boolean }) =>
    mutate<{ ok: true }>("/api/proxy/settings", "PUT", settings),
  openLogs: () => mutate<{ ok: true }>("/api/proxy/logs/open", "POST"),

  overview: (signal?: AbortSignal) => get<{ ok: true; overview: ProxyUsageOverview; bridge: ProxyBridgeStatus }>(
    "/api/proxy/usage/overview", signal,
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

  keys: () => get<{ ok: true; keys: string[] | { items?: string[] }; etag: string | null }>("/api/proxy/keys"),
  putKeys: (keys: string[], etag?: string | null) => mutate<{ ok: true; etag: string | null }>("/api/proxy/keys", "PUT", { keys, etag }),

  configYaml: () => get<{ ok: true; yaml: string; etag: string | null }>("/api/proxy/config.yaml"),
  putConfigYaml: (yaml: string, etag?: string | null) => mutate<{ ok: true; etag: string | null }>("/api/proxy/config.yaml", "PUT", { yaml, etag }),
};
