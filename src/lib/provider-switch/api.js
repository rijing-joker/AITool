const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { ensureDir, writeFileAtomic, chmod600IfPossible, readJson } = require("../fs");
const store = require("./store");
const targets = require("./targets");
const presetsModule = require("./presets");
const backup = require("./backup");
const paths = require("./paths");
const catalog = require("./catalog");
const editor = require("./editor");
const additive = require("./additive");
const mcp = require("./mcp");
const prompts = require("./prompts");
const piPromptFiles = require("./pi-prompt-files");
const backupExport = require("./backup-export");
const quota = require("./quota");
const failover = require("./failover");

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

// Files a backup may belong to. MCP projections write live files that are not
// provider-switch targets (claude's ~/.claude.json, gemini's settings.json,
// MiniMax's mcp.json), so a restore has to consider them too — otherwise the
// backup is listed in the UI but can never be applied.
const BACKUP_FORMATS = { ".toml": "toml", ".yaml": "yaml", ".yml": "yaml" };

function restoreTargets(app) {
  const live = mcp.mcpLiveFiles()[app];
  if (!live) return paths.targetFiles(app);
  return [
    ...paths.targetFiles(app),
    {
      id: `mcp-${app}`,
      path: live.path,
      format: BACKUP_FORMATS[path.extname(live.path)] || "json",
      private: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Switch orchestration
// ---------------------------------------------------------------------------

async function readLives(app) {
  const lives = {};
  for (const file of paths.targetFiles(app)) {
    lives[file.id] = await readLiveFile(file);
  }
  return lives;
}

async function readCodexStash() {
  const stash = await readJson(paths.codexAuthStashPath());
  return stash && typeof stash === "object" ? stash.auth || null : null;
}

// Compute every live patch for a switch in memory (cc-switch's transaction
// ordering: any parse failure aborts before touching disk). `lives` carries
// the current file contents; the editor save passes pre-patched contents so
// its global-setting changes and the floor projection land in one write.
function computeSwitchPlan(app, prev, target, lives, stash) {
  const files = paths.targetFiles(app);
  const writes = []; // { file, content, parsedBackup? }
  let stashWrite = null; // { content } to persist before clearing auth.json
  let stashRestore = false;
  let catalogAction = { action: "keep" };

  if (app === "claude") {
    const settingsFile = files.find((f) => f.id === "settings");
    const live = lives.settings.exists ? JSON.parse(lives.settings.content) : {};
    const next = targets.projectClaude({ prev, target, live });
    writes.push({ file: settingsFile, content: `${JSON.stringify(next, null, 2)}\n` });
  } else if (app === "codex") {
    const configFile = files.find((f) => f.id === "config");
    const authFile = files.find((f) => f.id === "auth");
    const liveAuth = lives.auth.exists ? JSON.parse(lives.auth.content) : {};
    const { configToml, auth, catalog: sidecar } = targets.projectCodex({
      prev,
      target,
      liveToml: lives.config.exists ? lives.config.content : "",
      liveAuth,
      stash,
    });
    catalogAction = sidecar;
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
  } else if (additive.isAdditiveApp(app)) {
    // Additive apps: one native config document; a missing file is created on
    // the first switch (cc-switch's edit_config does the same for OpenCode).
    const configFile = files.find((f) => f.id === "config");
    const live = lives.config.exists ? additive.parseLive(app, lives.config.content) : {};
    const next = additive.projectAdditive(app, { prev, target, live });
    writes.push({ file: configFile, content: additive.serializeLive(app, next), skipBackupIfMissing: true });
  }

  return { writes, stashWrite, stashRestore, catalogAction };
}

// Backup each existing live file, persist the auth stash, then publish all
// file writes atomically (tmp+rename) and handle the catalog sidecar.
async function persistSwitchPlan(app, plan) {
  const backups = [];
  for (const write of plan.writes) {
    if (!write.skipBackupIfMissing || (await liveExists(write.file))) {
      const created = await backup.createBackup(app, write.file.path);
      if (created) backups.push(created);
    }
  }

  if (plan.stashWrite) {
    await ensureDir(paths.providerSwitchRoot());
    await writeFileAtomic(
      paths.codexAuthStashPath(),
      `${JSON.stringify({ auth: plan.stashWrite, stashedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  const wrote = [];
  for (const write of plan.writes) {
    await writeLiveFile(write.file, write.content);
    wrote.push(write.file.path);
  }

  if (plan.catalogAction.action === "write") {
    const catalogPath = paths.codexModelCatalogPath();
    await ensureDir(path.dirname(catalogPath));
    await writeFileAtomic(catalogPath, catalog.buildCodexCatalog(plan.catalogAction.models));
    wrote.push(catalogPath);
  } else if (plan.catalogAction.action === "remove") {
    try {
      await fs.unlink(paths.codexModelCatalogPath());
    } catch {
      /* catalog file may be gone already */
    }
  }

  if (plan.stashRestore) {
    try {
      await fs.unlink(paths.codexAuthStashPath());
    } catch {
      /* stash may be gone already */
    }
  }

  return { wrote, backups };
}

async function liveExists(file) {
  try {
    await fs.stat(file.path);
    return true;
  } catch {
    return false;
  }
}

async function switchProvider({ app, id }) {
  if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const state = await store.listProviders(app);
  const target = state.providers.find((p) => p.id === id);
  if (!target) throw new Error(`Provider not found: ${id}`);
  const prev = state.current
    ? state.providers.find((p) => p.id === state.current) || null
    : null;

  const lives = await readLives(app);
  const stash = app === "codex" ? await readCodexStash() : null;
  const plan = computeSwitchPlan(app, prev, target, lives, stash);
  const { wrote, backups } = await persistSwitchPlan(app, plan);

  // Commit the pointer only after every write landed.
  await store.setCurrentProvider(app, id);
  return { app, current: id, wrote, backups };
}

// ---------------------------------------------------------------------------
// Editor save (cc-switch's update_from_editor / add_from_editor): the dialog
// edits the full projected config; floor/exclusive keys go back into the
// provider row, every other user change is written into the live files
// (three-way compared against the base the editor opened with).
// ---------------------------------------------------------------------------

const CONFLICT_POLICIES = ["keepMine", "keepTheirs"];

async function saveProvider({ app, id, body }) {
  if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const editorInput = body.editor && body.editor.base ? body.editor : null;

  if (!editorInput) {
    // Legacy payload (fragment-shaped settingsConfig, no editor base).
    const provider = id
      ? await store.updateProvider(app, id, body)
      : await store.createProvider(app, body);
    let applied = null;
    if (id) {
      const state = await store.listProviders(app);
      if (state.current === id) {
        // cc-switch interaction: editing the *current* provider takes effect
        // immediately — re-run the projection so the live files follow.
        applied = await switchProvider({ app, id });
      }
    }
    return { ok: true, provider, applied };
  }

  const policy = CONFLICT_POLICIES.includes(body.editor.onConflict) ? body.editor.onConflict : "refuse";
  const existing = id ? await store.getProvider(app, id) : null;
  const plan = editor.planSave(app, existing ? existing.settingsConfig : null, body.settingsConfig, editorInput.base, editorInput.slotKey);

  const state = await store.listProviders(app);
  const isCurrent = !!id && state.current === id;
  const lives = await readLives(app);

  const marked = editor.resolveConflicts(app, plan.changes, lives);
  const conflicts = marked.filter((entry) => entry.conflict).map((entry) => editor.pathKey(entry.change.path));
  if (conflicts.length > 0 && policy === "refuse") {
    return { ok: false, conflict: true, conflicts };
  }
  const accepted = policy === "keepTheirs" ? marked.filter((entry) => !entry.conflict).map((entry) => entry.change) : plan.changes;

  // Patch the live contents in memory first; the floor projection below
  // reads the patched files so both land as one write per file.
  const patchedLives = editor.applyChanges(app, lives, accepted);

  let wrote = [];
  let backups = [];
  let applied = null;
  if (isCurrent) {
    const clean = store.sanitizeProviderFields(app, {
      name: body.name !== undefined ? body.name : existing.name,
      category: body.category !== undefined ? body.category : existing.category,
      settingsConfig: plan.rowSettings,
      notes: body.notes !== undefined ? body.notes : existing.notes,
      websiteUrl: body.websiteUrl !== undefined ? body.websiteUrl : existing.websiteUrl,
      icon: body.icon !== undefined ? body.icon : existing.icon,
      iconColor: body.iconColor !== undefined ? body.iconColor : existing.iconColor,
      meta: body.meta !== undefined ? body.meta : existing.meta,
    });
    const target = { ...existing, ...clean };
    const stash = app === "codex" ? await readCodexStash() : null;
    const switchPlan = computeSwitchPlan(app, existing, target, patchedLives, stash);
    ({ wrote, backups } = await persistSwitchPlan(app, switchPlan));
    applied = { wrote: wrote.slice(), backups };
  } else if (accepted.length > 0) {
    // Global-settings changes reach live regardless of which provider row is
    // being edited (the row only owns its floor keys).
    ({ wrote, backups } = await persistEditorChanges(app, patchedLives, lives, accepted));
  }

  const provider = id
    ? await store.updateProvider(app, id, { ...body, settingsConfig: plan.rowSettings })
    : await store.createProvider(app, { ...body, settingsConfig: plan.rowSettings });
  return { ok: true, provider, applied, wrote, backups };
}

// Write only the files the editor's global changes touched (backup first).
async function persistEditorChanges(app, patchedLives, originalLives, accepted) {
  const touchedFiles = new Set();
  for (const change of accepted) {
    if (app === "claude") touchedFiles.add("settings");
    else if (app === "codex") touchedFiles.add("config");
    else if (additive.isAdditiveApp(app)) touchedFiles.add("config");
    else touchedFiles.add("env");
  }
  const wrote = [];
  const backups = [];
  for (const fileId of touchedFiles) {
    const file = paths.targetFile(app, fileId);
    const patched = patchedLives[fileId];
    const original = originalLives[fileId];
    if (!patched || patched.content === (original ? original.content : null)) continue;
    if (original && original.exists) {
      const created = await backup.createBackup(app, file.path);
      if (created) backups.push(created);
    }
    await writeLiveFile(file, patched.content);
    wrote.push(file.path);
  }
  return { wrote, backups };
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

    // Encrypted backup of the provider-switch SSOT stores (scrypt + AES-GCM;
    // passphrase never persists). Restore pre-copies current files to
    // backups/import/<stamp>/.
    if (p === `${prefix}/backup/export` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        json(res, { ok: true, payload: await backupExport.exportEncrypted(String(body.passphrase || "")) });
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }
    if (p === `${prefix}/backup/import` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        json(res, await backupExport.importEncrypted(String(body.passphrase || ""), body.payload));
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }

    // pi native prompt resources (cc-switch's PiPromptFileService):
    // SYSTEM.md override / APPEND_SYSTEM.md append, CAS-guarded by content
    // revision. File exists = active; deleting it deactivates.
    if (p === `${prefix}/pi-prompt-files` && method === "GET") {
      const kind = String(url.searchParams.get("kind") || "");
      json(res, { ok: true, file: await piPromptFiles.read(kind) });
      return true;
    }
    if (p === `${prefix}/pi-prompt-files/replace` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        json(res, { ok: true, file: await piPromptFiles.replace(String(body.kind || ""), String(body.content ?? ""), body.expectedRevision ?? null) });
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }
    if (p === `${prefix}/pi-prompt-files/delete` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        json(res, { ok: true, file: await piPromptFiles.remove(String(body.kind || ""), body.expectedRevision ?? null) });
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }

    // Failover monitor (AiTool-original): failure-rate cooldowns over the
    // proxy's usage records, with switch suggestions or auto-switching.
    if (p === `${prefix}/failover` && method === "PUT") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      json(res, { ok: true, config: await failover.updateConfig(body.failover || body) });
      return true;
    }
    if (p === `${prefix}/failover/cooldowns` && method === "DELETE") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      await failover.clearCooldown(String(body.app || ""), String(body.id || ""));
      json(res, { ok: true });
      return true;
    }
    // Open GET never switches or needs auth: it evaluates read-only advice
    // and persists only benign cooldown bookkeeping. Auto-switching runs
    // exclusively through the authenticated POST below.
    if (p === `${prefix}/failover`) {
      json(res, { ok: true, failover: await failover.evaluate({ switchFn: null }) });
      return true;
    }
    if (p === `${prefix}/failover/evaluate` && method === "POST") {
      if (!requireMutation()) return true;
      json(res, { ok: true, failover: await failover.evaluate({ switchFn: switchProvider }) });
      return true;
    }

    // Feature settings (cc-switch's app-visibility toggle): which agent tabs
    // the dashboard shows on the provider-switch page.
    if (p === `${prefix}/settings` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const visibleApps = await store.updateVisibleApps(body.visibleApps);
      json(res, { ok: true, visibleApps });
      return true;
    }

    // MCP server management (cc-switch's unified mcp_servers module). Reads
    // are open; every mutation projects into the enabled apps' live configs
    // and reports per-server projection failures instead of aborting.
    if (p === `${prefix}/mcp` && method === "GET") {
      json(res, { ok: true, servers: await mcp.listServers(), apps: mcp.MCP_APPS });
      return true;
    }
    if (p === `${prefix}/mcp` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await mcp.upsertServer(body.server || body);
      json(res, { ok: true, ...result });
      return true;
    }
    if (p === `${prefix}/mcp/delete` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await mcp.deleteServer(String(body.id || ""));
      json(res, { ok: true, ...result });
      return true;
    }
    if (p === `${prefix}/mcp/toggle` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await mcp.toggleServerApp(String(body.id || ""), String(body.app || ""), body.enabled === true);
      json(res, { ok: true, ...result });
      return true;
    }
    if (p === `${prefix}/mcp/import` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await mcp.importFromApps(Array.isArray(body.apps) ? body.apps : null);
      json(res, { ok: true, ...result });
      return true;
    }
    if (p === `${prefix}/mcp/sync` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await mcp.syncServers(Array.isArray(body.apps) ? body.apps : null);
      json(res, { ok: true, ...result });
      return true;
    }

    // Per-app prompt lists (cc-switch's prompt module): enable writes the
    // prompt over the app's instruction file; reads backfill the enabled
    // prompt from the live file so external edits survive. Read-only import
    // is guarded like the other mutations because it appends to the store.
    if (p === `${prefix}/prompts` && method === "GET") {
      const app = url.searchParams.get("app") || "claude";
      const result = await prompts.listPrompts(app);
      json(res, { ok: true, app, prompts: result, targetPath: prompts.promptFilePath(app) });
      return true;
    }
    if (p === `${prefix}/prompts` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await prompts.upsertPrompt(String(body.app || ""), body.prompt || body);
      json(res, { ok: true, ...result });
      return true;
    }
    if (p === `${prefix}/prompts/enable` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await prompts.enablePrompt(String(body.app || ""), String(body.id || ""));
      json(res, { ok: true, ...result });
      return true;
    }
    if (p === `${prefix}/prompts/delete` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await prompts.deletePrompt(String(body.app || ""), String(body.id || ""));
      json(res, { ok: true, ...result });
      return true;
    }
    if (p === `${prefix}/prompts/import` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await prompts.importFromFile(String(body.app || ""));
      json(res, { ok: true, ...result });
      return true;
    }
    if (p === `${prefix}/prompts/sync` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await prompts.syncPrompts(Array.isArray(body.apps) ? body.apps : null);
      json(res, { ok: true, ...result });
      return true;
    }

    if (p === `${prefix}/presets`) {
      const app = url.searchParams.get("app") || "claude";
      if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
      json(res, { ok: true, app, presets: presetsModule.listPresets(app) });
      return true;
    }

    // Provider quota (cc-switch's coding_plan service): detects a supported
    // plan provider from the row's base URL and queries its balance/rolling
    // windows with the row's own key. Read-only, so no mutation guard.
    if (p === `${prefix}/quota` && method === "GET") {
      const app = url.searchParams.get("app") || "claude";
      const id = url.searchParams.get("id") || "";
      if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
      const provider = await store.getProvider(app, id);
      if (!provider) throw new Error(`Unknown provider: ${id}`);
      const quotaResult = await quota.queryProviderQuota({
        app,
        provider,
        bypassCache: url.searchParams.get("nocache") === "1",
      });
      json(res, { ok: true, app, id, quota: quotaResult });
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
        restoreTargets(app).find((f) => path.basename(f.path) === targetBasename) ||
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
      // The page's handleDragEnd replaces its rows with this response
      // wholesale, so the rows must carry the quotaProvider annotation too.
      const state = await store.listProviders(body.app);
      json(res, { ok: true, app: body.app, current: state.current, providers: annotateQuotaProviders(body.app, state.providers) });
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
        const state = await store.listProviders(app);
        json(res, { ok: true, app, current: state.current, providers: annotateQuotaProviders(app, state.providers) });
        return true;
      }
      if (!requireMutation()) return true;
      if (method === "POST" && !providerId) {
        const body = await readJsonBody(req);
        const result = await saveProvider({ app: body.app, id: null, body });
        if (result.conflict) {
          json(res, { ok: false, error: "conflict", conflicts: result.conflicts }, 409);
          return true;
        }
        json(res, result);
        return true;
      }
      if (method === "PUT" && providerId) {
        const body = await readJsonBody(req);
        const result = await saveProvider({ app: body.app, id: providerId, body });
        if (result.conflict) {
          json(res, { ok: false, error: "conflict", conflicts: result.conflicts }, 409);
          return true;
        }
        json(res, result);
        return true;
      }
      if (method === "DELETE" && providerId) {
        const app = url.searchParams.get("app");
        await store.deleteProvider(app, providerId);
        json(res, { ok: true });
        return true;
      }
    }

    // Editor view: the FULL config file as it would look after switching to
    // this provider (cc-switch's get_provider_editor_view). The dialog posts
    // the draft it is editing (row for edit mode, preset fragment or empty
    // object for the add dialog).
    if (p === `${prefix}/editor-view` && method === "POST") {
      const body = await readJsonBody(req);
      const app = body.app || "claude";
      json(res, await editor.buildEditorView(app, { settingsConfig: body.settingsConfig, id: body.id }));
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
  let meta;
  if (app === "claude") {
    const live = lives.settings.exists ? JSON.parse(lives.settings.content) : {};
    settingsConfig = targets.extractClaudeConfig(live);
    if (!settingsConfig.env && !Object.keys(settingsConfig).length) {
      throw new Error("No provider key fields found in the live settings.json");
    }
  } else if (app === "codex") {
    settingsConfig = targets.extractCodexConfig(lives.config.exists ? lives.config.content : "");
    meta = await importCodexCatalogMeta(settingsConfig.config);
  } else if (additive.isAdditiveApp(app)) {
    const live = lives.config.exists ? additive.parseLive(app, lives.config.content) : null;
    settingsConfig = additive.extractAdditive(app, live);
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
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  });
}

// The model catalog lives in a sidecar file pointed at by config.toml's
// model_catalog_json. On import the rows move into provider meta and the
// pointer is dropped — switching re-writes both from the provider record.
// A pointer we don't recognize (user's own catalog) stays in config untouched.
async function importCodexCatalogMeta(config) {
  if (!config || typeof config !== "object") return null;
  const pointer = String(config.model_catalog_json || "").trim();
  if (!pointer) return null;
  const basename = path.basename(pointer);
  if (!catalog.READABLE_CATALOG_FILENAMES.includes(basename)) return null;
  const configDir = path.dirname(paths.targetFile("codex", "config").path);
  let text = null;
  try {
    text = await fs.readFile(path.join(configDir, basename), "utf8");
  } catch {
    return null;
  }
  const rows = catalog.parseCodexCatalog(text);
  delete config.model_catalog_json;
  return rows.length > 0 ? { codexCatalogModels: rows } : null;
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

// Rows that carry a supported plan provider get `quotaProvider` set so the
// dashboard only renders quota lines where a query can actually succeed.
// Applied on every provider-listing surface (/status, /providers) since the
// page's initial data comes from the status snapshot.
function annotateQuotaProviders(app, providers) {
  return (Array.isArray(providers) ? providers : []).map((provider) => ({
    ...provider,
    quotaProvider: quota.detectQuotaProvider(
      quota.resolveProviderCredential(app, provider)?.baseUrl,
      app,
    )?.id ?? null,
  }));
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
      providers: annotateQuotaProviders(app, appState.providers),
      files,
    });
  }
  const stash = await readJson(paths.codexAuthStashPath());
  return {
    ok: true,
    storagePath: paths.providerSwitchRoot(),
    visibleApps: state.settings.visibleApps,
    codexAuthStash: stash && typeof stash === "object" && stash.auth ? { stashedAt: stash.stashedAt || null } : null,
    apps,
  };
}

module.exports = { handleProviderSwitchApiRequest, switchProvider, buildStatus };
