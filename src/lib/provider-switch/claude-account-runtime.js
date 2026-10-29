"use strict";
// Claude Code native slots, cc-switch 9403960f (MIT). No token is stored in
// AiTool's registry/journal. Native credentials stay in Keychain or 0600 files.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const locks = new AsyncLocalStorage();
async function assertLocks() { for (const check of locks.getStore() || []) await check(); }
const { runCommand } = require("../command-runner");
const { writeFileAtomic, ensureDir } = require("../fs");
const { privateDirectory, privateFile } = require("./agy-fs");
const ACCOUNT_KEYS = ["claudeAiOauth", "organizationUuid", "trustedDeviceToken", "enterpriseGateway", "designOauth", "trustedDeviceEnrolledAfterRefusalAtMs", "cloudSessionsOauth"];
const CACHE_KEYS = ["additionalModelOptionsCache", "additionalModelOptionsAnsweredAt", "additionalModelCostsCache", "modelAccessCache", "orgModelDefaultCache", "cachedArtifactRoster", "artifactRosterDenied", "lastSeenOrgDefaultUpdatedAt", "clientDataCache", "clientDataCacheSlots", "autoCompactWindowsCache", "cachedUsageUtilization", "metricsStatusCache", "metricsStatusCacheByPrincipal", "githubWebConnectionStatusCache", "unusedLimitResetStatusCache", "startupPrefetchedAt", "cachedExtraUsageDisabledReason", "penguinModeOrgEnabled"];
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const accountPart = secret => Object.fromEntries(ACCOUNT_KEYS.filter(key => secret && Object.hasOwn(secret, key)).map(key => [key, secret[key]]));
const sharedPart = secret => Object.fromEntries(Object.entries(secret || {}).filter(([key]) => !ACCOUNT_KEYS.includes(key)));
const merge = (base, account) => ({ ...sharedPart(base), ...accountPart(account) });
function identity(profile) {
  const row = profile?.oauthAccount;
  if (typeof row?.accountUuid !== "string" || !row.accountUuid.trim()) return null;
  return { id: `${row.accountUuid.trim()}:${row.organizationUuid?.trim() || ""}`, email: row.emailAddress || null, orgName: row.organizationName || null };
}
function owner(secret, profile) {
  if (!secret?.claudeAiOauth?.refreshToken) return null;
  const found = identity(profile);
  if (!found || (secret.organizationUuid && profile.oauthAccount?.organizationUuid && secret.organizationUuid !== profile.oauthAccount.organizationUuid)) throw new Error("Claude sign-in identity is missing or inconsistent; run Claude once before switching");
  return found;
}
function validLogin(secret, now = Date.now()) {
  const value = Number(secret?.claudeAiOauth?.refreshTokenExpiresAt);
  const expires = value > 0 ? value < 1e11 ? value * 1000 : value : null;
  return Boolean(secret?.claudeAiOauth?.refreshToken) && (!expires || expires > now);
}
function accountEnv(directory, env = process.env) {
  const next = { ...env };
  for (const key of Object.keys(next)) if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_USE_") || ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR"].includes(key)) delete next[key];
  if (directory) next.CLAUDE_CONFIG_DIR = directory;
  return next;
}
async function readJson(file, fallback = null) {
  await privateFile(file);
  let text; try { text = await fs.readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  try { const doc = JSON.parse(text); if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(); return doc; }
  catch { throw new Error("Claude local data has an unrecognized format; nothing was changed"); }
}
function createRuntime({ home = os.homedir(), root = path.join(require("./paths").providerSwitchRoot(), "claude-accounts"), platform = process.platform, runner, credentials } = {}) {
  const defaultSlot = { dir: path.join(home, ".claude"), default: true };
  const directory = localId => {
    if (!/^[a-f0-9]{32}$/.test(localId)) throw new Error("Invalid Claude account directory id");
    return path.join(root, localId, "config");
  };
  const slot = localId => ({ dir: directory(localId), default: false });
  const backupSlot = (localId, suffix = "") => {
    if (suffix && !/^[a-f0-9]{32}$/.test(suffix)) throw new Error("Invalid Claude backup id");
    return { dir: path.join(path.dirname(directory(localId)), `login-backup${suffix ? "-" + suffix : ""}`), default: false };
  };
  const checkAncestors = async (create = false) => {
    const base = path.relative(home, root).startsWith("..") ? path.parse(root).root : home;
    const relative = path.relative(base, root);
    for (const file of [base, ...relative.split(path.sep).filter(Boolean).map((_, i, parts) => path.join(base, ...parts.slice(0, i + 1)))]) {
      if (create) try { await fs.mkdir(file, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Claude account directory is redirected");
    }
  };
  const validateSlot = async (value, { create = true } = {}) => {
    if (value.default) {
      if (value.dir !== defaultSlot.dir) throw new Error("Invalid default Claude slot");
      if (create) await ensureDir(value.dir);
      const stat = await fs.lstat(value.dir).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Default Claude directory is redirected; use isolated launch");
    } else {
      const id = path.basename(path.dirname(value.dir));
      const name = path.basename(value.dir);
      if (value.dir !== directory(id) && (!/^login-backup(?:-[a-f0-9]{32})?$/.test(name) || value.dir !== backupSlot(id, name === "login-backup" ? "" : name.slice(13)).dir)) throw new Error("Invalid Claude slot");
      await checkAncestors(create);
      if (create) await privateDirectory(value.dir, root);
      else for (const file of [root, path.dirname(value.dir), value.dir]) {
        const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Claude account directory is redirected");
      }
    }
  };
  const profilePath = async value => {
    await validateSlot(value, { create: false });
    const legacy = path.join(value.dir, ".config.json");
    await privateFile(legacy);
    const legacyStat = await fs.stat(legacy).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    return legacyStat?.size ? legacy : value.default ? path.join(home, ".claude.json") : path.join(value.dir, ".claude.json");
  };
  const service = value => value.default ? "Claude Code-credentials" : `Claude Code-credentials-${crypto.createHash("sha256").update(value.dir.normalize("NFC")).digest("hex").slice(0, 8)}`;
  const rawUser = process.env.USER || path.basename(home);
  const user = /^[a-zA-Z0-9._-]+$/.test(rawUser) ? rawUser : "claude-code-user";
  const keychain = async (args, input) => {
    const result = await runCommand(runner, "/usr/bin/security", args, { input, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw new Error("Claude Keychain operation timed out or failed");
    if (result.status === 36) throw new Error("Claude Keychain is locked; unlock it before switching");
    return result;
  };
  const credentialStore = credentials || {
    async read(value) {
      await validateSlot(value, { create: false });
      if (platform === "darwin") {
        const result = await keychain(["find-generic-password", "-a", user, "-s", service(value), "-w"]);
        if (result.status === 0) {
          let raw = String(result.stdout || "").trim();
          if (/^[a-fA-F0-9]+$/.test(raw) && raw.length % 2 === 0) raw = Buffer.from(raw, "hex").toString("utf8");
          try { const doc = JSON.parse(raw); if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(); return doc; } catch { throw new Error("Claude Keychain data has an unrecognized format"); }
        }
        if (result.status !== 44) throw new Error("Could not read Claude Keychain credentials");
      }
      return readJson(path.join(value.dir, ".credentials.json"));
    },
    async write(value, secret) {
      await assertLocks();
      await validateSlot(value);
      const file = path.join(value.dir, ".credentials.json"); await privateFile(file);
      if (platform === "darwin") {
        const input = `add-generic-password -U -a "${user}" -s "${service(value)}" -X "${Buffer.from(JSON.stringify(secret)).toString("hex")}"\n`;
        if (Buffer.byteLength(input) > 4032) throw new Error("Claude sign-in is too large for a private Keychain write");
        if ((await keychain(["-i"], input)).status !== 0) throw new Error("Could not write Claude Keychain credentials");
        await fs.rm(file, { force: true });
      } else await writeFileAtomic(file, JSON.stringify(secret) + "\n", { mode: 0o600 });
    },
    async delete(value) {
      await assertLocks();
      await validateSlot(value);
      const file = path.join(value.dir, ".credentials.json"); await privateFile(file);
      if (platform === "darwin") {
        const result = await keychain(["delete-generic-password", "-a", user, "-s", service(value)]);
        if (![0, 44].includes(result.status)) throw new Error("Could not delete Claude Keychain credentials");
      }
      await fs.rm(file, { force: true });
    },
  };
  const writeVerified = async (value, secret) => {
    if (secret && Object.keys(secret).length) await credentialStore.write(value, secret); else await credentialStore.delete(value);
    if (hash(await credentialStore.read(value) || {}) !== hash(secret || {})) throw new Error("Claude credential write did not verify; recovery is required");
  };
  return { home, root, checkAncestors, defaultSlot, directory, slot, backupSlot, validateSlot, profilePath, service, credentials: credentialStore, writeVerified, readProfile: async value => readJson(await profilePath(value), {}), writeProfile: async (value, doc) => { await assertLocks(); await validateSlot(value); const file = await profilePath(value); await privateFile(file); await writeFileAtomic(file, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 }); } };
}

// proper-lockfile-compatible mkdir locks. A heartbeat prevents a slow Keychain
// operation from being mistaken for an abandoned native writer.
async function withNativeLock(file, staleMs, action, { waitMs = 10000 } = {}) {
  const started = Date.now(); let held;
  await ensureDir(path.dirname(file));
  while (!held) {
    try { await fs.mkdir(file, { mode: 0o700 }); held = await fs.lstat(file); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const seen = await fs.lstat(file);
      if (!seen.isDirectory() || seen.isSymbolicLink()) throw new Error("Claude native lock is redirected or invalid");
      if (Date.now() - seen.mtimeMs > staleMs) {
        const current = await fs.lstat(file);
        if (current.ino === seen.ino && current.mtimeMs === seen.mtimeMs) await fs.rmdir(file).catch(() => {});
      }
      if (Date.now() - started >= waitMs) throw new Error("Claude is using its sign-in data; try again after login or refresh completes");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  let heartbeat = Promise.resolve(), lost;
  const check = async () => { const current = await fs.lstat(file).catch(() => null); if (lost || current?.ino !== held.ino || current?.birthtimeMs !== held.birthtimeMs) throw new Error("Claude lock ownership changed"); };
  const timer = setInterval(() => { heartbeat = heartbeat.then(async () => { await check(); const now = new Date(); await fs.utimes(file, now, now); }).catch(error => { lost = error; }); }, Math.min(2000, staleMs / 3));
  timer.unref();
  try { return await locks.run([...(locks.getStore() || []), check], async () => { const result = await action(check); await check(); return result; }); }
  finally { clearInterval(timer); await heartbeat; const current = await fs.lstat(file).catch(() => null); if (current?.ino === held.ino) await fs.rmdir(file).catch(() => {}); }
}
async function withSlotLocks(runtime, slots, action) {
  const specs = new Map();
  for (const slot of slots) {
    await runtime.validateSlot(slot);
    const real = await fs.realpath(slot.dir);
    specs.set(path.join(slot.dir, ".oauth_refresh.lock"), 60000);
    specs.set(real + ".lock", 60000);
    specs.set(path.join(slot.dir, ".storage-write.lock"), 15000);
    specs.set((await runtime.profilePath(slot)) + ".lock", 10000);
  }
  const list = [...specs].sort(([a], [b]) => a.localeCompare(b));
  const next = index => index === list.length ? action() : withNativeLock(list[index][0], list[index][1], () => next(index + 1));
  return next(0);
}
module.exports = { createRuntime, withNativeLock, withSlotLocks, assertLocks, readJson, ACCOUNT_KEYS, CACHE_KEYS, identity, owner, validLogin, accountEnv, hash, accountPart, sharedPart, merge };
