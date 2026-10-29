"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { resolveBinaryPath, runCommand } = require("../command-runner");
const { withFileLock, writeFileAtomic } = require("../fs");
const native = require("./claude-account-runtime");
const { createSwitcher } = require("./claude-account-switch");
const newId = () => crypto.randomBytes(16).toString("hex");
const USAGE_ARGS = ["-p", "/usage", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"];
function authUrl(raw) {
  try { const url = new URL(raw); return url.protocol === "https:" && ["claude.ai", "auth.claude.ai", "console.anthropic.com", "platform.claude.com"].includes(url.hostname) && !url.username && !url.password && url.pathname.includes("oauth") ? url.toString() : null; } catch { return null; }
}
function createManager(options = {}) {
  const runtime = options.runtime || native.createRuntime(options);
  const storeFile = path.join(runtime.root, "accounts.json");
  const load = async () => {
    await runtime.checkAncestors();
    const store = await native.readJson(storeFile, { version: 1, accounts: {} });
    const validIds = ids => ids === undefined || (Array.isArray(ids) && ids.every(id => /^[a-f0-9]{32}$/.test(id)));
    const validRow = ([id, row]) => typeof id === "string" && id.length > 0 && id.length <= 512 && row && typeof row === "object" && !Array.isArray(row)
      && /^[a-f0-9]{32}$/.test(row.localId || "") && validIds(row.previousLocalIds) && validIds(row.backups)
      && ["email", "orgName", "plan"].every(key => row[key] == null || (typeof row[key] === "string" && row[key].length <= 4096))
      && (row.authenticatedAt == null || (Number.isSafeInteger(row.authenticatedAt) && row.authenticatedAt >= 0));
    if (store.version !== 1 || !store.accounts || typeof store.accounts !== "object" || Array.isArray(store.accounts) || !Object.entries(store.accounts).every(validRow)) throw new Error("Claude account registry is unreadable; it was kept");
    return store;
  };
  const save = async store => { await runtime.checkAncestors(true); await require("./agy-fs").privateFile(storeFile); await writeFileAtomic(storeFile, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 }); };
  const serial = async action => { await runtime.checkAncestors(true); return withFileLock(storeFile, action); };
  const switcher = createSwitcher(runtime, { load, save });
  const pending = new Map();
  const quotaPending = new Map(), lastUsage = new Map();
  let usageChain = Promise.resolve();
  const resolve = options.resolve || resolveBinaryPath;
  const current = async () => native.owner(await runtime.credentials.read(runtime.defaultSlot), await runtime.readProfile(runtime.defaultSlot));
  const accountSlot = async (id, store = null) => {
    store ||= await load(); const row = store.accounts[id];
    if (!row) throw new Error("Claude account not found on this device; sign in first");
    return { row, slot: (await current())?.id === id ? runtime.defaultSlot : runtime.slot(row.localId) };
  };
  const accountView = async (id, row, active) => {
    const slot = active === id ? runtime.defaultSlot : runtime.slot(row.localId);
    const secret = await runtime.credentials.read(slot), profile = await runtime.readProfile(slot);
    const oauth = secret?.claudeAiOauth;
    let requiresReauth = !native.validLogin(secret);
    try { requiresReauth ||= native.owner(secret, profile)?.id !== id; } catch { requiresReauth = true; }
    const expiry = Number(oauth?.refreshTokenExpiresAt);
    return { id, email: row.email, orgName: row.orgName, plan: oauth?.subscriptionType || row.plan || null, rateLimitTier: oauth?.rateLimitTier || null, authenticatedAt: row.authenticatedAt, requiresReauth, loginExpiresAt: expiry > 0 ? expiry < 1e11 ? expiry * 1000 : expiry : null };
  };
  const status = async () => {
    const store = await load(), active = (await current())?.id || null;
    return { supported: true, switchSupported: !process.env.CLAUDE_CONFIG_DIR && !process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, currentAccountId: active, recoveryRequired: Boolean(await native.readJson(switcher.journalFile)), accounts: await Promise.all(Object.entries(store.accounts).map(([id, row]) => accountView(id, row, active))) };
  };
  const syncShared = id => require("./claude-account-shared").sync(runtime, runtime.slot(id));
  const cleanup = async flow => {
    if (flow.status === "success" || flow.cleaned) return;
    const slot = runtime.slot(flow.localId); await runtime.validateSlot(slot, { create: false });
    await runtime.credentials.delete(slot); await fs.rm(path.dirname(slot.dir), { recursive: true, force: true }); flow.cleaned = true;
  };
  const stop = async flow => {
    if (!flow.child || flow.done) return;
    if ((options.platform || process.platform) === "win32") await runCommand(options.runner, "taskkill", ["/PID", String(flow.child.pid), "/T", "/F"], { timeout: 5000 });
    else { try { process.kill(-flow.child.pid, "SIGTERM"); } catch { flow.child.kill("SIGTERM"); } }
    await Promise.race([flow.closed, new Promise(resolve => setTimeout(resolve, 1000))]);
    if (!flow.done) { try { process.kill(-flow.child.pid, "SIGKILL"); } catch { flow.child.kill("SIGKILL"); } await Promise.race([flow.closed, new Promise(resolve => setTimeout(resolve, 1000))]); }
    if (flow.done) await cleanup(flow);
  };
  const finishLogin = async flow => {
    if (flow.finishing) return flow.finishing;
    flow.finishing = serial(async () => {
      if (flow.canceled || flow.code !== 0) { if (!flow.canceled) flow.status = "failed"; await cleanup(flow); return; }
      const slot = runtime.slot(flow.localId), profile = await runtime.readProfile(slot), found = native.identity(profile);
      const secret = await runtime.credentials.read(slot);
      if (!found || !native.validLogin(secret) || native.owner(secret, profile)?.id !== found.id) { flow.status = "failed"; return; }
      await syncShared(flow.localId);
      const store = await load(), old = store.accounts[found.id];
      // Keep a previous native login directory as a recovery copy. Registry
      // references only its id; credentials never enter this file.
      store.accounts[found.id] = { localId: flow.localId, email: found.email, orgName: found.orgName, plan: secret.claudeAiOauth?.subscriptionType || null, authenticatedAt: Date.now(), ...(old ? { previousLocalIds: [...(old.previousLocalIds || []), old.localId] } : {}) };
      await save(store);
      if ((await current())?.id === found.id) await switcher.switchAccount(found.id, { replaceLogin: true });
      flow.status = "success"; flow.accountId = found.id;
    }).catch(() => { flow.status = "failed"; });
    return flow.finishing;
  };
  const launchLogin = async flow => {
    try {
      const binary = await resolve("claude"); if (flow.canceled) return; if (!binary) throw new Error("Claude CLI is not installed");
      const slot = runtime.slot(flow.localId); await runtime.validateSlot(slot); await syncShared(flow.localId);
      const env = native.accountEnv(slot.dir); delete env.BROWSER;
      const outer = path.dirname(slot.dir), openedFile = path.join(outer, ".opened-url");
      flow.openedFile = openedFile;
      if ((options.platform || process.platform) !== "win32") {
        const helper = path.join(outer, ".open-url.cjs"), opener = path.join(outer, ".open-url");
        await fs.writeFile(helper, 'require("node:fs").writeFileSync(process.env.AITOOL_CLAUDE_OPENED_URL, process.argv.at(-1), { mode: 0o600 });\n', { mode: 0o600 });
        const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
        await fs.writeFile(opener, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(helper)} "$@"\n`, { mode: 0o700 });
        env.BROWSER = opener; env.AITOOL_CLAUDE_OPENED_URL = openedFile;
      }
      if (flow.canceled) { await cleanup(flow); return; }
      const shell = (options.platform || process.platform) === "win32" && /\.(cmd|bat)$/i.test(binary);
      if (shell && /["\r\n%]/.test(binary)) throw new Error("Unsupported Claude launcher path");
      const child = (options.spawnImpl || spawn)(shell ? `"${binary}"` : binary, ["auth", "login", "--claudeai"], { cwd: slot.dir, env, detached: (options.platform || process.platform) !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell });
      flow.child = child;
      flow.closed = new Promise(resolve => child.once("close", resolve));
      let buffer = "";
      const capture = bytes => {
        buffer = (buffer + String(bytes).replace(/\x1b\[[0-9;]*m/g, "")).slice(-8192);
        for (const raw of buffer.match(/https:\/\/[^\s<>"']+/g) || []) { const url = authUrl(raw); if (url) flow.authUrl = url; }
      };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      child.once("error", () => { flow.done = true; flow.status = "failed"; });
      child.once("close", code => { clearTimeout(flow.timer); flow.done = true; flow.code = code; void finishLogin(flow); });
      flow.timer = setTimeout(() => { flow.canceled = true; flow.status = "expired"; void stop(flow); }, 600000); flow.timer.unref();
    } catch { if (!flow.canceled) flow.status = "failed"; flow.done = true; await cleanup(flow).catch(() => {}); }
  };
  const startLogin = () => serial(async () => {
    for (const flow of pending.values()) if (!flow.done) { flow.canceled = true; await stop(flow); }
    pending.clear();
    const id = newId(), flow = { flowId: id, localId: id, status: "pending", authUrl: null, expiresAt: Date.now() + 600000 };
    pending.set(id, flow); void launchLogin(flow);
    return { flowId: id, authUrl: null, expiresIn: 600 };
  });
  const pollLogin = async id => {
    const flow = pending.get(id); if (!flow) throw new Error("Claude sign-in ended; start again");
    if (flow.openedFile && !flow.done) { await require("./agy-fs").privateFile(flow.openedFile); const raw = await fs.readFile(flow.openedFile, "utf8").catch(() => ""); flow.authUrl = authUrl(raw.trim()) || flow.authUrl; }
    if (flow.done && !flow.finishing && !flow.canceled) void finishLogin(flow);
    return { flowId: id, status: flow.status, authUrl: flow.authUrl, accountId: flow.accountId || null };
  };
  const paste = async (id, raw) => {
    const flow = pending.get(id); if (!flow || flow.done || flow.canceled || !flow.child || !flow.authUrl) throw new Error("Claude sign-in is no longer waiting for a code");
    const auth = new URL(flow.authUrl), value = String(raw || "").trim();
    if (value.length > 8192) throw new Error("Invalid Claude sign-in code");
    if (/^[^\s#]+#[^\s#]+$/.test(value)) {
      if (value.split("#")[1] !== auth.searchParams.get("state")) throw new Error("This code belongs to another Claude sign-in");
      flow.child.stdin.write(value + "\n"); return;
    }
    let callback, expected; try { callback = new URL(value); expected = new URL(auth.searchParams.get("redirect_uri")); } catch { throw new Error("Paste this sign-in's callback URL or code#state"); }
    if (!['localhost','127.0.0.1','[::1]'].includes(callback.hostname) || callback.protocol !== "http:" || callback.port !== expected.port || callback.pathname !== expected.pathname || !callback.searchParams.get("code") || callback.searchParams.get("state") !== auth.searchParams.get("state")) throw new Error("This callback belongs to another Claude sign-in");
    const response = await (options.fetchImpl || fetch)(callback, { redirect: "manual", signal: AbortSignal.timeout(30000) });
    if (response.status >= 400) throw new Error("Claude CLI could not accept the sign-in callback");
    await response.body?.cancel();
  };
  const cancel = async id => { const flow = pending.get(id); if (!flow) return; flow.canceled = true; flow.status = "canceled"; clearTimeout(flow.timer); await stop(flow); };
  const quota = id => {
    if (quotaPending.has(id)) return quotaPending.get(id);
    const task = serial(async () => {
      const { slot } = await accountSlot(id);
      let secret = await runtime.credentials.read(slot), profile = await runtime.readProfile(slot);
      if (native.owner(secret, profile)?.id !== id) throw new Error("Claude account identity changed; sign in again");
      const fetchUsage = async () => {
        const token = secret?.claudeAiOauth?.accessToken; if (!token) return null;
        const response = await (options.fetchImpl || fetch)("https://api.anthropic.com/api/oauth/usage", { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15000) });
        if (response.status === 401) { await response.body?.cancel(); return null; }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Claude usage service returned ${response.status}`); }
        return response.json();
      };
      let body = await fetchUsage();
      if (!body) {
        const run = async () => {
          if (Date.now() - (lastUsage.get(id) || 0) < 600000) return;
          lastUsage.set(id, Date.now());
          const binary = await resolve("claude"); if (!binary) return;
          const env = native.accountEnv(slot.default ? null : slot.dir);
          delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
          Object.assign(env, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1" });
          await runCommand(options.runner, binary, USAGE_ARGS, { env, cwd: runtime.home, timeout: 45000, maxBuffer: 1048576, killProcessGroup: true, useShell: (options.platform || process.platform) === "win32" && /\.(cmd|bat)$/i.test(binary) });
        };
        usageChain = usageChain.catch(() => {}).then(run); await usageChain;
        secret = await runtime.credentials.read(slot); profile = await runtime.readProfile(slot);
        if (native.owner(secret, profile)?.id !== id) throw new Error("Claude account changed during quota lookup; retry");
        body = await fetchUsage();
        const cached = profile.cachedUsageUtilization;
        if (!body && cached?.accountUuid === id.split(":")[0] && Date.now() - Number(cached.fetchedAtMs) < 645000) body = cached.utilization;
      }
      if (!body) throw new Error("Claude sign-in expired; sign in to this account again");
      const tiers = Object.entries(body).flatMap(([key, value]) => typeof value?.utilization === "number" && Number.isFinite(value.utilization) ? [{ id: key, label: key, used_percent: Math.max(0, Math.min(100, value.utilization)), reset_at: typeof value.resets_at === "string" ? value.resets_at : null }] : []);
      for (const limit of body.limits || []) if (limit?.kind === "weekly_scoped" && Number.isFinite(Number(limit.percent))) tiers.push({ id: `weekly:${limit.scope?.model?.id || tiers.length}`, label: limit.scope?.model?.display_name || limit.scope?.model?.id || "Weekly", used_percent: Math.max(0, Math.min(100, Number(limit.percent))), reset_at: limit.resets_at || null });
      return { ok: true, tiers };
    }).finally(() => quotaPending.delete(id));
    quotaPending.set(id, task); return task;
  };
  const switchAccount = (id, args) => serial(async () => {
    if (process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR) throw new Error("A custom Claude directory is active; use isolated launch for this account");
    if (!args?.apply) {
      const file = path.join(runtime.defaultSlot.dir, "settings.json");
      await runtime.validateSlot(runtime.defaultSlot, { create: false });
      const before = await native.readJson(file, {}), after = require("./claude-account-shared").stripSettings(before);
      if (native.hash(before) !== native.hash(after)) {
        const raw = await fs.readFile(file, "utf8"), written = JSON.stringify(after, null, 2) + "\n";
        const backupRoot = path.join(runtime.root, "projection-backups"); await runtime.checkAncestors(true); await require("./agy-fs").privateDirectory(backupRoot, runtime.root);
        const backupFile = path.join(backupRoot, `${newId()}.bak`); await writeFileAtomic(backupFile, raw, { mode: 0o600 });
        args = { ...args, prepare: async () => [{ file, backup: backupFile, beforeExists: true, beforeHash: native.hash(raw), afterHash: native.hash(written) }], apply: async () => {
          await withFileLock(file, async () => { if (await fs.readFile(file, "utf8") !== raw) throw new Error("Claude settings changed before account switch; reload and retry"); await writeFileAtomic(file, written, { mode: 0o600 }); });
        } };
      }
    }

    if (process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR) throw new Error("A custom Claude directory is active; use isolated launch for this account");
    return switcher.switchAccount(id, args);
  });
  const launch = id => serial(async () => {
    const store = await load(), row = store.accounts[id]; if (!row) throw new Error("Claude account not found on this device");
    const binary = await resolve("claude"); if (!binary) throw new Error("Claude CLI is not installed");
    await switcher.isolate(id); await syncShared(row.localId);
    const { slot } = await accountSlot(id, store);
    if (!native.validLogin(await runtime.credentials.read(slot))) throw new Error("Claude account needs sign-in before launch");
    return (options.launchTerminal || require("./terminal").launch)(binary, [], native.accountEnv(runtime.directory(row.localId)), options);
  });
  const remove = id => serial(async () => {
    const store = await load(), row = store.accounts[id]; if (!row) return;
    // The default slot belongs to Claude Code; deleting a saved account never
    // changes or signs out its current default login.
    for (const localId of [row.localId, ...(row.previousLocalIds || [])]) {
      const slot = runtime.slot(localId); await runtime.validateSlot(slot, { create: false });
      const contents = await fs.readdir(path.dirname(slot.dir)).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      for (const name of contents.filter(name => /^login-backup(?:-[a-f0-9]{32})?$/.test(name))) await runtime.credentials.delete({ dir: path.join(path.dirname(slot.dir), name), default: false });
      await runtime.credentials.delete(slot);
      await fs.rm(path.dirname(slot.dir), { recursive: true, force: true });
    }
    delete store.accounts[id]; await save(store);
  });
  return { status, startLogin, pollLogin, paste, cancel, quota, switchAccount, launch, remove, recover: () => serial(switcher.recover), runtime, load, save, storeFile };
}
const managers = new Map();
function manager() { const root = path.join(require("./paths").providerSwitchRoot(), "claude-accounts"); if (!managers.has(root)) managers.set(root, createManager({ root })); return managers.get(root); }
module.exports = { createManager, manager, authUrl, USAGE_ARGS };
