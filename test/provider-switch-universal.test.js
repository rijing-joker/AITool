"use strict";

// Tests for the universal provider layer (cc-switch's 统一供应商): store CRUD,
// the claude/codex/gemini child projections, and sync semantics — merged
// children keep their app-specific config and metadata, disabled apps drop
// their child, deletion removes every generated child, and the current
// provider's live files are re-projected.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, beforeEach, afterEach } = require("node:test");

let tmpHome;
let prevHome;
let prevUserProfile;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-universal-home-"));
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

const universalPayload = {
  name: "Shared Gateway",
  providerType: "newapi",
  apps: { claude: true, codex: true, gemini: true },
  baseUrl: "https://gw.example.com",
  apiKey: "sk-shared",
  models: {
    claude: { model: "claude-sonnet-5", haikuModel: "", sonnetModel: "", opusModel: "claude-opus-5" },
    codex: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    gemini: { model: "gemini-3.6-flash" },
  },
  notes: "shared note",
  websiteUrl: "https://www.newapi.pro",
  icon: "newapi",
  iconColor: "#00A67E",
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

test("universal store: upsert / list / patch / delete", async () => {
  const store = require("../src/lib/provider-switch/store");

  const created = await store.upsertUniversalProvider(universalPayload);
  assert.match(created.id, /^u_/);
  assert.equal(created.providerType, "newapi");
  assert.deepEqual(created.apps, { claude: true, codex: true, gemini: true });
  assert.equal(created.baseUrl, "https://gw.example.com");
  assert.equal(created.models.codex.reasoningEffort, "medium");
  assert.equal(await store.listUniversalProviders().then((l) => l.length), 1);

  const patched = await store.upsertUniversalProvider({ id: created.id, name: "Renamed" });
  assert.equal(patched.name, "Renamed");
  assert.equal(patched.baseUrl, "https://gw.example.com");
  assert.equal(patched.createdAt, created.createdAt);
  assert.notEqual(patched.updatedAt, created.updatedAt);

  await store.deleteUniversalProvider(created.id);
  assert.equal(await store.listUniversalProviders().then((l) => l.length), 0);
});

test("universal store: rejects empty name and unknown types, truncates oversized fields", async () => {
  const store = require("../src/lib/provider-switch/store");
  await assert.rejects(() => store.upsertUniversalProvider({ name: "  " }), /name is required/);
  const saved = await store.upsertUniversalProvider({ ...universalPayload, providerType: "mystery" });
  assert.equal(saved.providerType, "custom");
  assert.equal(saved.notes.length, Math.min("shared note".length, 2000));
  await assert.rejects(() => store.upsertUniversalProvider({ ...universalPayload, websiteUrl: "not-a-url" }), /websiteUrl/);
});

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

test("universal projections: claude/codex/gemini child shapes and defaults", async () => {
  const universal = require("../src/lib/provider-switch/universal");
  const provider = await require("../src/lib/provider-switch/store").upsertUniversalProvider(universalPayload);

  const claude = universal.toChildProvider("claude", provider);
  assert.equal(claude.id, `universal-claude-${provider.id}`);
  assert.equal(claude.category, "custom");
  assert.equal(claude.settingsConfig.env.ANTHROPIC_BASE_URL, "https://gw.example.com");
  assert.equal(claude.settingsConfig.env.ANTHROPIC_AUTH_TOKEN, "sk-shared");
  assert.equal(claude.settingsConfig.env.ANTHROPIC_MODEL, "claude-sonnet-5");
  // Unset roles inherit the main model except the explicitly mapped Opus.
  assert.equal(claude.settingsConfig.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-sonnet-5");
  assert.equal(claude.settingsConfig.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-opus-5");

  const codex = universal.toChildProvider("codex", provider);
  assert.equal(codex.settingsConfig.auth.OPENAI_API_KEY, "sk-shared");
  assert.equal(codex.settingsConfig.config.model, "gpt-5.6-sol");
  assert.equal(codex.settingsConfig.config.model_reasoning_effort, "medium");
  assert.equal(codex.settingsConfig.config.model_providers.custom.base_url, "https://gw.example.com/v1");
  assert.equal(codex.settingsConfig.config.model_providers.custom.wire_api, "responses");

  const gemini = universal.toChildProvider("gemini", provider);
  assert.equal(gemini.settingsConfig.env.GEMINI_MODEL, "gemini-3.6-flash");
  assert.equal(gemini.settingsConfig.env.GEMINI_API_KEY, "sk-shared");
});

test("universal projections: base_url /v1 rules and disabled apps yield null", () => {
  const universal = require("../src/lib/provider-switch/universal");
  const base = { id: "u_x", name: "N", apps: { claude: true, codex: true, gemini: true }, baseUrl: "", apiKey: "k", models: {} };
  // Bare origin gains /v1; an existing /v1 and a custom path prefix stay.
  assert.equal(universal.codexBaseUrl("https://gw.example.com"), "https://gw.example.com/v1");
  assert.equal(universal.codexBaseUrl("https://gw.example.com/"), "https://gw.example.com/v1");
  assert.equal(universal.codexBaseUrl("https://gw.example.com/v1"), "https://gw.example.com/v1");
  assert.equal(universal.codexBaseUrl("https://gw.example.com/api/claude"), "https://gw.example.com/api/claude");
  // Defaults land when the models block is absent.
  const codex = universal.toChildProvider("codex", base);
  assert.equal(codex.settingsConfig.config.model, "gpt-4o");
  assert.equal(codex.settingsConfig.config.model_reasoning_effort, "high");
  const claude = universal.toChildProvider("claude", base);
  assert.equal(claude.settingsConfig.env.ANTHROPIC_MODEL, "claude-sonnet-4-20250514");
  // Disabled app → no child (sync then drops the stale one).
  assert.equal(universal.toChildProvider("gemini", { ...base, apps: { claude: true, codex: true, gemini: false } }), null);
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

test("universal sync: children created, merged on update, dropped when disabled, removed on delete", async () => {
  const store = require("../src/lib/provider-switch/store");
  const universal = require("../src/lib/provider-switch/universal");
  const applied = [];
  const provider = await store.upsertUniversalProvider(universalPayload);

  await universal.syncUniversalToApps({ id: provider.id, applyCurrent: async (app, childId) => applied.push([app, childId]) });
  for (const app of ["claude", "codex", "gemini"]) {
    const child = await store.getProvider(app, `universal-${app}-${provider.id}`);
    assert.ok(child, `${app} child exists`);
    assert.equal(child.name, "Shared Gateway");
  }
  assert.deepEqual(applied, [], "nothing is current yet, so no live projection");

  // App-specific child config survives a resync (deep merge keeps the floor).
  const claudeChild = await store.getProvider("claude", `universal-claude-${provider.id}`);
  await store.updateProvider("claude", claudeChild.id, {
    settingsConfig: { ...claudeChild.settingsConfig, env: { ...claudeChild.settingsConfig.env, ANTHROPIC_LOG: "debug" } },
  });
  // Child metadata and ordering are not universal-managed (upstream parity);
  // free-form notes are: sync rewrites them from the parent.
  await store.updateProvider("codex", `universal-codex-${provider.id}`, { notes: "child note" });
  await universal.syncUniversalToApps({ id: provider.id, applyCurrent: async () => {} });
  const merged = await store.getProvider("claude", `universal-claude-${provider.id}`);
  assert.equal(merged.settingsConfig.env.ANTHROPIC_LOG, "debug");
  assert.equal(merged.settingsConfig.env.ANTHROPIC_AUTH_TOKEN, "sk-shared");
  const codexAfter = await store.getProvider("codex", `universal-codex-${provider.id}`);
  assert.equal(codexAfter.notes, "shared note");

  // Disabling an app drops its child; the parent is untouched.
  await store.upsertUniversalProvider({ id: provider.id, apps: { claude: true, codex: true, gemini: false } });
  await universal.syncUniversalToApps({ id: provider.id, applyCurrent: async () => {} });
  assert.equal(await store.getProvider("gemini", `universal-gemini-${provider.id}`), null);
  assert.ok(await store.getProvider("claude", `universal-claude-${provider.id}`));

  // Deleting the parent removes every remaining child.
  await universal.deleteUniversalAndChildren(provider.id);
  assert.equal(await store.getUniversalProvider(provider.id), null);
  assert.equal(await store.getProvider("claude", `universal-claude-${provider.id}`), null);
  assert.equal(await store.getProvider("codex", `universal-codex-${provider.id}`), null);
});

test("universal sync: re-projects live files for apps whose current provider is the child", async () => {
  const store = require("../src/lib/provider-switch/store");
  const universal = require("../src/lib/provider-switch/universal");
  const provider = await store.upsertUniversalProvider(universalPayload);
  await universal.syncUniversalToApps({ id: provider.id, applyCurrent: async () => {} });
  await store.setCurrentProvider("claude", `universal-claude-${provider.id}`);

  const applied = [];
  await universal.syncUniversalToApps({
    id: provider.id,
    applyCurrent: async (app, childId) => applied.push([app, childId]),
  });
  assert.deepEqual(applied, [["claude", `universal-claude-${provider.id}`]]);

  // A failing live projection is reported, not swallowed — and does not stop
  // the other apps from syncing.
  await assert.rejects(
    () => universal.syncUniversalToApps({
      id: provider.id,
      applyCurrent: async (app) => { throw new Error(`write failed for ${app}`); },
    }),
    /write failed for claude/,
  );
  const codexChild = await store.getProvider("codex", `universal-codex-${provider.id}`);
  assert.equal(codexChild.settingsConfig.auth.OPENAI_API_KEY, "sk-shared");
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function post(url, body) {
  const { Readable } = require("node:stream");
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
  const req = new (require("node:stream").Readable)({ read() {} });
  req.method = "GET";
  req.headers = {};
  req.push(null);
  return req;
}

test("universal HTTP surface: upsert / sync / delete via the provider-switch router", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
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

  const upsert = await call(post("x", { provider: universalPayload }), "http://localhost/api/provider-switch/universal");
  assert.equal(upsert.status, 200);
  assert.equal(upsert.payload.ok, true);
  const id = upsert.payload.provider.id;
  assert.match(id, /^u_/);

  const list = await call(get("x"), "http://localhost/api/provider-switch/universal");
  assert.equal(list.payload.providers.length, 1);

  const sync = await call(post("x", { id }), "http://localhost/api/provider-switch/universal/sync");
  assert.equal(sync.payload.ok, true);

  const del = await call(post("x", { id }), "http://localhost/api/provider-switch/universal/delete");
  assert.equal(del.payload.ok, true);
  assert.equal(del.payload.removed, true);

  const after = await call(get("x"), "http://localhost/api/provider-switch/universal");
  assert.equal(after.payload.providers.length, 0);
});

test("universal HTTP surface: sync re-projects the current child through the real projection", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const store = require("../src/lib/provider-switch/store");
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

  const upsert = await call(post("x", { provider: universalPayload }), "http://localhost/api/provider-switch/universal");
  assert.equal(upsert.payload.ok, true);
  const id = upsert.payload.provider.id;
  assert.equal((await call(post("x", { id }), "http://localhost/api/provider-switch/universal/sync")).payload.ok, true);

  // Make the generated child the app's current provider, then re-sync: the
  // live files must re-project through the router-injected switch projection
  // (a single { app, id } payload) instead of failing the whole sync.
  await store.setCurrentProvider("claude", `universal-claude-${id}`);
  const resync = await call(post("x", { id }), "http://localhost/api/provider-switch/universal/sync");
  assert.equal(resync.payload.ok, true);
  if (resync.payload.error) throw new Error(resync.payload.error);
});

test("universal HTTP surface: mutations require local auth", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  let status;
  let payload;
  await handleProviderSwitchApiRequest(
    post("x", { provider: universalPayload }),
    { writeHead(s) { status = s; }, end(b) { payload = JSON.parse(b); } },
    new URL("http://localhost/api/provider-switch/universal"),
    {},
  );
  assert.equal(status, 401);
  assert.equal(payload.ok, false);
});
