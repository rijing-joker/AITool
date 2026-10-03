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

export type ProviderSwitchApp =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "openclaw"
  | "mcode"
  | "hermes"
  | "pi"
  | "grokbuild";

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
  group: "official" | "community" | "custom";
  icon?: string;
  color?: string;
  websiteUrl?: string;
  endpointCandidates?: string[];
  modelsUrl?: string;
  settingsConfig: unknown;
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
  // the container entry the row owns (from the editor view).
  editor?: { base: unknown; onConflict?: ProviderSwitchConflictPolicy; slotKey?: string };
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
}

export const providerSwitchApi = {
  getStatus(): Promise<ProviderSwitchStatus> {
    return get<ProviderSwitchStatus>("/api/provider-switch/status");
  },

  updateVisibleApps(
    visibleApps: Record<ProviderSwitchApp, boolean>,
  ): Promise<{ ok: true; visibleApps: Record<ProviderSwitchApp, boolean> }> {
    return mutate("/api/provider-switch/settings", "POST", { visibleApps });
  },

  getPresets(app: ProviderSwitchApp): Promise<{ ok: true; app: string; presets: ProviderSwitchPreset[] }> {
    return get(`/api/provider-switch/presets?app=${encodeURIComponent(app)}`);
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
    baseUrl: string;
    apiKey?: string;
    modelsUrl?: string;
    isFullUrl?: boolean;
  }): Promise<{ ok: true; url: string; models: string[] }> {
    return mutate("/api/provider-switch/fetch-models", "POST", payload);
  },

  deleteProvider(app: ProviderSwitchApp, id: string): Promise<{ ok: true }> {
    return mutate(
      `/api/provider-switch/providers/${encodeURIComponent(id)}?app=${encodeURIComponent(app)}`,
      "DELETE",
    );
  },

  switchProvider(
    app: ProviderSwitchApp,
    id: string,
  ): Promise<{ ok: true; app: string; current: string; wrote: string[]; backups: string[] }> {
    return mutate("/api/provider-switch/switch", "POST", { app, id });
  },
};
