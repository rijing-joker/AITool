// REST client for the provider-switch layer (/api/provider-switch/* served
// by the local CLI server). Ported from cc-switch's providers API surface:
// reads are open; mutations carry the same local-auth header as the other
// dashboard mutations (see local-api-auth.ts).

import { getLocalApiAuthHeaders } from "./local-api-auth";

async function parseResponse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok || (body && typeof body === "object" && body.ok === false)) {
    const err = new Error(
      (body && typeof body === "object" && typeof body.error === "string" && body.error) ||
        `HTTP ${res.status}`,
    ) as Error & { payload?: unknown; status?: number };
    if (body && typeof body === "object") err.payload = body;
    err.status = res.status;
    throw err;
  }
  return body as T;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return parseResponse<T>(await fetch(path, { cache: "no-store", signal }));
}

async function mutate<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers = await getLocalApiAuthHeaders();
  return parseResponse<T>(
    await fetch(path, {
      method,
      signal,
      headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}
export interface DistributionRow { name?: string; description?: string; prompt?: string; dir?: string; apps: string[]; skills: string[]; mcp: string[]; partial?: boolean }
export interface DistributionState { subagents: DistributionRow[]; projects: DistributionRow[]; roleApps: string[]; projectApps: string[]; projectMcpApps: string[]; skills: Array<{ id: string; name: string }>; mcp: Array<{ id: string; name: string }> }
export const distributionApi = {
  list: () => get<DistributionState>("/api/provider-switch/distribution"),
  preview: (kind: string, row: DistributionRow) => mutate<{ revision: string; errors: string[]; changes: Array<{ path: string; action: string; app: string }> }>("/api/provider-switch/distribution", "POST", { action: "preview", kind, row }),
  apply: (kind: string, row: DistributionRow, revision: string) => mutate<{ results: Array<{ path: string; status: string; error?: string }>; recoveryPath: string }>("/api/provider-switch/distribution", "POST", { action: "apply", kind, row, revision }),
};

export type ProviderSwitchApp =
  | "claude"
  | "codex"
  | "gemini"
  | "agy"
  | "opencode"
  | "openclaw"
  | "mcode"
  | "hermes"
  | "pi"
  | "grokbuild";

export interface ProviderDiagnostic {
  app: string;
  status: string;
  providerId: string | null;
  appliedAt: string | null;
  revision: string;
  differences: { fileId: string; path: string; field: string; change: string }[];
  environment: { varName: string; sourceType: string; sourcePath: string }[];
  files: { id: string; path: string; exists: boolean }[];
}

export interface ProviderSwitchEnvConflict {
  varName: string;
  varValue: string;
  sourceType: "system" | "file";
  sourcePath: string;
}

export interface ProviderSwitchProvider {
  id: string;
  name: string;
  category: "official" | "custom";
  settingsConfig: unknown;
  notes: string;
  websiteUrl: string;
  icon: string;
  iconColor: string;
  meta: ProviderSwitchProviderMeta;
  sortIndex: number;
  createdAt: string;
  updatedAt: string;
  /** Set when the row's base URL matches a supported plan provider (cc-switch coding_plan). */
  quotaProvider?: string | null;
}

export interface ProviderSwitchQuotaTier {
  id: string;
  label: string;
  used_percent: number;
  reset_at: string | null;
  limit_window_seconds?: number | null;
}

export interface ProviderSwitchQuota {
  ok: boolean;
  provider: string;
  plan?: string | null;
  status?: string | null;
  tiers?: ProviderSwitchQuotaTier[];
  credits?: { monthly: number; purchased: number; free: number; spent: number } | null;
  credentialStatus?: "valid" | "expired" | "error";
  error?: string;
  cached?: boolean;
}

// Port of cc-switch's ProviderMeta, reduced to the keys this port consumes.
export interface ProviderSwitchProviderMeta {
  apiFormat?: string;
  apiKeyField?: string;
  customUserAgent?: string;
  localProxyRequestOverrides?: { headers?: string; body?: string };
  endpointAutoSelect?: boolean;
  isFullUrl?: boolean;
  customEndpoints?: string[];
  [key: string]: unknown;
}

export interface ProviderSwitchFormFieldOption {
  value: string;
  labelKey: string;
}

// Declarative port of cc-switch's templateValues: the dialog renders one
// input per field and writes the value into the settingsConfig template at
// the dotted path.
export interface ProviderSwitchFormField {
  id: string;
  path: string;
  labelKey: string;
  placeholder?: string;
  hintKey?: string;
  secret?: boolean;
  type?: "text" | "select";
  options?: ProviderSwitchFormFieldOption[];
}

export interface ProviderSwitchTargetFile {
  id: string;
  path: string;
  format: "json" | "toml" | "env" | "yaml";
  private: boolean;
  exists: boolean;
  size: number;
  modifiedAt: string | null;
}

export interface ProviderSwitchPreset {
  id: string;
  name: string;
  nameKey?: string;
  hintKey?: string;
  group: "official" | "community" | "local" | "custom";
  icon?: string;
  color?: string;
  websiteUrl?: string;
  endpointCandidates?: string[];
  modelsUrl?: string;
  settingsConfig: unknown;
  meta?: ProviderSwitchProviderMeta;
  formFields: ProviderSwitchFormField[];
}

export interface ProviderSwitchAppState {
  app: ProviderSwitchApp;
  current: string | null;
  providers: ProviderSwitchProvider[];
  files: ProviderSwitchTargetFile[];
}

export interface ProviderSwitchStatus {
  ok: true;
  storagePath: string;
  // cc-switch's app-visibility setting: which agent tabs the dashboard shows.
  visibleApps: Record<ProviderSwitchApp, boolean>;
  codexAuthStash: { stashedAt: string | null } | null;
  apps: ProviderSwitchAppState[];
}

export interface CodexClientStatus {
  daemonRunning: boolean;
  daemon: boolean;
  others: boolean;
  auth: boolean;
  catalog: boolean;
  unverified: boolean;
  revision: string;
}

export interface ProviderSwitchBackup {
  name: string;
  file: string;
  createdAt: string;
  size: number;
  target: string | null;
}

export interface ProviderSwitchProviderPayload {
  name?: string;
  category?: string;
  settingsConfig?: unknown;
  notes?: string;
  websiteUrl?: string;
  icon?: string;
  iconColor?: string;
  meta?: ProviderSwitchProviderMeta;
  // cc-switch's EditorSave: the full projected config the dialog opened with;
  // on save the backend splits floor keys (row) from the user's other edits
  // (three-way write into the live files). slotKey: additive apps' echo of
  // the container entry the row owns (from the editor view). draft: the initial
  // Claude add fragment, identifying exclusive keys owned by the new row.
  editor?: { base: unknown; draft?: unknown; onConflict?: ProviderSwitchConflictPolicy; slotKey?: string };
}

export type ProviderSwitchConflictPolicy = "keepMine" | "keepTheirs";

// The full post-switch projection (cc-switch's ProviderEditorView): the
// config file as it would look after switching to the provider. Exactly one
// of settings / configToml+authJson / envText / configText is present, per
// app (configText: additive apps' whole native file; slotKey echoes which
// container entry the row owns).
export interface ProviderSwitchEditorView {
  ok: true;
  app: ProviderSwitchApp;
  isCurrent: boolean;
  inactive: Array<{ path: string[]; value: unknown }>;
  settings?: Record<string, unknown>;
  configToml?: string;
  authJson?: unknown;
  envText?: string;
  configText?: string;
  slotKey?: string;
  codexOfficialModelsReason?: "noCli" | "failed" | null;
}

// Universal provider (cc-switch's 统一供应商): one shared base URL + API key
// synced into deterministic claude/codex/gemini child providers.
export interface ProviderSwitchUniversalProvider {
  id: string;
  name: string;
  providerType: string;
  apps: { claude: boolean; codex: boolean; gemini: boolean };
  baseUrl: string;
  apiKey: string;
  models?: {
    claude?: { model?: string; haikuModel?: string; sonnetModel?: string; opusModel?: string };
    codex?: { model?: string; reasoningEffort?: string };
    gemini?: { model?: string };
  };
  websiteUrl?: string;
  notes?: string;
  icon?: string;
  iconColor?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  sortIndex?: number;
}

export const universalProvidersApi = {
  list(): Promise<{ ok: true; providers: ProviderSwitchUniversalProvider[] }> {
    return get("/api/provider-switch/universal");
  },
  upsert(provider: Partial<ProviderSwitchUniversalProvider> & { id?: string }): Promise<{ ok: true; provider: ProviderSwitchUniversalProvider }> {
    return mutate("/api/provider-switch/universal", "PUT", { provider });
  },
  sync(id: string): Promise<{ ok: true }> {
    return mutate("/api/provider-switch/universal/sync", "POST", { id });
  },
  remove(id: string): Promise<{ ok: true; removed: boolean }> {
    return mutate("/api/provider-switch/universal/delete", "POST", { id });
  },
};

// Profile (cc-switch's services/profile): a named snapshot of one app's
// providers/MCP/skills/prompts state with a per-app current marker.
export interface ProviderSwitchProfile {
  id: string;
  name: string;
  payload: {
    providers: Record<string, string | null>;
    mcp: Record<string, string[] | null>;
    skills: Record<string, string[] | null>;
    prompts: Record<string, string | null>;
  };
  createdAt: string | null;
  updatedAt: string | null;
  capturedApps?: string[];
}

export interface ProfileBundlePreview {
  ok: true;
  revision: string;
  results: { app: string; ready: boolean; errors: string[]; providerId: string | null; mcpCount: number | null; skillCount: number | null; promptId: string | null }[];
}

export const profilesApi = {
  list(): Promise<{ ok: true; profiles: ProviderSwitchProfile[]; currentIds: Record<string, string | null> }> {
    return get("/api/provider-switch/profiles");
  },
  create(body: { name: string; app?: string; apps?: string[] }): Promise<{ ok: true; profile: ProviderSwitchProfile }> {
    return mutate("/api/provider-switch/profiles", "POST", body);
  },
  previewBundle(id: string, apps: string[]): Promise<ProfileBundlePreview> {
    return mutate("/api/provider-switch/profiles/preview-bundle", "POST", { id, apps });
  },
  applyBundle(id: string, apps: string[], revision: string): Promise<{ ok: true; results: { app: string; status: string; warnings: string[] }[]; recoveryPath: string }> {
    return mutate("/api/provider-switch/profiles/apply-bundle", "POST", { id, apps, revision });
  },
  update(body: { id: string; name?: string; resnapshot?: boolean; app?: string }): Promise<{ ok: true; profile: ProviderSwitchProfile }> {
    return mutate("/api/provider-switch/profiles/update", "POST", body);
  },
  remove(id: string): Promise<{ ok: true }> {
    return mutate("/api/provider-switch/profiles/delete", "POST", { id });
  },
  apply(body: { id: string; app: string }): Promise<{ ok: true; warnings: string[] }> {
    return mutate("/api/provider-switch/profiles/apply", "POST", body);
  },
};

export const piPromptFilesApi = {  get(kind: PiPromptFileKind) {
    return providerSwitchApi.getPiPromptFile(kind);
  },
  replace(kind: PiPromptFileKind, content: string, expectedRevision: string | null) {
    return providerSwitchApi.replacePiPromptFile(kind, content, expectedRevision);
  },
  remove(kind: PiPromptFileKind, expectedRevision: string | null) {
    return providerSwitchApi.deletePiPromptFile(kind, expectedRevision);
  },
};

export const providerSwitchApi = {
  diagnostic(app: ProviderSwitchApp, signal?: AbortSignal): Promise<{ ok: true; diagnostic: ProviderDiagnostic }> {
    return get(`/api/provider-switch/diagnostics?app=${encodeURIComponent(app)}`, signal);
  },
  probeDiagnostic(app: ProviderSwitchApp, signal?: AbortSignal): Promise<{ ok: true; probe: { status: string; httpStatus?: number; latencyMs?: number } }> {
    return mutate("/api/provider-switch/diagnostics/probe", "POST", { app }, signal);
  },
  previewDiagnostic(app: ProviderSwitchApp, showValues = false): Promise<{ ok: true; revision: string; providerId: string; files: { id: string; path: string; changed: boolean; before?: string; after?: string }[] }> {
    return mutate("/api/provider-switch/diagnostics/preview", "POST", { app, showValues });
  },
  repairDiagnostic(app: ProviderSwitchApp, revision: string): Promise<{ ok: true; wrote: string[] }> {
    return mutate("/api/provider-switch/diagnostics/repair", "POST", { app, revision });
  },
  launchAgy(id: string) { return mutate("/api/provider-switch/agy/launch", "POST", { id }); },
  migrateHermesId(id: string): Promise<{ ok: true; slotKey: string }> {
    return mutate("/api/provider-switch/hermes/migrate-id", "POST", { id });
  },
  getCodexClient(signal?: AbortSignal): Promise<{ ok: true; client: CodexClientStatus }> {
    return get("/api/provider-switch/codex-client", signal);
  },
  restartCodexDaemon(): Promise<{ ok: true; outcome: "restarted" | "notRunning" }> {
    return mutate("/api/provider-switch/codex-client/restart", "POST", {});
  },
  acknowledgeCodexClients(): Promise<{ ok: true }> {
    return mutate("/api/provider-switch/codex-client/acknowledge", "POST", {});
  },
  getStatus(): Promise<ProviderSwitchStatus> {
    return get<ProviderSwitchStatus>("/api/provider-switch/status");
  },

  async getFailover(signal?: AbortSignal): Promise<{ ok: true; failover: ProviderSwitchFailover }> {
    return parseResponse(await fetch("/api/provider-switch/failover", { cache: "no-store", signal }));
  },

  // Authenticated evaluation pass: this is the only path that may execute an
  // auto-switch (live config writes); the open GET never switches.
  runFailoverEvaluation(): Promise<{ ok: true; failover: ProviderSwitchFailover }> {
    return mutate("/api/provider-switch/failover/evaluate", "POST", {});
  },

  getPiPromptFile(kind: PiPromptFileKind): Promise<{ ok: true; file: PiPromptFile }> {
    return get(`/api/provider-switch/pi-prompt-files?kind=${encodeURIComponent(kind)}`);
  },

  replacePiPromptFile(
    kind: PiPromptFileKind,
    content: string,
    expectedRevision: string | null,
  ): Promise<{ ok: true; file: PiPromptFile }> {
    return mutate("/api/provider-switch/pi-prompt-files/replace", "POST", { kind, content, expectedRevision });
  },

  deletePiPromptFile(kind: PiPromptFileKind, expectedRevision: string | null): Promise<{ ok: true; file: PiPromptFile }> {
    return mutate("/api/provider-switch/pi-prompt-files/delete", "POST", { kind, expectedRevision });
  },

  exportEncryptedBackup(passphrase: string): Promise<{ ok: true; payload: unknown }> {
    return mutate("/api/provider-switch/backup/export", "POST", { passphrase });
  },

  importEncryptedBackup(passphrase: string, payload: unknown): Promise<{ ok: true; restored: string[] }> {
    return mutate("/api/provider-switch/backup/import", "POST", { passphrase, payload });
  },

  updateFailover(config: Partial<ProviderSwitchFailoverConfig>): Promise<{ ok: true; config: ProviderSwitchFailoverConfig }> {
    return mutate("/api/provider-switch/failover", "PUT", { failover: config });
  },

  clearFailoverCooldown(app: ProviderSwitchApp, id: string): Promise<{ ok: true }> {
    return mutate("/api/provider-switch/failover/cooldowns", "DELETE", { app, id });
  },

  updateVisibleApps(
    visibleApps: Record<ProviderSwitchApp, boolean>,
  ): Promise<{ ok: true; visibleApps: Record<ProviderSwitchApp, boolean> }> {
    return mutate("/api/provider-switch/settings", "POST", { visibleApps });
  },

  getPresets(app: ProviderSwitchApp): Promise<{ ok: true; app: string; presets: ProviderSwitchPreset[] }> {
    return get(`/api/provider-switch/presets?app=${encodeURIComponent(app)}`);
  },

  getQuota(
    app: ProviderSwitchApp,
    id: string,
    opts?: { nocache?: boolean },
  ): Promise<{ ok: true; app: string; id: string; quota: ProviderSwitchQuota }> {
    const nocache = opts?.nocache ? "&nocache=1" : "";
    return get(`/api/provider-switch/quota?app=${encodeURIComponent(app)}&id=${encodeURIComponent(id)}${nocache}`);
  },

  getEditorView(
    app: ProviderSwitchApp,
    settingsConfig: unknown,
    opts?: { id?: string; category?: string },
  ): Promise<ProviderSwitchEditorView> {
    return mutate(`/api/provider-switch/editor-view`, "POST", {
      app,
      settingsConfig,
      ...(opts?.id ? { id: opts.id } : {}),
      ...(opts?.category ? { category: opts.category } : {}),
    });
  },

  importFromLive(
    app: ProviderSwitchApp,
    name?: string,
  ): Promise<{ ok: true; provider: ProviderSwitchProvider }> {
    return mutate("/api/provider-switch/providers/import-live", "POST", { app, name });
  },

  reorderProviders(
    app: ProviderSwitchApp,
    orderedIds: string[],
  ): Promise<{ ok: true; app: string; current: string | null; providers: ProviderSwitchProvider[] }> {
    return mutate("/api/provider-switch/providers/reorder", "POST", { app, orderedIds });
  },

  listBackups(app: ProviderSwitchApp): Promise<{ ok: true; app: string; backups: ProviderSwitchBackup[] }> {
    return get(`/api/provider-switch/backups?app=${encodeURIComponent(app)}`);
  },

  restoreBackup(app: ProviderSwitchApp, backup: string): Promise<{ ok: true; restored: string; backup: string | null }> {
    return mutate("/api/provider-switch/backups/restore", "POST", { app, backup });
  },

  createProvider(
    app: ProviderSwitchApp,
    payload: ProviderSwitchProviderPayload,
  ): Promise<{ ok: true; provider: ProviderSwitchProvider }> {
    return mutate("/api/provider-switch/providers", "POST", { app, ...payload });
  },

  updateProvider(
    app: ProviderSwitchApp,
    id: string,
    payload: ProviderSwitchProviderPayload,
  ): Promise<{ ok: true; provider: ProviderSwitchProvider; applied: { wrote: string[] } | null }> {
    return mutate(`/api/provider-switch/providers/${encodeURIComponent(id)}`, "PUT", { app, ...payload });
  },

  speedTest(
    urls: string[],
    timeoutMs?: number,
  ): Promise<{ ok: true; results: Array<{ url: string; ok: boolean; status: number | null; latencyMs: number; error: string | null }> }> {
    return mutate("/api/provider-switch/speed-test", "POST", { urls, timeoutMs });
  },

  fetchModels(payload: {
    app?: ProviderSwitchApp;
    baseUrl: string;
    apiKey?: string;
    modelsUrl?: string;
    isFullUrl?: boolean;
    requestHeaders?: string;
  }): Promise<{ ok: true; url: string; models: string[] }> {
    return mutate("/api/provider-switch/fetch-models", "POST", payload);
  },

  deleteProvider(app: ProviderSwitchApp, id: string): Promise<{ ok: true }> {
    return mutate(
      `/api/provider-switch/providers/${encodeURIComponent(id)}?app=${encodeURIComponent(app)}`,
      "DELETE",
    );
  },

  duplicateProvider(
    app: ProviderSwitchApp,
    id: string,
  ): Promise<{ ok: true; provider: ProviderSwitchProvider }> {
    return mutate("/api/provider-switch/providers/duplicate", "POST", { app, id });
  },

  checkEnvConflicts(): Promise<{
    ok: true;
    conflicts: Record<string, ProviderSwitchEnvConflict[]>;
  }> {
    return get("/api/provider-switch/env-conflicts");
  },

  deleteEnvConflicts(
    conflicts: ProviderSwitchEnvConflict[],
  ): Promise<{ ok: true; backupPath: string; deleted: number; failed: string[] }> {
    return mutate("/api/provider-switch/env-conflicts/delete", "POST", { conflicts });
  },

  restoreEnvConflicts(
    backupPath: string,
  ): Promise<{ ok: true; restored: number; failed: string[] }> {
    return mutate("/api/provider-switch/env-conflicts/restore", "POST", { backupPath });
  },

  switchProvider(
    app: ProviderSwitchApp,
    id: string,
  ): Promise<{ ok: true; app: string; current: string; wrote: string[]; backups: string[] }> {
    return mutate("/api/provider-switch/switch", "POST", { app, id });
  },
};

// ---------------------------------------------------------------------------
// MCP servers (cc-switch's unified mcp_servers module)
// ---------------------------------------------------------------------------

export type ProviderSwitchFailoverConfig = {
  enabled: boolean;
  autoSwitch: boolean;
  windowMinutes: number;
  minRequests: number;
  failureRatePct: number;
  cooldownMinutes: number;
};

export type ProviderSwitchFailoverHealth = {
  requests: number;
  failed: number;
  ratePct: number;
};

export type ProviderSwitchFailoverApp = {
  current: string | null;
  health: ProviderSwitchFailoverHealth | null;
  cooldown: { until: number; reason: string; since: number; remainingMs: number } | null;
  suggestion: { id: string; name: string } | null;
  switchedTo: string | null;
  switchError?: string;
};

export type ProviderSwitchFailover = {
  config: ProviderSwitchFailoverConfig;
  apps: Partial<Record<ProviderSwitchApp, ProviderSwitchFailoverApp>>;
  suggestions: { app: ProviderSwitchApp; from: string; to: string; id: string }[];
  cooldowns: { app: ProviderSwitchApp; id: string; until: number; reason: string; remainingMs: number }[];
  actions: { app: ProviderSwitchApp; from: string; to: string; at: number }[];
};

export type PiPromptFileKind = "system_override" | "system_append";

export type PiPromptFile = {
  kind: PiPromptFileKind;
  path: string;
  exists: boolean;
  revision: string | null;
  content: string;
};

export type McpAppId = "claude" | "codex" | "gemini" | "agy" | "grokbuild" | "opencode" | "hermes" | "mcode" | "pi";

export interface McpServerSpec {
  type?: "stdio" | "http" | "sse" | string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface McpServer {
  id: string;
  name: string;
  server: McpServerSpec;
  apps: Record<McpAppId, boolean>;
  description?: string;
  homepage?: string;
  docs?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  disabledTools?: Partial<Record<McpAppId, string[]>>;
}

export interface McpCheckResult {
  status: "checking" | "healthy" | "failed" | "cancelled" | "stale";
  stage: "connect" | "initialize" | "initialized" | "tools" | "done";
  reason?: string;
  revision: string;
  checkedAt: string;
  durationMs?: number;
  tools: { name: string; description: string }[];
}

export interface McpUpsertPayload {
  id: string;
  name?: string;
  server: McpServerSpec;
  apps?: Partial<Record<McpAppId, boolean>>;
  description?: string;
  homepage?: string;
  docs?: string;
  tags?: string[];
}

export interface McpMutationResult {
  ok: true;
  servers: McpServer[];
  failures: string[];
}

export const mcpApi = {
  list(): Promise<{ ok: true; servers: McpServer[]; apps: McpAppId[]; checks: Record<string, McpCheckResult | null>; toolFilterApps: McpAppId[] }> {
    return get("/api/provider-switch/mcp");
  },

  check(id: string, signal?: AbortSignal): Promise<{ ok: true; check: McpCheckResult }> {
    return mutate("/api/provider-switch/mcp/check", "POST", { id }, signal);
  },

  tool(id: string, app: McpAppId, tool: string, enabled: boolean, revision: string): Promise<McpMutationResult> {
    return mutate("/api/provider-switch/mcp/tool", "POST", { id, app, tool, enabled, revision });
  },

  upsert(server: McpUpsertPayload): Promise<McpMutationResult> {
    return mutate("/api/provider-switch/mcp", "POST", { server });
  },

  remove(id: string): Promise<McpMutationResult> {
    return mutate("/api/provider-switch/mcp/delete", "POST", { id });
  },

  toggle(id: string, app: McpAppId, enabled: boolean): Promise<McpMutationResult> {
    return mutate("/api/provider-switch/mcp/toggle", "POST", { id, app, enabled });
  },

  import(apps?: McpAppId[]): Promise<{ ok: true; changed: number; skipped: string[]; servers: McpServer[] }> {
    return mutate("/api/provider-switch/mcp/import", "POST", apps?.length ? { apps } : {});
  },

  sync(apps?: McpAppId[]): Promise<{ ok: true; failures: string[] }> {
    return mutate("/api/provider-switch/mcp/sync", "POST", apps?.length ? { apps } : {});
  },
};

// ---------------------------------------------------------------------------
// Prompts (cc-switch's prompt module)
// ---------------------------------------------------------------------------

export type PromptAppId =
  | "claude"
  | "codex"
  | "gemini"
  | "agy"
  | "grokbuild"
  | "opencode"
  | "openclaw"
  | "hermes"
  | "pi"
  | "mcode";

export interface PromptEntry {
  id: string;
  name: string;
  content: string;
  description?: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PromptUpsertPayload {
  id: string;
  name?: string;
  content: string;
  description?: string;
  enabled?: boolean;
}

export interface PromptListResult {
  ok: true;
  app: PromptAppId;
  prompts: PromptEntry[];
  targetPath: string;
}

export interface PromptMutationResult {
  ok: true;
  prompts: PromptEntry[];
  targetPath: string;
}

export const promptsApi = {
  list(app: PromptAppId): Promise<PromptListResult> {
    return get(`/api/provider-switch/prompts?app=${encodeURIComponent(app)}`);
  },

  upsert(app: PromptAppId, prompt: PromptUpsertPayload): Promise<PromptMutationResult> {
    return mutate("/api/provider-switch/prompts", "POST", { app, prompt });
  },

  enable(app: PromptAppId, id: string): Promise<PromptMutationResult> {
    return mutate("/api/provider-switch/prompts/enable", "POST", { app, id });
  },

  remove(app: PromptAppId, id: string): Promise<PromptMutationResult> {
    return mutate("/api/provider-switch/prompts/delete", "POST", { app, id });
  },

  import(app: PromptAppId): Promise<PromptMutationResult> {
    return mutate("/api/provider-switch/prompts/import", "POST", { app });
  },
};

// ---------------------------------------------------------------------------
// Skills (cc-switch services/skill.rs, v1)
// ---------------------------------------------------------------------------

export interface ProviderSwitchSkill {
  id: string;
  name: string;
  description: string;
  sourceDir: string;
  apps: Record<string, boolean>;
}

export const skillsApi = {
  list(): Promise<{ ok: true; skills: ProviderSwitchSkill[]; apps: ProviderSwitchApp[] }> {
    return get("/api/provider-switch/skills");
  },

  import(): Promise<{ ok: true; skills: ProviderSwitchSkill[]; discovered: number }> {
    return mutate("/api/provider-switch/skills/import", "POST", {});
  },

  toggle(
    id: string,
    app: ProviderSwitchApp,
    enabled: boolean,
  ): Promise<{ ok: true; skills: ProviderSwitchSkill[]; failures: string[] }> {
    return mutate("/api/provider-switch/skills/toggle", "POST", { id, app, enabled });
  },

  sync(apps?: ProviderSwitchApp[]): Promise<{ ok: true; failures: string[] }> {
    return mutate("/api/provider-switch/skills/sync", "POST", { apps });
  },
};
