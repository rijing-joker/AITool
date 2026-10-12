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

test("profiles: autosaving one app preserves every other app's snapshot", async () => {
  const profiles = require("../src/lib/provider-switch/profiles");
  await seedAppState("claude");
  const work = await profiles.createProfile({ name: "Work", app: "claude" });
  const other = await profiles.createProfile({ name: "Other", app: "claude" });
  await profiles.applyProfile({ id: work.id, app: "claude", applyProvider: async () => {} });

  await seedAppState("codex");
  await profiles.applyProfile({ id: work.id, app: "codex", applyProvider: async () => {} });
  await profiles.applyProfile({ id: other.id, app: "codex", applyProvider: async () => {} });
  const saved = (await profiles.listProfiles()).profiles.find((p) => p.id === work.id);
  for (const group of ["providers", "mcp", "skills", "prompts"]) {
    assert.deepEqual(saved.payload[group].claude, work.payload[group].claude, `${group}: Claude snapshot survives Codex autosave`);
    assert.notEqual(saved.payload[group].codex, null, `${group}: Codex state was captured`);
  }

  await profiles.applyProfile({ id: other.id, app: "claude", applyProvider: async () => {} });
  const resaved = (await profiles.listProfiles()).profiles.find((p) => p.id === work.id);
  for (const group of ["providers", "mcp", "skills", "prompts"]) {
    assert.deepEqual(resaved.payload[group].codex, saved.payload[group].codex, `${group}: Codex snapshot survives Claude autosave`);
  }
});

for (const legacy of [false, true]) {
  test(`profiles: ${legacy ? "legacy" : "new"} empty prompt snapshots disable only the captured app`, async () => {
    const profiles = require("../src/lib/provider-switch/profiles");
    const prompts = require("../src/lib/provider-switch/prompts");
    const paths = require("../src/lib/provider-switch/paths");
    const profile = await profiles.createProfile({ name: "No prompt", app: "claude" });
    if (legacy) {
      const raw = JSON.parse(fs.readFileSync(paths.profilesStorePath(), "utf8"));
      raw.profiles[0].payload.prompts.claude = null;
      fs.writeFileSync(paths.profilesStorePath(), JSON.stringify(raw));
    }

    await prompts.upsertPrompt("codex", { id: "codex-rules", content: "Uncaptured app", enabled: true });
    await profiles.applyProfile({ id: profile.id, app: "codex", applyProvider: async () => {} });
    assert.equal((await prompts.listPrompts("codex")).find((p) => p.enabled).id, "codex-rules");
    assert.equal(fs.readFileSync(prompts.promptFilePath("codex"), "utf8"), "Uncaptured app");

    await prompts.upsertPrompt("claude", { id: "rules", content: "Original rules", enabled: true });
    const livePath = prompts.promptFilePath("claude");
    fs.writeFileSync(livePath, "User edited these rules");
    const result = await profiles.applyProfile({ id: profile.id, app: "claude", applyProvider: async () => {} });
    assert.deepEqual(result.warnings, []);
    assert.equal(fs.readFileSync(livePath, "utf8"), "");
    const saved = await prompts.listPrompts("claude");
    assert.equal(saved.some((p) => p.enabled), false);
    assert.equal(saved.find((p) => p.id === "rules").content, "User edited these rules");

    // A later hand-written file has no active prompt owner and stays untouched.
    fs.writeFileSync(livePath, "New unmanaged instructions");
    await profiles.applyProfile({ id: profile.id, app: "claude", applyProvider: async () => {} });
    assert.equal(fs.readFileSync(livePath, "utf8"), "New unmanaged instructions");
  });
}

test("profiles: reports MCP and skill projection failures returned by the toggles", async () => {
  const profiles = require("../src/lib/provider-switch/profiles");
  const mcp = require("../src/lib/provider-switch/mcp");
  const skills = require("../src/lib/provider-switch/skills");
  await seedAppState("claude");
  const profile = await profiles.createProfile({ name: "Work", app: "claude" });
  await mcp.toggleServerApp("fetch", "claude", false);
  await skills.toggleSkill("my-skill", "claude", false);
  const mcpPath = path.join(tmpHome, ".claude.json");
  fs.writeFileSync(mcpPath, "{ malformed user config");
  const userSkill = path.join(tmpHome, ".claude", "skills", "my-skill");
  fs.mkdirSync(userSkill, { recursive: true });
  fs.writeFileSync(path.join(userSkill, "SKILL.md"), "# User-owned skill");

  const result = await profiles.applyProfile({ id: profile.id, app: "claude", applyProvider: async () => {} });
  assert.ok(result.warnings.some((warning) => warning.includes("fetch")), "the MCP error reaches the caller");
  assert.ok(result.warnings.some((warning) => warning.includes("my-skill")), "the skill collision reaches the caller");
  assert.equal(fs.readFileSync(mcpPath, "utf8"), "{ malformed user config");
  assert.equal(fs.readFileSync(path.join(userSkill, "SKILL.md"), "utf8"), "# User-owned skill");
});

test("profiles: a failed prompt disable warns and keeps the prompt active", async (t) => {
  const profiles = require("../src/lib/provider-switch/profiles");
  const prompts = require("../src/lib/provider-switch/prompts");
  const fsp = require("node:fs/promises");
  const profile = await profiles.createProfile({ name: "No prompt", app: "claude" });
  await prompts.upsertPrompt("claude", { id: "rules", content: "Keep these rules", enabled: true });
  const livePath = prompts.promptFilePath("claude");
  const rename = fsp.rename;
  t.mock.method(fsp, "rename", async (source, destination) => {
    if (destination === livePath) throw new Error("fixture: prompt write denied");
    return rename(source, destination);
  });
  const result = await profiles.applyProfile({ id: profile.id, app: "claude", applyProvider: async () => {} });
  assert.ok(result.warnings.some((warning) => warning.includes("prompt write denied")));
  assert.equal(fs.readFileSync(livePath, "utf8"), "Keep these rules");
  assert.equal((await prompts.listPrompts("claude")).find((p) => p.enabled).id, "rules");
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
