"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createRuntime, withNativeLock, accountEnv } = require("../src/lib/provider-switch/claude-account-runtime");
const { createManager } = require("../src/lib/provider-switch/claude-accounts");
const secret = token => ({ claudeAiOauth: { accessToken: token, refreshToken: token + "-refresh", expiresAt: Date.now() + 100000, refreshTokenExpiresAt: Date.now() + 1e7, subscriptionType: "pro" }, organizationUuid: "org" });
const profile = id => ({ oauthAccount: { accountUuid: id, organizationUuid: "org", emailAddress: id + "@example.com" }, mcpServers: { local: { command: "keep" } }, cachedUsageUtilization: { accountUuid: id, fetchedAtMs: Date.now(), utilization: {} } });
async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-claude-accounts-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".aitool", "provider-switch", "claude-accounts");
  const runtime = createRuntime({ home, root, platform: "linux" });
  const manager = createManager({ runtime, resolve: async () => "/fixture/claude", ...options });
  const id = "a".repeat(32), slot = runtime.slot(id);
  await runtime.validateSlot(slot); await runtime.validateSlot(runtime.defaultSlot);
  await manager.save({ version: 1, accounts: { "target:org": { localId: id, email: "target@example.com", authenticatedAt: Date.now() } } });
  await runtime.credentials.write(slot, { ...secret("target-token"), pluginSecrets: { local: "target-plugin" } });
  await runtime.writeProfile(slot, profile("target"));
  await runtime.credentials.write(runtime.defaultSlot, { ...secret("original-token"), mcpOAuth: { local: "default-mcp" } });
  await runtime.writeProfile(runtime.defaultSlot, profile("original"));
  return { home, runtime, manager, slot };
}
test("Claude switch moves only account keys, adopts the original login and deletion leaves default credentials intact", async t => {
  const x = await fixture(t);
  await x.manager.switchAccount("target:org");
  const live = await x.runtime.credentials.read(x.runtime.defaultSlot);
  assert.equal(live.claudeAiOauth.accessToken, "target-token");
  assert.deepEqual(live.mcpOAuth, { local: "default-mcp" });
  assert.equal(live.pluginSecrets, undefined);
  assert.deepEqual(await x.runtime.credentials.read(x.slot), { pluginSecrets: { local: "target-plugin" } });
  const state = await x.manager.status();
  assert.equal(state.currentAccountId, "target:org");
  assert.equal(state.accounts.length, 2);
  assert.equal(state.accounts.find(row => row.id === "target:org").requiresReauth, false);
  assert.equal(JSON.stringify(await x.manager.load()).includes("target-token"), false);
  const currentProfile = await x.runtime.readProfile(x.runtime.defaultSlot);
  assert.deepEqual(currentProfile.mcpServers, profile("target").mcpServers);
  assert.equal(currentProfile.cachedUsageUtilization, undefined);
  await x.manager.remove("target:org");
  assert.deepEqual(await x.runtime.credentials.read(x.runtime.defaultSlot), live);
});
test("Claude quotas use the requested account without switching and isolated launch returns the live token to its native folder", async t => {
  const calls = [], launches = [];
  const x = await fixture(t, { fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: "2026-10-30T00:00:00Z" } })); }, launchTerminal: async (...args) => { launches.push(args); return { launched: true }; } });
  const before = await x.runtime.credentials.read(x.runtime.defaultSlot);
  const quota = await x.manager.quota("target:org");
  assert.equal(quota.tiers[0].used_percent, 12);
  assert.equal(calls[0].options.headers.Authorization, "Bearer target-token");
  assert.deepEqual(await x.runtime.credentials.read(x.runtime.defaultSlot), before);
  await x.manager.switchAccount("target:org");
  await x.manager.launch("target:org");
  assert.equal(launches[0][2].CLAUDE_CONFIG_DIR, x.slot.dir);
  assert.equal(launches[0][2].ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal((await x.runtime.credentials.read(x.slot)).claudeAiOauth.accessToken, "target-token");
  assert.equal((await x.runtime.credentials.read(x.runtime.defaultSlot)).claudeAiOauth, undefined);
});
test("Claude committed switches retain a fingerprint-only recovery journal and resume after a failed profile write", async t => {
  const x = await fixture(t);
  const write = x.runtime.writeProfile; let fail = true;
  x.runtime.writeProfile = async (slot, doc) => { if (slot.default && fail) { fail = false; throw new Error("fixture interruption"); } return write(slot, doc); };
  const result = await x.manager.switchAccount("target:org");
  assert.equal(result.warnings.length, 1);
  const journal = await fs.readFile(result.recoveryPath, "utf8");
  assert.equal(journal.includes("target-token"), false);
  await x.manager.recover();
  assert.equal((await x.runtime.readProfile(x.runtime.defaultSlot)).oauthAccount.accountUuid, "target");
  assert.equal((await x.runtime.credentials.read(x.slot)).claudeAiOauth, undefined);
  await assert.rejects(fs.stat(result.recoveryPath), { code: "ENOENT" });
});
test("Claude rejects an account whose native identity changed and preserves both slots", async t => {
  const x = await fixture(t);
  await x.runtime.writeProfile(x.slot, profile("different"));
  const before = await x.runtime.credentials.read(x.runtime.defaultSlot);
  await assert.rejects(x.manager.switchAccount("target:org"), /another account/);
  assert.deepEqual(await x.runtime.credentials.read(x.runtime.defaultSlot), before);
  const outside = path.join(x.home, "outside"); await fs.mkdir(outside);
  await fs.rm(x.slot.dir, { recursive: true }); await fs.symlink(outside, x.slot.dir);
  await assert.rejects(x.runtime.credentials.read(x.slot), /redirected/);
});
test("Claude native locks coordinate mkdir ownership and official launches remove relay selectors", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-claude-lock-")); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, "refresh.lock");
  await withNativeLock(file, 60000, async () => { await assert.rejects(withNativeLock(file, 60000, async () => {}, { waitMs: 0 }), /using/); });
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  assert.deepEqual(accountEnv("/isolated", { ANTHROPIC_API_KEY: "secret", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_OAUTH_TOKEN: "secret", CLAUDE_CONFIG_DIR: "/old", KEEP: "yes" }), { KEEP: "yes", CLAUDE_CONFIG_DIR: "/isolated" });
});
test("Claude backup slots cannot escape the account root and read-only status creates no private directories", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-claude-readonly-")); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runtime = createRuntime({ home, root: path.join(home, ".aitool", "provider-switch", "claude-accounts"), platform: "linux" });
  const manager = createManager({ runtime }); assert.deepEqual((await manager.status()).accounts, []);
  await assert.rejects(fs.stat(path.join(home, ".aitool")), { code: "ENOENT" });
  const outside = { dir: path.join(home, "outside", "a".repeat(32), "login-backup"), default: false };
  await assert.rejects(runtime.validateSlot(outside), /Invalid/);
});
test("Claude writes stop after native lock ownership is lost", async t => {
  const x = await fixture(t), lock = path.join(x.home, "writer.lock");
  const before = await x.runtime.credentials.read(x.slot);
  await assert.rejects(withNativeLock(lock, 60000, async () => {
    await fs.rename(lock, lock + ".old"); await fs.mkdir(lock);
    await x.runtime.credentials.write(x.slot, secret("should-never-be-written"));
  }), /ownership/);
  assert.deepEqual(await x.runtime.credentials.read(x.slot), before);
  assert.ok((await fs.stat(lock)).isDirectory());
});
test("Claude account switching clears relay routing while preserving unrelated settings", async t => {
  const x = await fixture(t), file = path.join(x.runtime.defaultSlot.dir, "settings.json");
  await fs.writeFile(file, JSON.stringify({ theme: "dark", env: { ANTHROPIC_BASE_URL: "https://relay.example", ANTHROPIC_AUTH_TOKEN: "relay-key", KEEP: "yes" } }));
  await x.manager.switchAccount("target:org");
  assert.deepEqual(JSON.parse(await fs.readFile(file)), { theme: "dark", env: { KEEP: "yes" } });
});
test("Claude canceled logins cannot spawn after a delayed CLI resolution", async t => {
  let release, spawned = 0;
  const x = await fixture(t, { resolve: () => new Promise(resolve => { release = resolve; }), spawnImpl: () => { spawned++; throw new Error("must not spawn"); } });
  const login = await x.manager.startLogin(); await x.manager.cancel(login.flowId); release("/fixture/claude");
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(spawned, 0); assert.equal((await x.manager.pollLogin(login.flowId)).status, "canceled");
});
test("Claude reauthentication of the default account replaces its live login and keeps a native recovery copy", async t => {
  const x = await fixture(t); await x.manager.switchAccount("target:org");
  const script = path.join(x.home, "synthetic-login.cjs");
  await fs.writeFile(script, `const fs=require('node:fs'),path=require('node:path');const dir=process.env.CLAUDE_CONFIG_DIR;fs.writeFileSync(path.join(dir,'.credentials.json'),JSON.stringify(${JSON.stringify(secret("renewed-token"))}));fs.writeFileSync(path.join(dir,'.claude.json'),JSON.stringify(${JSON.stringify(profile("target"))}));`);
  const manager = createManager({ runtime: x.runtime, resolve: async () => process.execPath, spawnImpl: (_command, _args, options) => require("node:child_process").spawn(process.execPath, [script], options) });
  const flow = await manager.startLogin(); let status;
  for (let i = 0; i < 100; i++) { status = await manager.pollLogin(flow.flowId); if (status.status !== "pending") break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(status.status, "success");
  assert.equal((await x.runtime.credentials.read(x.runtime.defaultSlot)).claudeAiOauth.accessToken, "renewed-token");
  const row = (await manager.load()).accounts["target:org"]; assert.ok(row.previousLocalIds.includes(path.basename(path.dirname(x.slot.dir)))); assert.equal(row.backups.length, 1);
});

test("Claude shared mirrors update owned MCP entries, preserve account edits and remove deleted defaults", async t => {
  const x = await fixture(t), shared = require("../src/lib/provider-switch/claude-account-shared");
  const defaults = x.runtime.defaultSlot, settingsFile = path.join(defaults.dir, "settings.json"), targetFile = path.join(x.slot.dir, "settings.json");
  await fs.writeFile(settingsFile, JSON.stringify({ theme: "light", sharedOnly: true, env: { ANTHROPIC_AUTH_TOKEN: "relay-secret", LOCAL_THEME: "1" } }));
  await shared.sync(x.runtime, x.slot);
  const initial = JSON.parse(await fs.readFile(targetFile));
  assert.equal(initial.sharedOnly, true); assert.equal(initial.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal((await fs.lstat(path.join(x.slot.dir, "skills"))).isSymbolicLink(), true);
  const target = await x.runtime.readProfile(x.slot); target.mcpServers.local = { command: "account customization" }; await x.runtime.writeProfile(x.slot, target);
  const live = await x.runtime.readProfile(defaults); live.mcpServers = { fresh: { command: "shared fresh" } }; await x.runtime.writeProfile(defaults, live);
  await fs.writeFile(settingsFile, JSON.stringify({ theme: "dark", freshSetting: true }));
  await shared.sync(x.runtime, x.slot);
  const mirrored = await x.runtime.readProfile(x.slot), settings = JSON.parse(await fs.readFile(targetFile));
  assert.deepEqual(mirrored.mcpServers, { local: { command: "account customization" }, fresh: { command: "shared fresh" } });
  assert.equal(settings.theme, "dark"); assert.equal(settings.sharedOnly, undefined); assert.equal(settings.freshSetting, true);
  const finalDefault = await x.runtime.readProfile(defaults); finalDefault.mcpServers = {}; await x.runtime.writeProfile(defaults, finalDefault);
  await shared.sync(x.runtime, x.slot);
  assert.deepEqual((await x.runtime.readProfile(x.slot)).mcpServers, { local: { command: "account customization" } });
});

test("Claude registry corruption fails closed before deleting native credentials", async t => {
  const x = await fixture(t), file = path.join(x.runtime.root, "accounts.json");
  const raw = JSON.stringify({ version: 1, accounts: { "target:org": { localId: "a".repeat(32), backups: "../../outside", email: {} } } });
  await fs.writeFile(file, raw);
  await assert.rejects(x.manager.remove("target:org"), /unreadable/);
  assert.equal(await fs.readFile(file, "utf8"), raw);
  assert.equal((await x.runtime.credentials.read(x.slot)).claudeAiOauth.accessToken, "target-token");
});
