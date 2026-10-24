const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { ensureDir, writeFileAtomic, chmod600IfPossible, readJson, withFileLock } = require("../fs");
const store = require("./store");
const targets = require("./targets");
const presetsModule = require("./presets");
const backup = require("./backup");
const paths = require("./paths");
const catalog = require("./catalog");
const editor = require("./editor");
const universal = require("./universal");
const profiles = require("./profiles");
const profileBundles = require("./profile-bundles");
const additive = require("./additive");
const mcp = require("./mcp");
const mcpCheck = require("./mcp-check");
const prompts = require("./prompts");
const piPromptFiles = require("./pi-prompt-files");
const backupExport = require("./backup-export");
const envConflict = require("./env-conflict");
const skills = require("./skills");
const quota = require("./quota");
const failover = require("./failover");
const codexClient = require("./codex-client");
const diagnostics = require("./diagnostics");

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

// MCP registries and prompt instruction files also create backups, even when
// they are not provider-switch targets. Include them so listed backups restore.
const BACKUP_FORMATS = { ".toml": "toml", ".yaml": "yaml", ".yml": "yaml" };

function restoreTargets(app) {
  const live = mcp.mcpLiveFiles()[app];
  const files = [...paths.targetFiles(app)];
  if (live) files.push({
    id: `mcp-${app}`,
    path: live.path,
    format: BACKUP_FORMATS[path.extname(live.path)] || "json",
    private: true,
  });
  if (prompts.PROMPT_APPS.includes(app)) files.push({
    id: `prompt-${app}`,
    path: prompts.promptFilePath(app),
    format: "text",
    private: true,
  });
  return files;
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

// Load the codex login stash, upgrading older shapes once per read: a
// pre-workspace single-slot file (or a user-keyed map) is rekeyed by identity
// and seeded from the official cards' stored logins (cc-switch 84457b510-era
// stash vs e5b1e0966's multi-slot LoginStash). `rowAuths` are the official
// codex cards' settingsConfig.auth values; `liveAuth` is the live auth.json.
async function readCodexStash(rowAuths, liveAuth) {
  const raw = await readJson(paths.codexAuthStashPath());
  if (!raw || typeof raw !== "object") {
    return targets.emptyCodexStash();
  }
  const current = targets.normalizeCodexStash(raw);
  if (current) return current;
  return targets.upgradeCodexStash(raw, rowAuths, liveAuth);
}

// Compute every live patch for a switch in memory (cc-switch's transaction
// ordering: any parse failure aborts before touching disk). `lives` carries
// the current file contents; the editor save passes pre-patched contents so
// its global-setting changes and the floor projection land in one write.
function computeSwitchPlan(app, prev, target, lives, stash) {
  const files = paths.targetFiles(app);
  const writes = []; // { file, content, parsedBackup? }
  let stashNext = null; // { version, logins, last } — new multi-slot stash state
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
    const { configToml, auth, catalog: sidecar, stashNext: next } = targets.projectCodex({
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
    } else if (auth.action === "stash") {
      writes.push({ file: authFile, content: `{}\n`, skipBackupIfMissing: true });
    }
    stashNext = next;
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

  return { writes, stashNext, catalogAction };
}

// Backup each existing live file, persist the auth stash, then publish all
// file writes atomically (tmp+rename) and handle the catalog sidecar.
async function persistSwitchPlan(app, plan) {
  if (app === "codex") await codexClient.noteCodexState();
  const backups = [];
  for (const write of plan.writes) {
    if (!write.skipBackupIfMissing || (await liveExists(write.file))) {
      const created = await backup.createBackup(app, write.file.path);
      if (created) backups.push(created);
    }
  }

  if (plan.stashNext) {
    await ensureDir(paths.providerSwitchRoot());
    await writeFileAtomic(
      paths.codexAuthStashPath(),
      `${JSON.stringify({ ...plan.stashNext, stashedAt: new Date().toISOString() }, null, 2)}\n`,
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
    await writeFileAtomic(catalogPath, catalog.buildCodexCatalog(plan.catalogAction.models, undefined, plan.catalogAction.options));
    wrote.push(catalogPath);
  } else if (plan.catalogAction.action === "remove") {
    try {
      await fs.unlink(paths.codexModelCatalogPath());
    } catch {
      /* catalog file may be gone already */
    }
  }

  if (app === "codex") await codexClient.noteCodexState();
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

// The official codex cards' stored logins seed the stash upgrade (cc-switch
// seeds LoginStash from row auths); unbound cards carry none.
async function officialCodexRowAuths() {
  const state = await store.listProviders("codex");
  return state.providers
    .filter((provider) => provider.category === "official")
    .map((provider) => provider.settingsConfig && provider.settingsConfig.auth)
    .filter((auth) => auth && typeof auth === "object" && !Array.isArray(auth));
}

function withProjectionLock(app, action) {
  if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  return withFileLock(path.join(paths.providerSwitchRoot(), `${app}.projection`), action);
}
async function recordProjection(app, provider, writes) {
  try { await diagnostics.record(app, provider, writes); return []; }
  catch { return ["Configuration applied, but its diagnostic receipt could not be saved; preview and repair to retry."]; }
}
async function switchProvider(payload) {
  return withProjectionLock(payload.app, () => switchProviderUnlocked(payload));
}
async function switchProviderUnlocked({ app, id }) {
  if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const state = await store.listProviders(app);
  const target = state.providers.find((p) => p.id === id);
  if (!target) throw new Error(`Provider not found: ${id}`);
  if (app === "hermes" && require("./hermes-builtins").conflicts(target.settingsConfig?.slotKey)) {
    throw new Error("HERMES_BUILTIN_ID_CONFLICT");
  }
  const prev = state.current
    ? state.providers.find((p) => p.id === state.current) || null
    : null;

  const lives = await readLives(app);
  const stash =
    app === "codex"
      ? await readCodexStash(await officialCodexRowAuths(), lives.auth.exists ? JSON.parse(lives.auth.content) : {})
      : null;
  const plan = computeSwitchPlan(app, prev, target, lives, stash);
  const { wrote, backups } = await persistSwitchPlan(app, plan);

  // The live config is authoritative; an auxiliary receipt cannot prevent
  // committing the matching current provider after all projection writes.
  await store.setCurrentProvider(app, id);
  const warnings = await recordProjection(app, target, plan.writes);
  return { app, current: id, wrote, backups, warnings };
}

async function disconnectProvider(app) {
  return withProjectionLock(app, async () => {
    const state = await store.listProviders(app);
    const prev = state.providers.find(row => row.id === state.current);
    if (!prev && app !== "codex") { await store.setCurrentProvider(app, null); return { wrote: [] }; }
    if (app === "codex") {
      const lives = await readLives(app);
      const stash = await readCodexStash(await officialCodexRowAuths(), lives.auth.exists ? JSON.parse(lives.auth.content) : {});
      const plan = computeSwitchPlan(app, prev, { category: "official", settingsConfig: { config: {} } }, lives, stash);
      const applied = await persistSwitchPlan(app, plan);
      await store.setCurrentProvider(app, null);
      return applied;
    }
    const lives = await readLives(app), writes = [];
    for (const file of paths.targetFiles(app)) {
      if (!lives[file.id].exists) continue;
      let content;
      if (app === "claude") content = `${JSON.stringify(targets.projectClaude({ prev, target: { settingsConfig: {} }, live: JSON.parse(lives[file.id].content) }), null, 2)}\n`;
      else if (app === "gemini") content = targets.projectGemini({ prev, target: { settingsConfig: {} }, liveEnv: lives[file.id].content });
      else content = additive.serializeLive(app, additive.disconnectAdditive(app, { prev, live: additive.parseLive(app, lives[file.id].content) }));
      writes.push({ file, content });
    }
    const applied = await persistSwitchPlan(app, { writes, catalogAction: { action: "keep" }, stashNext: null });
    await store.setCurrentProvider(app, null); return applied;
  });
}

// profiles/universal inject the switch projection positionally as (app, id);
// adapt to switchProvider's single { app, id } payload.
function switchProviderPositional(app, id) {
  return id === "" ? disconnectProvider(app) : switchProvider({ app, id });
}

async function diagnosticRepairPlan(app) {
  const diagnostic = await diagnostics.inspect(app);
  const state = await store.listProviders(app);
  const target = state.providers.find(provider => provider.id === state.current);
  if (!target) throw new Error("Select a provider before previewing its configuration");
  const lives = await readLives(app);
  const stash = app === "codex" ? await readCodexStash(await officialCodexRowAuths(), lives.auth.exists ? JSON.parse(lives.auth.content) : {}) : null;
  const plan = computeSwitchPlan(app, target, target, lives, stash);
  if (!plan.writes.length) throw new Error("This app does not use a live provider projection");
  const revision = sha256(JSON.stringify([diagnostic.revision, lives, stash, target, plan]));
  return { revision, target, lives, plan };
}

// ---------------------------------------------------------------------------
// Editor save (cc-switch's update_from_editor / add_from_editor): the dialog
// edits the full projected config; floor/exclusive keys go back into the
// provider row, every other user change is written into the live files
// (three-way compared against the base the editor opened with).
// ---------------------------------------------------------------------------

const CONFLICT_POLICIES = ["keepMine", "keepTheirs"];

async function saveProvider(payload) {
  return withProjectionLock(payload.app, () => saveProviderUnlocked(payload));
}
async function saveProviderUnlocked({ app, id, body }) {
  if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  if (app === "hermes" && body.settingsConfig && require("./hermes-builtins").conflicts(body.settingsConfig.slotKey)) throw new Error("HERMES_BUILTIN_ID_CONFLICT");
  if (app === "agy") {
    const provider = id ? await store.updateProvider(app, id, body) : await store.createProvider(app, body);
    return { ok: true, provider, applied: null };
  }
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
        applied = await switchProviderUnlocked({ app, id });
      }
    }
    return { ok: true, provider, applied };
  }

  const policy = CONFLICT_POLICIES.includes(body.editor.onConflict) ? body.editor.onConflict : "refuse";
  const existing = id ? await store.getProvider(app, id) : null;
  const plan = editor.planSave(
    app,
    existing ? existing.settingsConfig : null,
    body.settingsConfig,
    editorInput.base,
    editorInput.slotKey,
    // Claude: the draft distinguishes draft-carried exclusive keys (row-owned
    // on add) from live-owned ones — cc-switch's EditorSave.draft.
    app === "claude" && editorInput.draft && typeof editorInput.draft === "object"
      ? editorInput.draft
      : undefined,
    { official: (body.category ?? existing?.category) === "official" },
  );

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
    const stash =
      app === "codex"
        ? await readCodexStash(await officialCodexRowAuths(), lives.auth.exists ? JSON.parse(lives.auth.content) : {})
        : null;
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
  let warnings = [];
  if (applied) {
    const freshLives = await readLives(app);
    warnings = await recordProjection(app, provider, paths.targetFiles(app).filter(file => freshLives[file.id].exists)
      .map(file => ({ file, content: freshLives[file.id].content })));
  }
  return { ok: true, provider, applied, wrote, backups, warnings };
}

// Write only the files the editor's global changes touched (backup first).
async function persistEditorChanges(app, patchedLives, originalLives, accepted) {
  if (app === "codex") await codexClient.noteCodexState();
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
  if (app === "codex") await codexClient.noteCodexState();
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
    if (p === `${prefix}/distribution` && method === "GET") { json(res, { ok: true, ...await require("./library-distribution").list() }); return true; }
    if (p === `${prefix}/distribution` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req), distribution = require("./library-distribution");
      if (body.action === "preview") {
        const plan = await distribution.preview(body);
        json(res, { ok: true, revision: plan.revision, errors: plan.errors, changes: plan.changes.map(change => ({ path: change.path, action: change.next === null ? "remove" : change.beforeHash ? "update" : "create", app: change.app })) });
      } else if (body.action === "apply") json(res, { ok: true, ...await distribution.apply(body) });
      else throw new Error("Unknown distribution action");
      return true;
    }
    if (p === `${prefix}/diagnostics` && method === "GET") {
      json(res, { ok: true, diagnostic: await diagnostics.inspect(url.searchParams.get("app") || "claude") }); return true;
    }
    if (p === `${prefix}/diagnostics/probe` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const controller = new AbortController(); const cancel = () => controller.abort(); res.on?.("close", cancel);
      try { const probe = await diagnostics.probeEndpoint(body.app, { signal: controller.signal }); if (!res.destroyed) json(res, { ok: true, probe }); }
      finally { res.removeListener?.("close", cancel); }
      return true;
    }
    if (p === `${prefix}/diagnostics/preview` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const preview = await diagnosticRepairPlan(body.app);
      json(res, { ok: true, revision: preview.revision, providerId: preview.target.id, files: preview.plan.writes.map(write => ({
        id: write.file.id, path: write.file.path, changed: (preview.lives[write.file.id]?.content || "") !== write.content,
        ...(body.showValues === true ? { before: preview.lives[write.file.id]?.content || "", after: write.content } : {}),
      })) }); return true;
    }
    if (p === `${prefix}/diagnostics/repair` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await withProjectionLock(body.app, async () => {
        const preview = await diagnosticRepairPlan(body.app);
        if (!body.revision || preview.revision !== body.revision) throw Object.assign(new Error("Configuration changed; reload the repair preview"), { status: 409 });
        const applied = await persistSwitchPlan(body.app, preview.plan);
        const warnings = await recordProjection(body.app, preview.target, preview.plan.writes);
        return { ...applied, warnings };
      });
      json(res, { ok: true, ...result }); return true;
    }
    if (p === `${prefix}/agy/launch` && method === "POST") {
      if (!requireMutation()) return true;
      const { id } = await readJsonBody(req);
      const row = await store.getProvider("agy", id);
      if (!row) throw new Error("Provider not found");
      json(res, { ok: true, ...await require("./agy").launch(row) }); return true;
    }
    if (p.startsWith(`${prefix}/agy/accounts`)) {
      if (!requireMutation()) return true;
      const accounts = require("./agy-accounts").manager();
      if (p === `${prefix}/agy/accounts` && method === "GET") json(res, { ok: true, ...await accounts.status() });
      else if (p === `${prefix}/agy/accounts/login` && method === "POST") json(res, { ok: true, ...await accounts.startLogin() });
      else if (p === `${prefix}/agy/accounts/login` && method === "GET") json(res, { ok: true, ...accounts.pollLogin(url.searchParams.get("flowId")) });
      else if (p === `${prefix}/agy/accounts/login` && method === "DELETE") { accounts.cancel(); json(res, { ok: true }); }
      else if (p === `${prefix}/agy/accounts/quota` && method === "GET") json(res, { ok: true, quota: await accounts.quota(url.searchParams.get("id")) });
      else if (p === `${prefix}/agy/accounts/switch` && method === "POST") { const body = await readJsonBody(req); json(res, { ok: true, ...await accounts.switchAccount(body.id) }); }
      else if (p === `${prefix}/agy/accounts` && method === "DELETE") { const body = await readJsonBody(req); await accounts.remove(body.id); json(res, { ok: true }); }
      else return false;
      return true;
    }

    if (p === `${prefix}/hermes/migrate-id` && method === "POST") {
      if (!requireMutation()) return true;
      const { id } = await readJsonBody(req);
      await withFileLock(path.join(paths.providerSwitchRoot(), "hermes.projection"), async () => {
        const state = await store.listProviders("hermes");
        const row = state.providers.find(p => p.id === id);
        if (!row) throw new Error("Provider not found");
        const old = row.settingsConfig;
        if (!require("./hermes-builtins").conflicts(old.slotKey)) throw new Error("Provider ID has no conflict");
        let key = `aitool-${old.slotKey}`;
        const lives = await readLives("hermes");
        const live = lives.config.exists ? additive.parseLive("hermes", lives.config.content) : {};
        const occupied = new Set([...state.providers.map(p => p.settingsConfig?.slotKey),
          ...(live.custom_providers || []).map(p => p.name), ...Object.keys(live.providers || {})]);
        for (let n = 2; occupied.has(key); n++) key = `aitool-${old.slotKey}-${n}`;
        const next = { ...row, settingsConfig: { ...old, slotKey: key, provider: { ...old.provider, name: key } } };
        if (state.current === id) await persistSwitchPlan("hermes", computeSwitchPlan("hermes", row, next, lives));
        await store.updateProvider("hermes", id, { settingsConfig: next.settingsConfig });
        json(res, { ok: true, slotKey: key });
      });
      return true;
    }

    if (p === `${prefix}/codex-client` && method === "GET") {
      json(res, { ok: true, client: await codexClient.getCodexClientStatus() });
      return true;
    }
    if (p === `${prefix}/codex-client/restart` && method === "POST") {
      if (!requireMutation()) return true;
      json(res, { ok: true, ...await codexClient.restartCodexDaemon() });
      return true;
    }
    if (p === `${prefix}/codex-client/acknowledge` && method === "POST") {
      if (!requireMutation()) return true;
      await codexClient.acknowledgeCodexClients();
      json(res, { ok: true });
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

    // Universal providers (cc-switch's 统一供应商): one shared base URL +
    // API key projected into deterministic claude/codex/gemini child rows.
    // Upsert stays separate from sync (upstream interaction: create auto-
    // syncs, edits save until the user asks for 保存并同步); sync re-projects
    // the live files of apps whose current provider is a generated child.
    if (p === `${prefix}/universal` && method === "GET") {
      json(res, { ok: true, providers: await store.listUniversalProviders() });
      return true;
    }
    if (p === `${prefix}/universal` && (method === "PUT" || method === "POST")) {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        const provider = await store.upsertUniversalProvider(body.provider || {});
        json(res, { ok: true, provider });
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }
    if (p === `${prefix}/universal/sync` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        await universal.syncUniversalToApps({ id: String(body.id || ""), applyCurrent: switchProviderPositional });
        json(res, { ok: true });
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }
    if (p === `${prefix}/universal/delete` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        const removed = await universal.deleteUniversalAndChildren(String(body.id || ""));
        json(res, { ok: true, removed });
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }

    // Profiles (cc-switch's services/profile): per-app named snapshots of the
    // providers/MCP/skills/prompts state. Apply autosaves the previous
    // profile of the app and is best-effort — warnings come back to the UI.
    if (p === `${prefix}/profiles` && method === "GET") {
      json(res, { ok: true, ...(await profiles.listProfiles()) });
      return true;
    }
    if (p === `${prefix}/profiles` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        json(res, { ok: true, profile: await profiles.createProfile({ name: body.name, app: String(body.app || ""), ...(body.apps !== undefined ? { apps: body.apps } : {}) }) });
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }
    if (p === `${prefix}/profiles/update` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        const profile = await profiles.updateProfile({
          id: String(body.id || ""),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.resnapshot ? { resnapshot: true, app: String(body.app || "") } : {}),
        });
        json(res, { ok: true, profile });
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }
    if (p === `${prefix}/profiles/delete` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        await profiles.deleteProfile(String(body.id || ""));
        json(res, { ok: true });
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }
    if (p === `${prefix}/profiles/apply` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        json(res, await profiles.applyProfile({ id: String(body.id || ""), app: String(body.app || ""), applyProvider: switchProviderPositional }));
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }
    if (p === `${prefix}/profiles/preview-bundle` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await profileBundles.preview(body);
      json(res, { ok: true, revision: result.revision, results: result.results }); return true;
    }
    if (p === `${prefix}/profiles/apply-bundle` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      json(res, await profileBundles.apply({ ...body, applyProvider: switchProviderPositional })); return true;
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
      const servers = await mcp.listServers();
      json(res, { ok: true, servers, apps: mcp.MCP_APPS, toolFilterApps: require("./mcp-tool-rules").APPS,
        checks: Object.fromEntries(servers.map(server => [server.id, mcpCheck.snapshot(server)])) });
      return true;
    }
    if (p === `${prefix}/mcp/check` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const server = (await mcp.listServers()).find(row => row.id === body.id);
      if (!server) throw new Error("MCP server not found");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.on?.("close", cancel);
      try {
        const check = await mcpCheck.checkServer(server, { signal: controller.signal });
        if (!res.destroyed) json(res, { ok: true, check: mcpCheck.snapshot((await mcp.listServers()).find(row => row.id === server.id) || server) || check });
      } finally { res.removeListener?.("close", cancel); }
      return true;
    }
    if (p === `${prefix}/mcp/tool` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await mcp.toggleServerTool(body.id, body.app, body.tool, body.enabled === true, body.revision);
      json(res, { ok: true, ...result });
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

    // Provider quota (cc-switch's coding_plan + balance services): detects a
    // supported plan or balance provider from the row's base URL and queries
    // it with the row's own key. Read-only, so no mutation guard.
    if (p === `${prefix}/quota` && method === "GET") {
      const app = url.searchParams.get("app") || "claude";
      const id = url.searchParams.get("id") || "";
      if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
      const provider = await store.getProvider(app, id);
      if (!provider) throw new Error(`Unknown provider: ${id}`);
      const bypassCache = url.searchParams.get("nocache") === "1";
      let quotaResult = await quota.queryProviderQuota({ app, provider, bypassCache });
      if (!quotaResult.ok && !quotaResult.provider) {
        // No plan provider on this base URL: try the generic balance probes
        // (DeepSeek/StepFun/SiliconFlow/OpenRouter/Novita — cc-switch balance.rs).
        quotaResult = await quota.queryProviderBalance({ app, provider, bypassCache });
      }
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
      if (app === "codex") await codexClient.noteCodexState();
      await writeLiveFile(file, body.content);
      if (app === "codex") await codexClient.noteCodexState();
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
      if (app === "codex") await codexClient.noteCodexState();
      await writeLiveFile(file, content);
      if (app === "codex") await codexClient.noteCodexState();
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

    if (p === `${prefix}/providers/duplicate` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const provider = await store.duplicateProvider(body.app, body.id);
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
      const view = await editor.buildEditorView(app, { settingsConfig: body.settingsConfig, id: body.id, category: body.category });
      // Why the official GPT list is unavailable, when it is — the catalog
      // editor hints at the vendored-template fallback (cc-switch 2e20cdcb5).
      if (app === "codex") view.codexOfficialModelsReason = catalog.codexOfficialModelsReason();
      json(res, view);
      return true;
    }

    // Skills (cc-switch services/skill.rs, v1): SSOT list discovered from
    // the agents' skills directories, projected per app via symlink-or-copy.
    if (p === `${prefix}/skills` && method === "GET") {
      json(res, { ok: true, skills: await skills.listSkills(), apps: skills.SKILL_APPS });
      return true;
    }
    if (p === `${prefix}/skills/import` && method === "POST") {
      if (!requireMutation()) return true;
      json(res, { ok: true, ...(await skills.importSkills()) });
      return true;
    }
    if (p === `${prefix}/skills/toggle` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await skills.toggleSkill(String(body.id || ""), String(body.app || ""), body.enabled === true);
      json(res, { ok: true, ...result });
      return true;
    }
    if (p === `${prefix}/skills/sync` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await skills.syncSkills(Array.isArray(body.apps) ? body.apps : null);
      json(res, { ok: true, ...result });
      return true;
    }

    if (p === `${prefix}/speed-test` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const results = await speedTestEndpoints(body.urls || [], body.timeoutMs);
      json(res, { ok: true, results });
      return true;
    }

    // Env conflicts (cc-switch's check_env_conflicts / delete_env_vars /
    // restore_env_backup): shell profiles and the process environment can
    // override what switching writes, so the page warns and offers removal
    // with an automatic backup. Read is open; delete/restore mutate files
    // beyond the live configs and require mutation auth.
    if (p === `${prefix}/env-conflicts` && method === "GET") {
      const apps = store.SUPPORTED_APPS.filter((app) => envConflict.keywordsForApp(app).length > 0);
      json(res, { ok: true, conflicts: envConflict.checkAllConflicts(apps) });
      return true;
    }

    if (p === `${prefix}/env-conflicts/delete` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await envConflict.deleteConflicts(body.conflicts || []);
      json(res, { ok: true, ...result });
      return true;
    }

    if (p === `${prefix}/env-conflicts/restore` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await envConflict.restoreFromBackup(String(body.backupPath || ""));
      json(res, { ok: true, ...result });
      return true;
    }

    if (p === `${prefix}/fetch-models` && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = body.app === "agy" ? await require("./agy").models() : await fetchModelList(body);
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
    json(res, { ok: false, error: error?.message || String(error) }, error?.status === 409 ? 409 : 400);
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
  const reviewer = catalog.parseCodexAutoReviewModel(text);
  if (!rows.length) return null;
  const speedTiersDisabled = JSON.parse(text).models.every((entry) =>
    Array.isArray(entry?.service_tiers) && !entry.service_tiers.length
    && Array.isArray(entry?.additional_speed_tiers) && !entry.additional_speed_tiers.length);
  return { codexCatalogModels: rows, ...(reviewer ? { codexAutoReviewModel: reviewer } : {}),
    ...(speedTiersDisabled ? { codexSpeedTiersEnabled: false } : {}) };
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

// cc-switch 315aeda: gateways like Cloudflare AI Gateway require extra
// headers (cf-aig-authorization) on GET /v1/models. The provider's Header
// override JSON is parsed leniently — invalid or empty overrides fall back
// to a plain fetch with no error surfaced (cc-switch's form shows a
// validation error for the same input; this port carries no override
// validation, so the silent fallback is the only signal); valid ones are
// applied after the defaults, so an explicit Authorization in the override
// wins.
const MODEL_FETCH_HEADER_VALUE_CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/;

// cc-switch's PROTECTED_LOCAL_PROXY_HEADER_NAMES (requestOverrides.ts):
// managed, hop-by-hop, identity and CDN/tracing headers never ride the
// model-list request — forwarding content-length/transfer-encoding breaks
// fetch outright (undici rejects them, the auth-relay outage class), and
// the rest would smuggle a proxy-managed identity. authorization is the one
// documented deviation: an explicit Authorization in the override wins.
const PROTECTED_MODEL_FETCH_HEADER_NAMES = new Set([
  "host", "content-length", "transfer-encoding", "connection",
  "proxy-authorization", "proxy-authenticate", "te", "trailer", "upgrade",
  "accept-encoding", "content-type", "x-api-key", "x-goog-api-key",
  "chatgpt-account-id", "session_id", "x-client-request-id",
  "x-codex-window-id", "x-forwarded-host", "x-forwarded-port",
  "x-forwarded-proto", "forwarded", "cf-connecting-ip", "cf-ipcountry",
  "cf-ray", "cf-visitor", "true-client-ip", "fastly-client-ip",
  "x-azure-clientip", "x-azure-fdid", "x-azure-ref", "akamai-origin-hop",
  "x-akamai-config-log-detail", "x-request-id", "x-correlation-id",
  "x-trace-id", "x-amzn-trace-id", "x-b3-traceid", "x-b3-spanid",
  "x-b3-parentspanid", "x-b3-sampled", "traceparent", "tracestate",
]);

function parseModelFetchHeaders(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const headers = {};
  const seenNames = new Set();
  for (const [name, value] of Object.entries(parsed)) {
    const headerName = String(name).trim();
    if (!headerName || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)) return null;
    if (typeof value !== "string") return null;
    // The remaining cc-switch parseHeaderOverrideJson rules: a value carrying
    // control characters, a duplicate name after case normalization, and a
    // protected/managed name all invalidate the whole override (silent
    // plain-fetch fallback) instead of reaching fetch() and surfacing as a
    // request error.
    if (MODEL_FETCH_HEADER_VALUE_CONTROL_CHARS.test(value)) return null;
    const normalizedName = headerName.toLowerCase();
    if (seenNames.has(normalizedName)) return null;
    if (PROTECTED_MODEL_FETCH_HEADER_NAMES.has(normalizedName)) return null;
    seenNames.add(normalizedName);
    headers[headerName] = value;
  }
  return Object.keys(headers).length ? headers : null;
}

async function fetchModelList({ baseUrl, apiKey, modelsUrl, isFullUrl, requestHeaders }) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const explicit = String(modelsUrl || "").trim();
  if (!base && !explicit) throw new Error("Base URL is required");
  const overrideHeaders = parseModelFetchHeaders(requestHeaders);
  const candidates = [];
  if (explicit && /^https?:\/\//.test(explicit)) {
    candidates.push(explicit);
  } else if (base) {
    // cc-switch probes /v1/models then /models; a full-URL endpoint is used
    // verbatim (the user already included the models path).
    if (isFullUrl) candidates.push(base);
    else {
      candidates.push(`${base}/v1/models`, `${base}/models`);
      // Qianwen / Bailian Token Plan anthropic endpoints (`…/apps/anthropic`)
      // return 404 for /v1/models — their list lives only under the OpenAI
      // compatible path (cc-switch c3ad9bb, #8755).
      if (base.endsWith("/apps/anthropic")) candidates.push(`${base}/compatible-mode/v1/models`);
    }
  }

  const errors = [];
  for (const url of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const headers = { Accept: "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      if (overrideHeaders) Object.assign(headers, overrideHeaders);
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

// Rows that carry a supported plan or balance provider get `quotaProvider`
// set so the dashboard only renders quota lines where a query can actually
// succeed. Applied on every provider-listing surface (/status, /providers)
// since the page's initial data comes from the status snapshot.
function annotateQuotaProviders(app, providers) {
  return (Array.isArray(providers) ? providers : []).map((provider) => {
    const credential = quota.resolveProviderCredential(app, provider);
    const plan = quota.detectQuotaProvider(credential?.baseUrl, app)?.id ?? null;
    const balance = plan ? null : quota.detectBalanceProvider(credential?.baseUrl)?.id ?? null;
    return {
      ...provider,
      quotaProvider: plan ?? balance,
      ...(app === "hermes" && require("./hermes-builtins").conflicts(provider.settingsConfig?.slotKey) ? { builtinIdConflict: true } : {}),
      quotaKind: plan ? "plan" : balance ? "balance" : null,
    };
  });
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
      providers: annotateQuotaProviders(app, appState.providers).map(row => ({ ...row,
        ...(app === "hermes" && require("./hermes-builtins").conflicts(row.settingsConfig?.slotKey) ? { builtinIdConflict: true } : {}) })),
      files,
    });
  }
  const stash = await readJson(paths.codexAuthStashPath());
  const stashPresent =
    stash &&
    typeof stash === "object" &&
    ((stash.logins && typeof stash.logins === "object" && Object.keys(stash.logins).length > 0) || stash.auth);
  return {
    ok: true,
    storagePath: paths.providerSwitchRoot(),
    visibleApps: state.settings.visibleApps,
    codexAuthStash: stashPresent ? { stashedAt: stash.stashedAt || null } : null,
    apps,
  };
}

module.exports = { handleProviderSwitchApiRequest, switchProvider, buildStatus };
