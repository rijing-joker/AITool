"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { withFileLock, writeFileAtomic, ensureDir } = require("../fs");
const { privateFile } = require("./agy-fs");
const paths = require("./paths");
const native = require("./mcp");
const ID = "aitool-hub";
const storePath = () => path.join(paths.providerSwitchRoot(), "mcp-hub.json");
const hash = value => crypto.createHash("sha256").update(value === null ? "<missing>" : value).digest("hex");
const contents = file => fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
async function directory(directory, create = false) {
  const base = path.parse(directory).root, parts = path.relative(base, directory).split(path.sep).filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    const file = path.join(base, ...parts.slice(0, i));
    if (create && i) try { await fs.mkdir(file, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("MCP Hub private directory is redirected");
  }
}
async function read() {
  await directory(paths.providerSwitchRoot());
  await privateFile(storePath());
  const raw = await contents(storePath());
  if (raw === null) return { version: 1, enabled: false, entries: {} };
  const value = JSON.parse(raw);
  const validEntry = ([app, row]) => native.MCP_APPS.includes(app) && row && typeof row === "object" && !Array.isArray(row)
    && [row.hash, row.beforeHash].every(value => /^[a-f0-9]{64}$/.test(value))
    && (row.backup === null || (typeof row.backup === "string" && path.dirname(row.backup) === path.join(paths.providerSwitchRoot(), "mcp-hub-recovery") && /^[\w.-]+\.bak$/.test(path.basename(row.backup))))
    && Array.isArray(row.ids) && row.ids.every(id => typeof id === "string" && /^[\w.-]+$/.test(id));
  if (value.version !== 1 || typeof value.enabled !== "boolean" || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)
    || !Object.entries(value.entries).every(validEntry) || (value.token !== undefined && !/^[a-f0-9]{64}$/.test(value.token))
    || (value.enabled && !value.token) || (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535))) throw new Error("MCP Hub state is invalid; it was kept");
  return value;
}
const save = async value => { await directory(paths.providerSwitchRoot(), true); await privateFile(storePath()); await writeFileAtomic(storePath(), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); };
const address = (state, app = "all") => `http://127.0.0.1:${state.port}/api/mcp/hub/${app}`;
const spec = (state, app) => ({ type: "http", url: address(state, app), headers: { Authorization: `Bearer ${state.token}` } });
async function project(state, app, servers) {
  const file = native.mcpLiveFiles()[app];
  if (!file) return;
  await withFileLock(file.path, async () => {
    await privateFile(file.path);
    const before = await contents(file.path), previous = state.entries[app];
    if (previous && hash(before) !== previous.hash) throw new Error(`${app}: MCP configuration changed outside AiTool; recovery copies were kept`);
    const selected = servers.filter(row => row.apps?.[app]);
    if (!state.enabled || !selected.length) {
      if (!previous) return;
      let original = null;
      if (previous.backup) {
        const root = path.join(paths.providerSwitchRoot(), "mcp-hub-recovery");
        if (path.dirname(previous.backup) !== root || !/^[\w.-]+\.bak$/.test(path.basename(previous.backup))) throw new Error("Invalid MCP Hub recovery backup");
        await directory(root);
        await privateFile(previous.backup); original = await contents(previous.backup);
        if (hash(original) !== previous.beforeHash) throw new Error("MCP Hub backup changed; current configuration was kept");
      } else if (previous.beforeHash !== hash(null)) throw new Error("MCP Hub recovery backup is missing");
      if (hash(await contents(file.path)) !== previous.hash) throw new Error("MCP configuration changed during recovery");
      if (original === null) await fs.rm(file.path, { force: true }); else await writeFileAtomic(file.path, original, { mode: 0o600 });
      previous.hash = hash(original); await save(state);
      for (const id of previous.ids || []) if (!servers.some(row => row.id === id && row.apps?.[app])) {
        await native.removeServerFromFile(app, file, id, { mode: "delete" }); previous.hash = hash(await contents(file.path)); await save(state);
        await require("./mcp-tool-rules").projectExternal(app, id, false, { alreadyLocked: app === "opencode" });
        previous.hash = hash(await contents(file.path)); await save(state);
        if (["codex", "gemini", "hermes"].includes(app)) await require("./mcp-tool-rules").commit(app, id, []);
      }
      for (const row of selected) {
        await native.upsertServerWithRules(app, file, row.id, require("./mcp-envrefs").projectReferences(app, row.server)); previous.hash = hash(await contents(file.path)); await save(state);
        await require("./mcp-tool-rules").projectExternal(app, row.id, true, { alreadyLocked: app === "opencode" }); previous.hash = hash(await contents(file.path)); await save(state);
      }
      delete state.entries[app]; await save(state); return;
    }
    if (servers.some(row => row.id === ID)) throw new Error("A library server already uses the reserved MCP Hub name");
    if (!previous) {
      // Importing the live file only into memory verifies the reserved name.
      const imported = await native.readServersFromApp(app);
      if (imported.some(row => row.id === ID)) throw new Error(`${app}: an existing MCP Hub entry belongs to another configuration`);
      let backup = null;
      if (before !== null) {
        const root = path.join(paths.providerSwitchRoot(), "mcp-hub-recovery"); await directory(root, true);
        backup = path.join(root, `${app}-${crypto.randomUUID()}.bak`); await writeFileAtomic(backup, before, { mode: 0o600 });
      }
      if (before !== null && !backup) throw new Error("MCP Hub could not create a recovery copy");
      if (hash(await contents(file.path)) !== hash(before)) throw new Error("MCP configuration changed while creating the recovery copy");
      state.entries[app] = { backup, beforeHash: hash(before), hash: hash(before), ids: selected.map(row => row.id) };
      await save(state);
    }
    const receipt = state.entries[app];
    // Each completed write has a receipt, including a partial conversion.
    for (const row of selected) {
      await native.removeServerFromFile(app, file, row.id, { mode: "delete" });
      receipt.hash = hash(await contents(file.path)); receipt.ids = [...new Set([...receipt.ids, row.id])]; await save(state);
    }
    await native.upsertServerInFile(app, file, ID, spec(state, app));
    receipt.hash = hash(await contents(file.path)); await save(state);
  });
}
async function setEnabled(enabled, port) {
  if (typeof enabled !== "boolean" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MCP Hub configuration");
  await directory(paths.providerSwitchRoot(), true);
  return withFileLock(storePath(), async () => {
    const state = await read(); state.enabled = enabled; state.port = port; state.token ||= crypto.randomBytes(32).toString("hex"); await save(state);
    const servers = await native.listServers(), failures = [];
    for (const app of native.MCP_APPS) try { await project(state, app, servers); } catch (error) { failures.push(error.message); }
    await require("./mcp-hub").hub().prune();
    return { ...view(state), failures };
  });
}
async function syncApp(app) {
  await directory(paths.providerSwitchRoot(), true);
  return withFileLock(storePath(), async () => { const state = await read(); await project(state, app, await native.listServers()); await require("./mcp-hub").hub().prune(); });
}
function view(state) { return { enabled: state.enabled, address: state.port ? address(state) : null, connectedApps: Object.keys(state.entries), recoveryRequired: !state.enabled && Object.keys(state.entries).length > 0 }; }
async function status() { return view(await read()); }
async function connection(app = "all") { const state = await read(); if (!state.enabled || (app !== "all" && !native.MCP_APPS.includes(app))) throw new Error("MCP Hub is disabled or this client is unsupported"); return { mcpServers: { [ID]: spec(state, app) } }; }
module.exports = { ID, read, status, connection, setEnabled, syncApp };
