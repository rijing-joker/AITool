const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { ensureDir, writeFileAtomic, chmod600IfPossible, readJson } = require("../fs");
const store = require("./store");
const targets = require("./targets");
const presetsModule = require("./presets");
const backup = require("./backup");
const paths = require("./paths");

// Dashboard-facing REST surface for the provider-switch layer, mounted by
// local-api.js under /api/provider-switch/*. Mirrors the proxy/api.js
// contract: reads are open like the rest of the local API; mutations require
// the same local-mutation auth passed in as ctx.isAuthorizedLocalMutation.
//
// The switch endpoint ports cc-switch's transaction ordering: every live
// patch is computed in memory first (any parse failure aborts before
// touching disk), then each affected file is backed up, then written via
// tmp+rename, and only after all writes succeed is the current-provider
// pointer updated.

function json(res, data, status) {
  res.writeHead(status || 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function readLiveFile(file) {
  try {
    const stat = await fs.stat(file.path);
    const content = await fs.readFile(file.path, "utf8");
    return { exists: true, content, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch {
    return { exists: false, content: null, size: 0, modifiedAt: null };
  }
}

function fileMeta(file, live) {
  return {
    id: file.id,
    path: file.path,
    format: file.format,
    private: file.private,
    exists: live.exists,
    size: live.size,
    modifiedAt: live.modifiedAt,
  };
}

async function writeLiveFile(file, content) {
  await ensureDir(path.dirname(file.path));
  await writeFileAtomic(file.path, content);
  if (file.private) await chmod600IfPossible(file.path);
}

// ---------------------------------------------------------------------------
// Switch orchestration
// ---------------------------------------------------------------------------

async function switchProvider({ app, id }) {
  if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const state = await store.listProviders(app);
  const target = state.providers.find((p) => p.id === id);
  if (!target) throw new Error(`Provider not found: ${id}`);
  const prev = state.current
    ? state.providers.find((p) => p.id === state.current) || null
    : null;

  const files = paths.targetFiles(app);
  const lives = {};
  for (const file of files) {
    lives[file.id] = await readLiveFile(file);
  }

  // 1) Compute every patch in memory; any failure here writes nothing.
  const writes = []; // { file, content, parsedBackup? }
  let stashWrite = null; // { content } to persist before clearing auth.json
  let stashRestore = false;

  if (app === "claude") {
    const settingsFile = files.find((f) => f.id === "settings");
    const live = lives.settings.exists ? JSON.parse(lives.settings.content) : {};
    const next = targets.projectClaude({ prev, target, live });
    writes.push({ file: settingsFile, content: `${JSON.stringify(next, null, 2)}\n` });
  } else if (app === "codex") {
    const configFile = files.find((f) => f.id === "config");
    const authFile = files.find((f) => f.id === "auth");
    const liveAuth = lives.auth.exists ? JSON.parse(lives.auth.content) : {};
    const stash = await readJson(paths.codexAuthStashPath());
    const { configToml, auth } = targets.projectCodex({
      prev,
      target,
      liveToml: lives.config.exists ? lives.config.content : "",
      liveAuth,
      stash: stash && typeof stash === "object" ? stash.auth || null : null,
    });
    writes.push({ file: configFile, content: configToml });
    if (auth.action === "write") {
      writes.push({
        file: authFile,
        content: `${JSON.stringify(auth.content, null, 2)}\n`,
        skipBackupIfMissing: true,
      });
      stashRestore = !!auth.restoreStash;
    } else if (auth.action === "stash") {
      stashWrite = auth.stashContent;
      writes.push({ file: authFile, content: `{}\n`, skipBackupIfMissing: true });
    }
  } else if (app === "gemini") {
    const envFile = files.find((f) => f.id === "env");
    const next = targets.projectGemini({
      prev,
      target,
      liveEnv: lives.env.exists ? lives.env.content : "",
    });
    writes.push({ file: envFile, content: next });
  }

  // 2) Backup each existing live file before the first managed write.
  const backups = [];
  for (const write of writes) {
    if (!write.skipBackupIfMissing || lives[write.file.id].exists) {
      const created = await backup.createBackup(app, write.file.path);
      if (created) backups.push(created);
    }
  }

  // 3) Persist the auth stash before clearing auth.json so a crash between
  //    the two writes never loses the official login.
  if (stashWrite) {
    await ensureDir(paths.providerSwitchRoot());
    await writeFileAtomic(
      paths.codexAuthStashPath(),
      `${JSON.stringify({ auth: stashWrite, stashedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  // 4) Publish all file writes atomically.
  const wrote = [];
  for (const write of writes) {
    await writeLiveFile(write.file, write.content);
    wrote.push(write.file.path);
  }

  if (stashRestore) {
    try {
      await fs.unlink(paths.codexAuthStashPath());
    } catch {
      /* stash may be gone already */
    }
  }

  // 5) Commit the pointer only after every write landed.
  await store.setCurrentProvider(app, id);

  return { app, current: id, wrote, backups };
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

async function handleProviderSwitchApiRequest(req, res, url, ctx) {
  const p = url.pathname;
  const prefix = "/api/provider-switch";
  if (!p.startsWith(`${prefix}/`) && p !== prefix) return false;
  const method = String(req.method || "GET").toUpperCase();
  const requireMutation = () => {
    if (!ctx?.isAuthorizedLocalMutation?.(req)) {
      json(res, { ok: false, error: "Unauthorized" }, 401);
      return false;
    }
    return true;
  };

  try {
    if (p === `${prefix}/status`) {
      json(res, await buildStatus());
      return true;
    }

    if (p === `${prefix}/presets`) {
      const app = url.searchParams.get("app") || "claude";
      if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
      json(res, { ok: true, app, presets: presetsModule.listPresets(app) });
      return true;
    }

    const liveMatch = p.match(new RegExp(`^${prefix}/live$`));
    const defaultFileId = (app) => paths.targetFiles(app)[0]?.id || null;
    if (liveMatch && method === "GET") {
      const app = url.searchParams.get("app") || "claude";
      if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
      const fileId = url.searchParams.get("file") || defaultFileId(app);
      const file = paths.targetFile(app, fileId);
      if (!file) throw new Error(`Unknown live file: ${app}/${fileId}`);
      const live = await readLiveFile(file);
      json(res, {
        ok: true,
        file: fileMeta(file, live),
        content: live.exists ? live.content : null,
        baseHash: sha256(live.exists ? live.content : ""),
      });
      return true;
    }
    if (liveMatch && method === "PUT") {
      if (!requireMutation()) return true;
      const app = url.searchParams.get("app") || "claude";
      if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
      const fileId = url.searchParams.get("file") || defaultFileId(app);
      const file = paths.targetFile(app, fileId);
      if (!file) throw new Error(`Unknown live file: ${app}/${fileId}`);
      const body = await readJsonBody(req);
      if (typeof body.content !== "string") throw new Error("content must be a string");
      const live = await readLiveFile(file);
      const currentHash = sha256(live.exists ? live.content : "");
      if (currentHash !== body.baseHash && body.policy !== "keepMine") {
        json(
          res,
          {
            ok: false,
            error: "conflict",
            currentContent: live.exists ? live.content : null,
            currentHash,
          },
          409,
        );
        return true;
      }
      const created = await backup.createBackup(app, file.path, { force: true });
      await writeLiveFile(file, body.content);
      json(res, { ok: true, file: fileMeta(file, await readLiveFile(file)), backup: created });
      return true;
    }

    if (p === `${prefix}/backups` && method === "GET") {
      const app = url.searchParams.get("app") || "claude";
      if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
      json(res, { ok: true, app, backups: await backup.listBackups(app) });
      return true;
    }
    if (p === `${prefix}/backups/restore` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const app = body.app;
      if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
      const backupName = String(body.backup || "");
      const targetBasename = backup.backupTargetBasename(backupName);
      const file =
        paths.targetFiles(app).find((f) => path.basename(f.path) === targetBasename) ||
        paths.targetFile(app, String(body.file || ""));
      if (!file) throw new Error(`Unknown live file for backup: ${backupName}`);
      const content = await backup.readBackup(app, backupName);
      const created = await backup.createBackup(app, file.path, { force: true });
      await writeLiveFile(file, content);
      json(res, { ok: true, restored: file.path, backup: created });
      return true;
    }

    // Specific provider sub-routes must come before the generic
    // /providers/:id matcher (its regex would capture "reorder"/"import-live").
    if (p === `${prefix}/providers/reorder` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      await store.reorderProviders(body.app, body.orderedIds);
      json(res, { ok: true, ...(await store.listProviders(body.app)) });
      return true;
    }

    if (p === `${prefix}/providers/import-live` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const provider = await importFromLive(body.app, body.name);
      json(res, { ok: true, provider });
      return true;
    }

    const providersMatch = p.match(new RegExp(`^${prefix}/providers(?:/([\\w-]+))?$`));
    if (providersMatch) {
      const providerId = providersMatch[1] || null;
      if (method === "GET" && !providerId) {
        const app = url.searchParams.get("app") || "claude";
        if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
        json(res, { ok: true, app, ...(await store.listProviders(app)) });
        return true;
      }
      if (!requireMutation()) return true;
      if (method === "POST" && !providerId) {
        const body = await readJsonBody(req);
        const provider = await store.createProvider(body.app, body);
        json(res, { ok: true, provider });
        return true;
      }
      if (method === "PUT" && providerId) {
        const body = await readJsonBody(req);
        const provider = await store.updateProvider(body.app, providerId, body);
        // cc-switch interaction: editing the *current* provider takes effect
        // immediately — re-run the projection so the live files follow.
        let applied = null;
        const state = await store.listProviders(body.app);
        if (state.current === providerId) {
          applied = await switchProvider({ app: body.app, id: providerId });
        }
        json(res, { ok: true, provider, applied });
        return true;
      }
      if (method === "DELETE" && providerId) {
        const app = url.searchParams.get("app");
        await store.deleteProvider(app, providerId);
        json(res, { ok: true });
        return true;
      }
    }

    if (p === `${prefix}/editor-view` && method === "GET") {
      const app = url.searchParams.get("app") || "claude";
      const id = url.searchParams.get("id") || "";
      json(res, await buildEditorView(app, id));
      return true;
    }

    if (p === `${prefix}/speed-test` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const results = await speedTestEndpoints(body.urls || [], body.timeoutMs);
      json(res, { ok: true, results });
      return true;
    }

    if (p === `${prefix}/fetch-models` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await fetchModelList(body);
      json(res, { ok: true, ...result });
      return true;
    }

    if (p === `${prefix}/switch` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await switchProvider({ app: body.app, id: body.id });
      json(res, { ok: true, ...result });
      return true;
    }

    json(res, { ok: false, error: "Not Found" }, 404);
    return true;
  } catch (error) {
    json(res, { ok: false, error: error?.message || String(error) }, 400);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Import-from-live + editor view (cc-switch interaction parity)
// ---------------------------------------------------------------------------

// Create a provider from the current live config: extract only the
// provider-owned floor fields so user-owned keys are never absorbed.
async function importFromLive(app, name) {
  if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const files = paths.targetFiles(app);
  const lives = {};
  for (const file of files) {
    lives[file.id] = await readLiveFile(file);
  }
  if (!files.some((file) => lives[file.id].exists)) {
    throw new Error(`No live ${app} config to import from`);
  }
  let settingsConfig;
  if (app === "claude") {
    const live = lives.settings.exists ? JSON.parse(lives.settings.content) : {};
    settingsConfig = targets.extractClaudeConfig(live);
    if (!settingsConfig.env && !Object.keys(settingsConfig).length) {
      throw new Error("No provider key fields found in the live settings.json");
    }
  } else if (app === "codex") {
    settingsConfig = targets.extractCodexConfig(lives.config.exists ? lives.config.content : "");
  } else {
    settingsConfig = targets.extractGeminiConfig(lives.env.exists ? lives.env.content : "");
  }
  const providerName = String(name || "").trim() || "Imported config";
  return store.createProvider(app, {
    name: providerName,
    category: "custom",
    settingsConfig,
    notes: "",
    websiteUrl: "",
  });
}

// Editor view for one provider. When it is the current one, the live files
// may have been hand-edited since the switch — the returned settingsConfig
// overlays the live value on every key the provider owns (fromLive: true),
// mirroring cc-switch's read_live_provider_settings.
async function buildEditorView(app, id) {
  if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const state = await store.listProviders(app);
  const provider = state.providers.find((p) => p.id === id);
  if (!provider) throw new Error(`Provider not found: ${id}`);
  const isCurrent = state.current === id;
  let settingsConfig = provider.settingsConfig;
  let fromLive = false;
  if (isCurrent) {
    const lives = {};
    for (const file of paths.targetFiles(app)) {
      lives[file.id] = await readLiveFile(file);
    }
    settingsConfig = targets.mergeLiveIntoSettingsConfig(app, provider.settingsConfig, {
      claude: lives.settings?.exists ? JSON.parse(lives.settings.content) : null,
      codex: lives.config?.exists ? lives.config.content : "",
      gemini: lives.env?.exists ? lives.env.content : "",
    }[app]);
    fromLive = true;
  }
  return { ok: true, app, isCurrent, fromLive, settingsConfig };
}

// ---------------------------------------------------------------------------
// Endpoint speed test + model discovery (cc-switch EndpointSpeedTest /
// fetchModelsForConfig; both must run server-side because browsers cannot
// probe arbitrary API hosts cross-origin)
// ---------------------------------------------------------------------------

async function measureEndpoint(url, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A HEAD is not always implemented by relays; fall back to a ranged GET.
    let response = await fetch(url, { method: "HEAD", redirect: "manual", signal: controller.signal });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, redirect: "manual", signal: controller.signal });
    }
    // Any HTTP answer proves reachability; 401/404 still measure latency.
    return { url, ok: true, status: response.status, latencyMs: Date.now() - started, error: null };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return {
      url,
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      error: aborted ? "timeout" : String(error?.message || error).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function speedTestEndpoints(urls, timeoutMs) {
  const clean = [...new Set(urls.map((u) => String(u || "").trim()).filter((u) => /^https?:\/\//.test(u)))].slice(0, 12);
  const timeout = Math.min(Math.max(Number(timeoutMs) || 8000, 1000), 20000);
  return Promise.all(clean.map((url) => measureEndpoint(url, timeout)));
}

function extractModelIds(payload) {
  // OpenAI shape {data:[{id}]}, Gemini shape {models:[{name}]}, or a bare array.
  if (Array.isArray(payload)) return payload.map((m) => (typeof m === "string" ? m : m?.id || m?.name)).filter(Boolean);
  if (Array.isArray(payload?.data)) return payload.data.map((m) => m?.id || m?.name).filter(Boolean);
  if (Array.isArray(payload?.models)) {
    return payload.models.map((m) => String(m?.name || m?.id || "").replace(/^models\//, "")).filter(Boolean);
  }
  return null;
}

async function fetchModelList({ baseUrl, apiKey, modelsUrl, isFullUrl }) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const explicit = String(modelsUrl || "").trim();
  if (!base && !explicit) throw new Error("Base URL is required");
  const candidates = [];
  if (explicit && /^https?:\/\//.test(explicit)) {
    candidates.push(explicit);
  } else if (base) {
    // cc-switch probes /v1/models then /models; a full-URL endpoint is used
    // verbatim (the user already included the models path).
    if (isFullUrl) candidates.push(base);
    else candidates.push(`${base}/v1/models`, `${base}/models`);
  }

  const errors = [];
  for (const url of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const headers = { Accept: "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        errors.push(`HTTP ${response.status} for ${url}`);
        continue;
      }
      const payload = await response.json().catch(() => null);
      const models = payload ? extractModelIds(payload) : null;
      if (models && models.length) return { url, models: models.slice(0, 500) };
      errors.push(`no model list at ${url}`);
    } catch (error) {
      errors.push(`${error?.name === "AbortError" ? "timeout" : error?.message || error} for ${url}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(errors.join("; ") || "No model list found");
}

async function buildStatus() {
  const state = await store.readStore();
  const apps = [];
  for (const app of store.SUPPORTED_APPS) {
    const appState = state.apps[app];
    const files = [];
    for (const file of paths.targetFiles(app)) {
      const live = await readLiveFile(file);
      files.push(fileMeta(file, live));
    }
    apps.push({
      app,
      current: appState.current,
      providers: appState.providers,
      files,
    });
  }
  const stash = await readJson(paths.codexAuthStashPath());
  return {
    ok: true,
    storagePath: paths.providerSwitchRoot(),
    codexAuthStash: stash && typeof stash === "object" && stash.auth ? { stashedAt: stash.stashedAt || null } : null,
    apps,
  };
}

module.exports = { handleProviderSwitchApiRequest, switchProvider, buildStatus };
