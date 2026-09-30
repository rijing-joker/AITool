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

export type ProviderSwitchApp = "claude" | "codex" | "gemini";

export interface ProviderSwitchProvider {
  id: string;
  name: string;
  category: "official" | "custom";
  settingsConfig: unknown;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderSwitchTargetFile {
  id: string;
  path: string;
  format: "json" | "toml" | "env";
  private: boolean;
  exists: boolean;
  size: number;
  modifiedAt: string | null;
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
  codexAuthStash: { stashedAt: string | null } | null;
  apps: ProviderSwitchAppState[];
}

export interface ProviderSwitchPreset {
  id: string;
  name: string;
  nameKey?: string;
  category: "official" | "custom";
  settingsConfig: unknown;
}

export interface ProviderSwitchLiveFile {
  ok: true;
  file: ProviderSwitchTargetFile;
  content: string | null;
  baseHash: string;
}

export interface ProviderSwitchLiveConflict {
  ok: false;
  error: "conflict";
  currentContent: string | null;
  currentHash: string;
}

export interface ProviderSwitchBackup {
  name: string;
  file: string;
  createdAt: string;
  size: number;
  target: string | null;
}

export const providerSwitchApi = {
  getStatus(): Promise<ProviderSwitchStatus> {
    return get<ProviderSwitchStatus>("/api/provider-switch/status");
  },

  getPresets(app: ProviderSwitchApp): Promise<{ ok: true; app: string; presets: ProviderSwitchPreset[] }> {
    return get(`/api/provider-switch/presets?app=${encodeURIComponent(app)}`);
  },

  getLive(app: ProviderSwitchApp, file: string): Promise<ProviderSwitchLiveFile> {
    return get(`/api/provider-switch/live?app=${encodeURIComponent(app)}&file=${encodeURIComponent(file)}`);
  },

  saveLive(
    app: ProviderSwitchApp,
    file: string,
    payload: { content: string; baseHash: string; policy?: "refuse" | "keepMine" },
  ): Promise<{ ok: true; backup: string | null }> {
    return mutate(
      `/api/provider-switch/live?app=${encodeURIComponent(app)}&file=${encodeURIComponent(file)}`,
      "PUT",
      payload,
    );
  },

  listBackups(app: ProviderSwitchApp): Promise<{ ok: true; app: string; backups: ProviderSwitchBackup[] }> {
    return get(`/api/provider-switch/backups?app=${encodeURIComponent(app)}`);
  },

  restoreBackup(
    app: ProviderSwitchApp,
    backup: string,
    file?: string,
  ): Promise<{ ok: true; restored: string; backup: string | null }> {
    return mutate("/api/provider-switch/backups/restore", "POST", { app, backup, file });
  },

  createProvider(
    app: ProviderSwitchApp,
    payload: { name: string; category: string; settingsConfig: unknown; notes?: string },
  ): Promise<{ ok: true; provider: ProviderSwitchProvider }> {
    return mutate("/api/provider-switch/providers", "POST", { app, ...payload });
  },

  updateProvider(
    app: ProviderSwitchApp,
    id: string,
    payload: { name?: string; category?: string; settingsConfig?: unknown; notes?: string },
  ): Promise<{ ok: true; provider: ProviderSwitchProvider }> {
    return mutate(`/api/provider-switch/providers/${encodeURIComponent(id)}`, "PUT", { app, ...payload });
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
