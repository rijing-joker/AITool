"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test, beforeEach, afterEach } = require("node:test");
const store = require("../src/lib/provider-switch/store");
const profiles = require("../src/lib/provider-switch/profiles");
const bundles = require("../src/lib/provider-switch/profile-bundles");
const mcp = require("../src/lib/provider-switch/mcp");
const api = require("../src/lib/provider-switch/api");
const { Readable } = require("node:stream");
const TOML = require("smol-toml");
const paths = require("../src/lib/provider-switch/paths");
let dir, home, userProfile;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-profile-bundle-")); home = process.env.HOME; userProfile = process.env.USERPROFILE; process.env.HOME = dir; process.env.USERPROFILE = dir; });
afterEach(async () => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; if (userProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = userProfile; await fs.rm(dir, { recursive: true, force: true }); });
async function seed(app) {
  const settingsConfig = app === "codex" ? { config: { model_provider: "custom", model: "fixture", model_providers: { custom: { base_url: "http://localhost:19990/v1", wire_api: "responses", experimental_bearer_token: "fixture-key" } } } }
    : { env: { ANTHROPIC_BASE_URL: "http://localhost:19990", ANTHROPIC_MODEL: "fixture", ANTHROPIC_AUTH_TOKEN: "fixture-key" } };
  const row = await store.createProvider(app, { name: "Fixture", settingsConfig });
  await api.switchProvider({ app, id: row.id }); return row;
}
async function applyBundle(id, apps) {
  const plan = await bundles.preview({ id, apps });
  const req = Readable.from([Buffer.from(JSON.stringify({ id, apps, revision: plan.revision }))]);
  req.method = "POST";
  let status, payload;
  await api.handleProviderSwitchApiRequest(req, {
    writeHead(value) { status = value; }, end(value) { payload = JSON.parse(value); },
  }, new URL("http://localhost/api/provider-switch/profiles/apply-bundle"), { isAuthorizedLocalMutation: () => true });
  assert.equal(status, 200, JSON.stringify(payload)); assert.equal(payload.ok, true);
  assert.ok(payload.results.every(row => row.status === "applied"), JSON.stringify(payload.results));
  return payload;
}

test("multi-app capture fills selected slots and preserves uncaptured versus empty", async () => {
  const claude = await seed("claude");
  const profile = await profiles.createProfile({ name: "Daily", apps: ["claude", "codex"] });
  assert.deepEqual(profile.capturedApps, ["claude", "codex"]);
  assert.equal(profile.payload.providers.claude, claude.id); assert.equal(profile.payload.providers.codex, "");
  assert.equal(profile.payload.providers.gemini, null); assert.deepEqual(profile.payload.mcp.codex, []); assert.equal(profile.payload.prompts.codex, "");
  assert.deepEqual((await bundles.preview({ id: profile.id, apps: ["claude", "codex"] })).results.map(row => row.ready), [true, true]);
  await assert.rejects(profiles.createProfile({ name: "Bad", apps: [] }), /supported/);
});

test("preflight blocks dangling references and stale file revisions without writes", async () => {
  await seed("claude");
  await mcp.upsertServer({ id: "fixture", server: { command: "node" }, apps: { claude: true } });
  const profile = await profiles.createProfile({ name: "Work", apps: ["claude"] });
  await mcp.deleteServer("fixture");
  const blocked = await bundles.preview({ id: profile.id, apps: ["claude"] });
  assert.equal(blocked.results[0].ready, false); assert.match(blocked.results[0].errors[0], /MCP server not found/);
  await assert.rejects(bundles.apply({ id: profile.id, apps: ["claude"], revision: blocked.revision }), /references/);
  const freshProfile = await profiles.createProfile({ name: "Fresh", apps: ["claude"] });
  const plan = await bundles.preview({ id: freshProfile.id, apps: ["claude"] });
  const file = path.join(dir, ".claude/settings.json"); await fs.appendFile(file, "\n");
  await assert.rejects(bundles.apply({ id: freshProfile.id, apps: ["claude"], revision: plan.revision }), error => error.status === 409);
});

test("selected apps apply independently with recovery copies and per-app results", async () => {
  const claude = await seed("claude"), codex = await seed("codex");
  const profile = await profiles.createProfile({ name: "Work", apps: ["claude", "codex"] });
  const other = await store.createProvider("claude", { name: "Other", settingsConfig: { env: { ANTHROPIC_MODEL: "other" } } });
  await api.switchProvider({ app: "claude", id: other.id });
  const plan = await bundles.preview({ id: profile.id, apps: ["claude", "codex"] });
  const result = await bundles.apply({ id: profile.id, apps: ["claude", "codex"], revision: plan.revision, applyProvider: (app, id) => api.switchProvider({ app, id }) });
  assert.deepEqual(result.results.map(row => row.status), ["applied", "applied"]);
  assert.equal((await store.listProviders("claude")).current, claude.id); assert.equal((await store.listProviders("codex")).current, codex.id);
  const manifest = JSON.parse(await fs.readFile(path.join(result.recoveryPath, "manifest.json")));
  const config = manifest.files.find(file => file.target === path.join(dir, ".claude/settings.json"));
  assert.equal(JSON.parse(await fs.readFile(path.join(result.recoveryPath, config.backup))).env.ANTHROPIC_MODEL, "other");
  assert.equal((await fs.stat(path.join(result.recoveryPath, config.backup))).mode & 0o777, 0o600);
});

test("partial failures do not mark a profile fully applied", async () => {
  const row = await seed("claude"), profile = await profiles.createProfile({ name: "Work", apps: ["claude"] });
  const other = await store.createProvider("claude", { name: "Other", settingsConfig: {} }); await store.setCurrentProvider("claude", other.id);
  const plan = await bundles.preview({ id: profile.id, apps: ["claude"] });
  const result = await bundles.apply({ id: profile.id, apps: ["claude"], revision: plan.revision, applyProvider: async () => { throw new Error("fixture write failure"); } });
  assert.equal(result.results[0].status, "partial"); assert.equal((await profiles.listProfiles()).currentIds.claude, null);
  assert.equal((await store.listProviders("claude")).current, other.id); assert.notEqual(row.id, other.id);
});
test("partial bundle clears the previous marker without autosaving mixed configuration into it", async t => {
  const old = await seed("claude"), before = await profiles.createProfile({ name: "Old", apps: ["claude"] });
  const next = await store.createProvider("claude", { name: "Next", settingsConfig: { env: { ANTHROPIC_MODEL: "next" } } });
  await api.switchProvider({ app: "claude", id: next.id });
  await mcp.upsertServer({ id: "fixture", server: { command: "node" }, apps: { claude: true } });
  const after = await profiles.createProfile({ name: "Next", apps: ["claude"] });
  await api.switchProvider({ app: "claude", id: old.id }); await mcp.toggleServerApp("fixture", "claude", false);
  await profiles.restoreCurrentMarker("claude", before.id);
  t.mock.method(mcp, "toggleServerApp", async () => { throw new Error("MCP failure"); });
  const plan = await bundles.preview({ id: after.id, apps: ["claude"] });
  const result = await bundles.apply({ id: after.id, apps: ["claude"], revision: plan.revision, applyProvider: (app, id) => api.switchProvider({ app, id }) });
  assert.equal(result.results[0].status, "partial");
  assert.equal((await profiles.listProfiles()).currentIds.claude, null);
  assert.equal((await store.listProviders("claude")).current, next.id);
  assert.equal((await profiles.listProfiles()).profiles.find(row => row.id === before.id).payload.providers.claude, old.id);
});

test("shared MCP state changes do not invalidate another selected app's plan", async () => {
  await seed("claude"); await seed("codex");
  await mcp.upsertServer({ id: "shared", server: { command: "node" }, apps: { claude: true, codex: true } });
  const profile = await profiles.createProfile({ name: "Work", apps: ["claude", "codex"] });
  await mcp.toggleServerApp("shared", "claude", false); await mcp.toggleServerApp("shared", "codex", false);
  const plan = await bundles.preview({ id: profile.id, apps: ["claude", "codex"] });
  const result = await bundles.apply({ id: profile.id, apps: ["claude", "codex"], revision: plan.revision, applyProvider: async () => {} });
  assert.deepEqual(result.results.map(row => row.status), ["applied", "applied"]);
  const row = (await mcp.listServers())[0]; assert.equal(row.apps.claude, true); assert.equal(row.apps.codex, true);
});
test("bundle recovery includes complete copied skill contents and detects nested edits", async () => {
  const source = path.join(dir, ".claude/skills/example");
  await fs.mkdir(path.join(source, "reference"), { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "Synthetic skill");
  await fs.writeFile(path.join(source, "reference/data.txt"), "Original reference");
  await require("../src/lib/provider-switch/skills").importSkills();
  const profile = await profiles.createProfile({ name: "Skills", apps: ["claude"] });
  const plan = await bundles.preview({ id: profile.id, apps: ["claude"] });
  await fs.writeFile(path.join(source, "reference/data.txt"), "Updated reference");
  await assert.rejects(bundles.apply({ id: profile.id, apps: ["claude"], revision: plan.revision, applyProvider: async () => {} }), error => error.status === 409);
  const fresh = await bundles.preview({ id: profile.id, apps: ["claude"] });
  const result = await bundles.apply({ id: profile.id, apps: ["claude"], revision: fresh.revision, applyProvider: async () => {} });
  const manifest = JSON.parse(await fs.readFile(path.join(result.recoveryPath, "manifest.json")));
  const copied = manifest.links.find(row => row.target === source);
  assert.equal(await fs.readFile(path.join(result.recoveryPath, copied.backup, "reference/data.txt"), "utf8"), "Updated reference");
});

test("empty Codex bundle restores the stashed official login and removes the relay", async () => {
  const login = { tokens: { access_token: "synthetic-login", account_id: "synthetic-account" }, last_refresh: "fixture" };
  const authPath = path.join(dir, ".codex/auth.json"), configPath = path.join(dir, ".codex/config.toml");
  await fs.mkdir(path.dirname(authPath)); await fs.writeFile(authPath, JSON.stringify(login));
  await fs.writeFile(configPath, 'approval_policy = "never"\n');
  const empty = await profiles.createProfile({ name: "Official login", apps: ["codex"] });
  await seed("codex");
  assert.deepEqual(JSON.parse(await fs.readFile(authPath)), {});
  assert.equal(Object.keys(JSON.parse(await fs.readFile(paths.codexAuthStashPath())).logins).length, 1);
  await applyBundle(empty.id, ["codex"]);
  assert.deepEqual(JSON.parse(await fs.readFile(authPath)), login);
  assert.equal((await fs.stat(authPath)).mode & 0o777, 0o600);
  const config = TOML.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.model_provider, undefined); assert.equal(config.model_providers?.custom, undefined);
  assert.equal(config.approval_policy, "never"); assert.equal((await store.listProviders("codex")).current, null);
  assert.deepEqual(JSON.parse(await fs.readFile(paths.codexAuthStashPath())).logins, {});
  await applyBundle(empty.id, ["codex"]);
  assert.deepEqual(JSON.parse(await fs.readFile(authPath)), login);
});

test("Codex disconnect restores login when config and auth files were removed", async () => {
  const authPath = path.join(dir, ".codex/auth.json"), configPath = path.join(dir, ".codex/config.toml");
  const login = { tokens: { access_token: "synthetic-login", account_id: "synthetic-account" } };
  await fs.mkdir(path.dirname(authPath)); await fs.writeFile(authPath, JSON.stringify(login));
  const empty = await profiles.createProfile({ name: "Disconnected", apps: ["codex"] });
  await seed("codex");
  await fs.rm(authPath); await fs.rm(configPath);
  await store.setCurrentProvider("codex", null);
  await applyBundle(empty.id, ["codex"]);
  assert.deepEqual(JSON.parse(await fs.readFile(authPath)), login);
});

test("empty provider snapshots survive automatic save and repeated bundle switches", async () => {
  const empty = await profiles.createProfile({ name: "Empty", apps: ["claude", "codex"] });
  const provider = await seed("claude"), connected = await profiles.createProfile({ name: "Connected", apps: ["claude"] });
  await applyBundle(empty.id, ["claude"]);
  assert.equal((await store.listProviders("claude")).current, null);
  await applyBundle(connected.id, ["claude"]);
  assert.equal((await store.listProviders("claude")).current, provider.id);
  const saved = (await profiles.listProfiles()).profiles.find(row => row.id === empty.id);
  assert.equal(saved.payload.providers.claude, ""); assert.equal(saved.payload.providers.codex, "");
  assert.equal(saved.payload.providers.gemini, null);
  await applyBundle(empty.id, ["claude"]);
  assert.equal((await store.listProviders("claude")).current, null);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, ".claude/settings.json"))).env?.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("loading an older bundle recovers empty providers only for explicitly captured apps", async () => {
  const empty = await profiles.createProfile({ name: "Empty", apps: ["claude"] });
  const raw = JSON.parse(await fs.readFile(paths.profilesStorePath()));
  raw.profiles[0].payload.providers.claude = null;
  await fs.writeFile(paths.profilesStorePath(), JSON.stringify(raw));
  const loaded = (await profiles.listProfiles()).profiles.find(row => row.id === empty.id);
  assert.equal(loaded.payload.providers.claude, ""); assert.equal(loaded.payload.providers.codex, null);
  await seed("claude"); await applyBundle(empty.id, ["claude"]);
  assert.equal((await store.listProviders("claude")).current, null);
});

test("Codex disconnect keeps externally edited relay fields while restoring official login", async () => {
  const authPath = path.join(dir, ".codex/auth.json"), configPath = path.join(dir, ".codex/config.toml");
  const login = { tokens: { access_token: "synthetic-login", account_id: "synthetic-account" } };
  await fs.mkdir(path.dirname(authPath)); await fs.writeFile(authPath, JSON.stringify(login));
  const empty = await profiles.createProfile({ name: "Disconnected", apps: ["codex"] });
  await seed("codex");
  const config = TOML.parse(await fs.readFile(configPath, "utf8"));
  config.model_providers.custom.base_url = "https://user-edited.test/v1";
  await fs.writeFile(configPath, TOML.stringify(config));
  await applyBundle(empty.id, ["codex"]);
  assert.deepEqual(JSON.parse(await fs.readFile(authPath)), login);
  assert.equal(TOML.parse(await fs.readFile(configPath, "utf8")).model_providers.custom.base_url, "https://user-edited.test/v1");
});
