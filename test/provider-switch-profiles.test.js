"use strict";

// Tests for the profile layer (cc-switch's services/profile): snapshot,
// apply-with-autosave, minimal MCP/skill toggles, dangling warnings, current
// markers and the /api/provider-switch/profiles HTTP surface.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");

let tmpHome;
let prevHome;
let prevUserProfile;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-profiles-home-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function seedAppState(app) {
  const store = require("../src/lib/provider-switch/store");
  const mcp = require("../src/lib/provider-switch/mcp");
  const skills = require("../src/lib/provider-switch/skills");
  const prompts = require("../src/lib/provider-switch/prompts");

  const provider = await store.createProvider(app, {
    name: "Relay A",
    settingsConfig: app === "codex" ? { auth: { OPENAI_API_KEY: "sk" }, config: {} } : { env: { ANTHROPIC_AUTH_TOKEN: "sk" } },
  });
  await store.setCurrentProvider(app, provider.id);
  await mcp.upsertServer({ id: "fetch", server: { command: "fetch" } });
  await mcp.toggleServerApp("fetch", app, true);
  // importSkills scans ~/.agents/skills; seed one skill there and enable it.
  const skillSource = path.join(tmpHome, ".agents", "skills", "my-skill");
  fs.mkdirSync(skillSource, { recursive: true });
  fs.writeFileSync(path.join(skillSource, "SKILL.md"), "---\nname: my-skill\ndescription: d\n---\nbody");
  await skills.importSkills();
  await skills.toggleSkill("my-skill", app, true);
  await prompts.upsertPrompt(app, { id: "rules", content: `be concise (${app})`, enabled: true });
  return { providerId: provider.id };
}

test("profiles: create snapshots all four slots of the initiating app only", async () => {
  const store = require("../src/lib/provider-switch/store");
  const profiles = require("../src/lib/provider-switch/profiles");
  const { providerId } = await seedAppState("claude");

  const profile = await profiles.createProfile({ name: "Work", app: "claude" });
  assert.match(profile.id, /^pr_/);
  assert.equal(profile.payload.providers.claude, providerId);
  assert.deepEqual(profile.payload.mcp.claude, ["fetch"]);
  assert.deepEqual(profile.payload.skills.claude, ["my-skill"]);
  assert.equal(profile.payload.prompts.claude, "rules");
  // Other apps were never captured — applying must not touch them.
  assert.equal(profile.payload.providers.codex, null);
  assert.equal(profile.payload.mcp.codex, null);
  assert.ok(profiles.scopeCaptured(profile, "claude"));
  assert.ok(!profiles.scopeCaptured(profile, "codex"));
  void store;
});

test("profiles: apply switches, toggles minimally, enables the prompt and marks current", async () => {
  const store = require("../src/lib/provider-switch/store");
  const mcp = require("../src/lib/provider-switch/mcp");
  const skills = require("../src/lib/provider-switch/skills");
  const prompts = require("../src/lib/provider-switch/prompts");
  const profiles = require("../src/lib/provider-switch/profiles");
  const { providerId } = await seedAppState("claude");
  const profile = await profiles.createProfile({ name: "Work", app: "claude" });

  // Leave the snapshotted state: another provider, MCP off, skill off, prompt off.
  const other = await store.createProvider("claude", { name: "Relay B", settingsConfig: { env: {} } });
  await store.setCurrentProvider("claude", other.id);
  await mcp.toggleServerApp("fetch", "claude", false);
  await skills.toggleSkill("my-skill", "claude", false);
  await prompts.upsertPrompt("claude", { id: "rules", content: "be concise (claude)", enabled: false });

  const applied = [];
  const result = await profiles.applyProfile({ id: profile.id, app: "claude", applyProvider: async (app, pid) => applied.push([app, pid]) });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(applied, [["claude", providerId]]);
  assert.deepEqual((await mcp.listServers()).find((s) => s.id === "fetch").apps.claude, true);
  assert.deepEqual((await skills.listSkills()).find((s) => s.id === "my-skill").apps.claude, true);
  assert.equal((await prompts.listPrompts("claude")).find((p) => p.enabled).id, "rules");
  const { currentIds } = await profiles.listProfiles();
  assert.equal(currentIds.claude, profile.id);

  // Re-apply is a no-op for already-matching state (minimal toggles).
  const result2 = await profiles.applyProfile({ id: profile.id, app: "claude", applyProvider: async () => {} });
  assert.deepEqual(result2.warnings, []);
});

test("profiles: apply autosaves the previous profile of the app", async () => {
  const store = require("../src/lib/provider-switch/store");
  const profiles = require("../src/lib/provider-switch/profiles");
  await seedAppState("claude");
  const first = await profiles.createProfile({ name: "First", app: "claude" });
  // Binding First as current is what makes the later switch autosave into it.
  await profiles.applyProfile({ id: first.id, app: "claude", applyProvider: async () => {} });

  const other = await store.createProvider("claude", { name: "Relay B", settingsConfig: { env: {} } });
  await store.setCurrentProvider("claude", other.id);
  const second = await profiles.createProfile({ name: "Second", app: "claude" });

  await profiles.applyProfile({ id: second.id, app: "claude", applyProvider: async () => {} });
  // Switching to Second autosaved the leaving state into First.
  const reread = await profiles.listProfiles();
  const firstProfile = reread.profiles.find((p) => p.id === first.id);
  assert.equal(firstProfile.payload.providers.claude, other.id);
  assert.equal(reread.currentIds.claude, second.id);

  // Going back: the live pointer already matches the autosaved state, so no
  // switch fires — but First is bound as current again.
  const applied = [];
  await profiles.applyProfile({ id: first.id, app: "claude", applyProvider: async (app, pid) => applied.push(pid) });
  assert.deepEqual(applied, []);
  const state = await store.listProviders("claude");
  assert.equal(state.current, other.id);
  const finalIds = await profiles.listProfiles();
  assert.equal(finalIds.currentIds.claude, first.id);
});

test("profiles: never-snapshotted apply only marks current; dangling ids warn; delete clears markers", async () => {
  const profiles = require("../src/lib/provider-switch/profiles");
  await seedAppState("claude");
  const empty = await profiles.createProfile({ name: "Empty", app: "claude" });

  // Hand-built profiles: one with dangling references, one with no captured
  // slots at all (all maps empty — every read is undefined).
  const paths = require("../src/lib/provider-switch/paths");
  const { updateJsonLocked } = require("../src/lib/fs");
  const now = new Date().toISOString();
  await updateJsonLocked(paths.profilesStorePath(), (storeFile) => {
    storeFile.profiles.push(
      {
        id: "pr_manual",
        name: "Manual",
        payload: {
          providers: { claude: "p_gone" },
          mcp: { claude: ["gone-server"] },
          skills: { claude: ["gone-skill"] },
          prompts: { claude: "gone-prompt" },
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "pr_never",
        name: "Never",
        payload: { providers: {}, mcp: {}, skills: {}, prompts: {} },
        createdAt: now,
        updatedAt: now,
      },
    );
    return storeFile;
  });

  const result = await profiles.applyProfile({ id: "pr_manual", app: "claude", applyProvider: async () => {} });
  assert.equal(result.warnings.filter((w) => w.includes("no longer exists")).length, 4);
  const { currentIds } = await profiles.listProfiles();
  assert.equal(currentIds.claude, "pr_manual");

  // The never-snapshotted profile applies with an explicit hint warning.
  const neverResult = await profiles.applyProfile({ id: "pr_never", app: "claude", applyProvider: async () => {} });
  assert.equal(neverResult.warnings.length, 1);
  assert.match(neverResult.warnings[0], /marked as current without changes/);

  // Deleting the current profile clears the marker; the captured one stays.
  await profiles.deleteProfile("pr_never");
  const after = await profiles.listProfiles();
  assert.equal(after.currentIds.claude, null);
  assert.equal(after.profiles.some((p) => p.id === empty.id), true);
});

test("profiles: planToggles computes the minimal diff with dangling ids", () => {
  const profiles = require("../src/lib/provider-switch/profiles");
  const { toggles, dangling } = profiles.planToggles(
    [["a", true], ["b", false], ["c", true]],
    ["b", "c", "gone"],
  );
  assert.deepEqual(toggles, [["a", false], ["b", true]]);
  assert.deepEqual(dangling, ["gone"]);
});

test("profiles: HTTP surface (create / list / update / apply / delete) with local auth", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const profiles = require("../src/lib/provider-switch/profiles");
  await seedAppState("claude");
  const ctx = { isAuthorizedLocalMutation: () => true };

  async function call(req, url, authCtx) {
    let status;
    let payload;
    await handleProviderSwitchApiRequest(req, {
      writeHead(s) { status = s; },
      end(b) { payload = JSON.parse(b); },
    }, new URL(url), authCtx);
    return { status, payload };
  }

  const created = await call(post("x", { name: "Work", app: "claude" }), "http://localhost/api/provider-switch/profiles", ctx);
  assert.equal(created.payload.ok, true);
  const id = created.payload.profile.id;

  const renamed = await call(post("x", { id, name: "Work v2" }), "http://localhost/api/provider-switch/profiles/update", ctx);
  assert.equal(renamed.payload.profile.name, "Work v2");

  const applied = await call(post("x", { id, app: "claude" }), "http://localhost/api/provider-switch/profiles/apply", ctx);
  assert.equal(applied.payload.ok, true);
  assert.deepEqual(applied.payload.warnings, []);

  const list = await call(get("x"), "http://localhost/api/provider-switch/profiles", ctx);
  assert.equal(list.payload.profiles.length, 1);
  assert.equal(list.payload.currentIds.claude, id);

  await call(post("x", { id }), "http://localhost/api/provider-switch/profiles/delete", ctx);
  const after = await call(get("x"), "http://localhost/api/provider-switch/profiles", ctx);
  assert.equal(after.payload.profiles.length, 0);
  assert.equal(after.payload.currentIds.claude, null);

  // Mutations require local auth.
  const denied = await call(post("x", { name: "X", app: "claude" }), "http://localhost/api/provider-switch/profiles", {});
  assert.equal(denied.status, 401);
  void profiles;
});

test("profiles: HTTP apply switches providers through the real projection", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const store = require("../src/lib/provider-switch/store");
  const { providerId } = await seedAppState("claude");
  const ctx = { isAuthorizedLocalMutation: () => true };

  async function call(req, url) {
    let status;
    let payload;
    await handleProviderSwitchApiRequest(req, {
      writeHead(s) { status = s; },
      end(b) { payload = JSON.parse(b); },
    }, new URL(url), ctx);
    return { status, payload };
  }

  const created = await call(post("x", { name: "Work", app: "claude" }), "http://localhost/api/provider-switch/profiles");
  assert.equal(created.payload.ok, true);
  const id = created.payload.profile.id;

  // Leave the snapshotted provider, so applying must switch back through the
  // router-injected projection (which takes a single { app, id } payload).
  const other = await store.createProvider("claude", { name: "Relay B", settingsConfig: { env: {} } });
  await store.setCurrentProvider("claude", other.id);

  const applied = await call(post("x", { id, app: "claude" }), "http://localhost/api/provider-switch/profiles/apply");
  assert.equal(applied.payload.ok, true);
  assert.deepEqual(applied.payload.warnings, []);
  assert.equal((await store.listProviders("claude")).current, providerId);
});

function post(url, body) {
  const payload = JSON.stringify(body || {});
  const req = new Readable({
    read() {
      this.push(payload);
      this.push(null);
    },
  });
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  return req;
}

function get(url) {
  const req = new Readable({ read() {} });
  req.method = "GET";
  req.headers = {};
  req.push(null);
  return req;
}
