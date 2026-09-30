"use strict";

// Tests for the provider-switch layer (cc-switch config-management port):
// store CRUD, key-field projections for claude/codex/gemini, the TOML/env
// line editors, backups, and the /api/provider-switch/* HTTP surface.

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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-psw-home-"));
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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

test("provider-switch store: create / list / update / delete / current pointer", async () => {
  const store = require("../src/lib/provider-switch/store");

  const created = await store.createProvider("claude", {
    name: "Relay A",
    category: "custom",
    settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://a.example.com" } },
  });
  assert.match(created.id, /^p_/);
  assert.equal(created.category, "custom");

  await store.setCurrentProvider("claude", created.id);
  let state = await store.listProviders("claude");
  assert.equal(state.current, created.id);
  assert.equal(state.providers.length, 1);

  await store.updateProvider("claude", created.id, { name: "Relay A2" });
  state = await store.listProviders("claude");
  assert.equal(state.providers[0].name, "Relay A2");

  // settingsConfig validation
  await assert.rejects(
    () => store.createProvider("claude", { name: "Bad", settingsConfig: "nope" }),
    /settingsConfig/,
  );
  await assert.rejects(
    () => store.createProvider("codex", { name: "Bad", settingsConfig: { auth: 42 } }),
    /settingsConfig\.auth/,
  );
  await assert.rejects(() => store.createProvider("nope", { name: "Bad" }), /Unsupported app/);

  await store.deleteProvider("claude", created.id);
  state = await store.listProviders("claude");
  assert.equal(state.current, null);
  assert.equal(state.providers.length, 0);
});

// ---------------------------------------------------------------------------
// Claude projection
// ---------------------------------------------------------------------------

test("provider-switch claude projection: floor keys swapped, user fields preserved", async () => {
  const targets = require("../src/lib/provider-switch/targets");

  const prev = {
    settingsConfig: {
      env: { ANTHROPIC_BASE_URL: "https://a.example.com", ANTHROPIC_AUTH_TOKEN: "sk-a" },
      model: "claude-opus-4-6",
    },
  };
  const target = {
    settingsConfig: {
      env: { ANTHROPIC_BASE_URL: "https://b.example.com", ANTHROPIC_AUTH_TOKEN: "sk-b" },
      model: "claude-sonnet-4-6",
    },
  };
  const live = {
    // User-owned content that must survive the switch untouched.
    hooks: { Stop: [{ hooks: [{ type: "command", command: "aitool hook" }] }] },
    permissions: { allow: ["Bash"] },
    env: { CUSTOM_USER_KEY: "keep-me", ...prev.settingsConfig.env },
  };

  const next = targets.projectClaude({ prev, target, live });
  assert.equal(next.env.ANTHROPIC_BASE_URL, "https://b.example.com");
  assert.equal(next.env.ANTHROPIC_AUTH_TOKEN, "sk-b");
  assert.equal(next.env.CUSTOM_USER_KEY, "keep-me");
  assert.equal(next.model, "claude-sonnet-4-6");
  assert.deepEqual(next.hooks, live.hooks);
  assert.deepEqual(next.permissions, live.permissions);
});

test("provider-switch claude projection: residue of prev provider removed only when unchanged", async () => {
  const targets = require("../src/lib/provider-switch/targets");

  const prev = {
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://a.example.com",
        ANTHROPIC_AUTH_TOKEN: "sk-a",
        // provider-exclusive window value brought in by prev
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
      },
    },
  };
  const target = { settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://b.example.com", ANTHROPIC_AUTH_TOKEN: "sk-b" } } };

  // Untouched residue is removed.
  const untouched = targets.projectClaude({
    prev,
    target,
    live: { env: { ANTHROPIC_BASE_URL: "https://a.example.com", ANTHROPIC_AUTH_TOKEN: "sk-a", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000" } },
  });
  assert.equal(untouched.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
  assert.equal(untouched.env.ANTHROPIC_BASE_URL, "https://b.example.com");

  // User-edited values are kept.
  const edited = targets.projectClaude({
    prev,
    target,
    live: { env: { ANTHROPIC_BASE_URL: "https://a.example.com", ANTHROPIC_AUTH_TOKEN: "sk-a", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "99999" } },
  });
  assert.equal(edited.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "99999");

  // User-owned env keys are never projected even if a preset carries them.
  const withUserKey = targets.projectClaude({
    prev: null,
    target: { settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: "sk-x", CLAUDE_CODE_USE_POWERSHELL_TOOL: "true" } } },
    live: {},
  });
  assert.equal(withUserKey.env.CLAUDE_CODE_USE_POWERSHELL_TOOL, undefined);
  assert.equal(withUserKey.env.ANTHROPIC_AUTH_TOKEN, "sk-x");
});

// ---------------------------------------------------------------------------
// Codex projection (TOML + auth stash decision)
// ---------------------------------------------------------------------------

test("provider-switch toml editor: patches managed keys, preserves notify and comments", async () => {
  const toml = require("../src/lib/provider-switch/toml");

  const original = [
    "# codex config",
    "model = \"gpt-5\"",
    "notify = [\"bash\", \"/hooks/notify.sh\"]",
    "model_reasoning_effort = \"high\"",
    "",
    "[model_providers.custom]",
    "name = \"Old relay\"",
    "base_url = \"https://old.example.com/v1\"",
    "wire_api = \"responses\"",
    "",
    "[mcp_servers.tools]",
    "command = \"uvx\"",
    "",
  ].join("\n");

  let text = toml.setTopLevelKey(original, "model", "gpt-5.2");
  text = toml.removeTopLevelKey(text, "model_reasoning_effort");
  text = toml.setTable(text, "model_providers.custom", {
    name: "New relay",
    base_url: "https://new.example.com/v1",
    wire_api: "responses",
  });

  assert.match(text, /^# codex config\n/m);
  assert.match(text, /model = "gpt-5\.2"/);
  assert.match(text, /notify = \["bash", "\/hooks\/notify\.sh"\]/);
  assert.doesNotMatch(text, /model_reasoning_effort/);
  assert.match(text, /base_url = "https:\/\/new\.example\.com\/v1"/);
  assert.match(text, /\[mcp_servers\.tools\]/);
  assert.equal(toml.getTopLevelValue(text, "model"), "gpt-5.2");
  assert.deepEqual(toml.getTableEntries(text, "model_providers.custom"), {
    name: "New relay",
    base_url: "https://new.example.com/v1",
    wire_api: "responses",
  });

  // Removing the table entirely.
  text = toml.setTable(text, "model_providers.custom", null);
  assert.doesNotMatch(text, /model_providers\.custom/);
  assert.match(text, /\[mcp_servers\.tools\]/);

  // Inserting a top-level key into a file without one.
  const inserted = toml.setTopLevelKey("[profiles.fast]\nmodel = \"x\"\n", "model_provider", "custom");
  assert.match(inserted, /^model_provider = "custom"\n\[profiles\.fast\]/);
});

test("provider-switch codex projection: table replaced/removed, managed keys residue-aware", async () => {
  const targets = require("../src/lib/provider-switch/targets");

  const liveToml = [
    "model = \"gpt-5\"",
    "model_provider = \"custom\"",
    "notify = [\"bash\", \"/hooks/notify.sh\"]",
    "",
    "[model_providers.custom]",
    "name = \"Old\"",
    "base_url = \"https://old.example.com/v1\"",
    "",
  ].join("\n");

  const prev = {
    category: "custom",
    settingsConfig: {
      auth: null,
      config: {
        model: "gpt-5",
        model_provider: "custom",
        model_providers: { custom: { name: "Old", base_url: "https://old.example.com/v1" } },
      },
    },
  };

  // Target without a provider table: table removed, keys updated.
  const targetB = {
    category: "custom",
    settingsConfig: { auth: null, config: { model: "gpt-5.2" } },
  };
  const out = targets.projectCodex({ prev, target: targetB, liveToml, liveAuth: {} });
  assert.match(out.configToml, /model = "gpt-5\.2"/);
  assert.doesNotMatch(out.configToml, /model_providers\.custom/);
  assert.doesNotMatch(out.configToml, /model_provider/); // residue removed (unchanged)
  assert.match(out.configToml, /notify = \["bash", "\/hooks\/notify\.sh"\]/);

  // Target with its own table: replaced wholesale.
  const targetC = {
    category: "custom",
    settingsConfig: {
      auth: null,
      config: {
        model: "gpt-5.2",
        model_provider: "custom",
        model_providers: { custom: { name: "New", base_url: "https://new.example.com/v1" } },
      },
    },
  };
  const outC = targets.projectCodex({ prev, target: targetC, liveToml, liveAuth: {} });
  assert.match(outC.configToml, /base_url = "https:\/\/new\.example\.com\/v1"/);
  assert.doesNotMatch(outC.configToml, /old\.example\.com/);
  assert.equal(outC.auth.action, "keep");
});

test("provider-switch codex auth: stashed when leaving official, restored when switching back", async () => {
  const targets = require("../src/lib/provider-switch/targets");

  const official = { category: "official", settingsConfig: { auth: null, config: {} } };
  const relay = { category: "custom", settingsConfig: { auth: null, config: {} } };
  const chatgptLogin = { tokens: { access_token: "tok", account_id: "acc" }, last_refresh: "x" };

  // official -> third-party: stash + clear.
  const away = targets.resolveCodexAuth({ prev: official, target: relay, liveAuth: chatgptLogin, stash: null });
  assert.equal(away.action, "stash");
  assert.deepEqual(away.stashContent, chatgptLogin);
  assert.deepEqual(away.content, {});

  // third-party -> official with empty auth.json: restore stash.
  const back = targets.resolveCodexAuth({ prev: relay, target: official, liveAuth: {}, stash: chatgptLogin });
  assert.equal(back.action, "write");
  assert.deepEqual(back.content, chatgptLogin);
  assert.equal(back.restoreStash, true);

  // third-party -> official with a fresh live login: keep, do not clobber.
  const freshLogin = targets.resolveCodexAuth({ prev: relay, target: official, liveAuth: chatgptLogin, stash: chatgptLogin });
  assert.equal(freshLogin.action, "keep");

  // Preset carrying explicit auth: written as-is.
  const withAuth = targets.resolveCodexAuth({
    prev: null,
    target: { category: "custom", settingsConfig: { auth: { OPENAI_API_KEY: "sk-z" }, config: {} } },
    liveAuth: {},
    stash: null,
  });
  assert.deepEqual(withAuth.content, { OPENAI_API_KEY: "sk-z" });
  assert.equal(withAuth.action, "write");

  // Third-party -> third-party: untouched.
  const relayToRelay = targets.resolveCodexAuth({ prev: relay, target: relay, liveAuth: {}, stash: null });
  assert.equal(relayToRelay.action, "keep");
});

// ---------------------------------------------------------------------------
// Gemini projection (.env)
// ---------------------------------------------------------------------------

test("provider-switch gemini projection: env keys replaced in place, comments preserved", async () => {
  const targets = require("../src/lib/provider-switch/targets");
  const envfile = require("../src/lib/provider-switch/envfile");

  const prev = { settingsConfig: { env: { GEMINI_API_KEY: "old-key", GOOGLE_GEMINI_BASE_URL: "https://a.example.com" } } };
  const target = { settingsConfig: { env: { GEMINI_API_KEY: "new-key" } } };
  const liveEnv = [
    "# gemini api config",
    "GEMINI_API_KEY=old-key",
    "GOOGLE_GEMINI_BASE_URL=https://a.example.com",
    "GOOGLE_CLOUD_PROJECT=my-project",
    "",
  ].join("\n");

  const next = targets.projectGemini({ prev, target, liveEnv });
  assert.match(next, /^# gemini api config\n/m);
  assert.match(next, /^GEMINI_API_KEY=new-key$/m);
  assert.doesNotMatch(next, /GOOGLE_GEMINI_BASE_URL/); // residue removed
  assert.match(next, /^GOOGLE_CLOUD_PROJECT=my-project$/m); // user key untouched

  assert.equal(envfile.getEnvValue(next, "GEMINI_API_KEY"), "new-key");

  // Quoted values round-trip.
  const quoted = envfile.setEnvValue("A=1\n", "A", "hello world");
  assert.match(quoted, /^A="hello world"$/m);
  assert.equal(envfile.getEnvValue(quoted, "A"), "hello world");
});

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

test("provider-switch backups: first write backed up once, restore content matches", async () => {
  const backup = require("../src/lib/provider-switch/backup");

  const target = path.join(tmpHome, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{"original": true}\n');

  const first = await backup.createBackup("claude", target);
  assert.ok(first, "first write should create a backup");
  const second = await backup.createBackup("claude", target);
  assert.equal(second, null, "subsequent writes reuse the first backup");

  const list = await backup.listBackups("claude");
  assert.equal(list.length, 1);
  assert.equal(list[0].target, "settings.json");

  const content = await backup.readBackup("claude", list[0].name);
  assert.equal(content, '{"original": true}\n');

  // Dotfile basenames round-trip through the backup name.
  const envTarget = path.join(tmpHome, ".gemini", ".env");
  fs.mkdirSync(path.dirname(envTarget), { recursive: true });
  fs.writeFileSync(envTarget, "GEMINI_API_KEY=x\n");
  await backup.createBackup("gemini", envTarget);
  const geminiBackups = await backup.listBackups("gemini");
  assert.equal(geminiBackups[0].target, ".env");
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function makeReq({ method = "GET", url, headers = {}, body } = {}) {
  const base = Readable.from(body != null ? [Buffer.from(body)] : []);
  base.method = method;
  base.url = url;
  base.headers = { host: "localhost", ...headers };
  return base;
}

function makeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload ? String(payload) : "";
    },
  };
  return res;
}

async function call(handler, options) {
  const req = makeReq(options);
  const res = makeRes();
  await handler(req, res, new URL(`http://localhost${options.url}`), {
    isAuthorizedLocalMutation: () => true,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

test("provider-switch api: status / create / switch / live save conflict flow", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";

  // Status on a fresh machine.
  const status0 = await call(handler, { url: `${prefix}/status` });
  assert.equal(status0.status, 200);
  assert.equal(status0.body.ok, true);
  assert.equal(status0.body.apps.length, 3);
  const claude0 = status0.body.apps.find((app) => app.app === "claude");
  assert.equal(claude0.current, null);
  assert.equal(claude0.files[0].path, path.join(tmpHome, ".claude", "settings.json"));

  // Presets list.
  const presets = await call(handler, { url: `${prefix}/presets?app=codex` });
  assert.ok(presets.body.presets.some((p) => p.category === "official"));

  // Create two providers and switch between them.
  const a = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "claude",
      name: "Relay A",
      category: "custom",
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://a.example.com", ANTHROPIC_AUTH_TOKEN: "sk-a" } },
    }),
  });
  assert.equal(a.status, 200);
  const b = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "claude",
      name: "Relay B",
      category: "custom",
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://b.example.com", ANTHROPIC_AUTH_TOKEN: "sk-b" } },
    }),
  });

  const livePath = path.join(tmpHome, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(livePath), { recursive: true });
  fs.writeFileSync(
    livePath,
    JSON.stringify({ hooks: { Stop: [] }, env: { ANTHROPIC_BASE_URL: "https://a.example.com", ANTHROPIC_AUTH_TOKEN: "sk-a" } }, null, 2) + "\n",
  );

  const switched = await call(handler, {
    method: "POST",
    url: `${prefix}/switch`,
    body: JSON.stringify({ app: "claude", id: b.body.provider.id }),
  });
  assert.equal(switched.status, 200);
  assert.deepEqual(switched.body.wrote, [livePath]);
  assert.ok(switched.body.backups.length >= 1, "first write takes a backup");

  const liveAfter = JSON.parse(fs.readFileSync(livePath, "utf8"));
  assert.equal(liveAfter.env.ANTHROPIC_BASE_URL, "https://b.example.com");
  assert.deepEqual(liveAfter.hooks, { Stop: [] });

  const status1 = await call(handler, { url: `${prefix}/status` });
  const claude1 = status1.body.apps.find((app) => app.app === "claude");
  assert.equal(claude1.current, b.body.provider.id);

  // Switching back to A removes B's values.
  const back = await call(handler, {
    method: "POST",
    url: `${prefix}/switch`,
    body: JSON.stringify({ app: "claude", id: a.body.provider.id }),
  });
  assert.equal(back.status, 200);
  const liveBack = JSON.parse(fs.readFileSync(livePath, "utf8"));
  assert.equal(liveBack.env.ANTHROPIC_BASE_URL, "https://a.example.com");
  assert.equal(liveBack.env.ANTHROPIC_AUTH_TOKEN, "sk-a");

  // Live editor: conflict when the file changed under us.
  const live0 = await call(handler, { url: `${prefix}/live?app=claude&file=settings` });
  assert.equal(live0.status, 200);
  fs.writeFileSync(livePath, '{"external": "edit"}\n');
  const conflict = await call(handler, {
    method: "PUT",
    url: `${prefix}/live?app=claude&file=settings`,
    body: JSON.stringify({ content: '{"mine": true}\n', baseHash: live0.body.baseHash }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "conflict");
  assert.equal(conflict.body.currentContent, '{"external": "edit"}\n');

  // keepMine policy overwrites the external edit.
  const keepMine = await call(handler, {
    method: "PUT",
    url: `${prefix}/live?app=claude&file=settings`,
    body: JSON.stringify({ content: '{"mine": true}\n', baseHash: live0.body.baseHash, policy: "keepMine" }),
  });
  assert.equal(keepMine.status, 200);
  assert.equal(fs.readFileSync(livePath, "utf8"), '{"mine": true}\n');

  // Backups listed and restorable (restore the oldest = the first-write
  // backup taken before the very first switch).
  const backups = await call(handler, { url: `${prefix}/backups?app=claude` });
  assert.ok(backups.body.backups.length >= 1);
  const oldest = backups.body.backups[backups.body.backups.length - 1];
  const restore = await call(handler, {
    method: "POST",
    url: `${prefix}/backups/restore`,
    body: JSON.stringify({ app: "claude", backup: oldest.name }),
  });
  assert.equal(restore.status, 200);
  const restored = JSON.parse(fs.readFileSync(livePath, "utf8"));
  assert.ok(restored.env, "restore brings back the pre-write settings.json");

  // Delete a provider.
  const del = await call(handler, {
    method: "DELETE",
    url: `${prefix}/providers/${b.body.provider.id}?app=claude`,
  });
  assert.equal(del.status, 200);
  const status2 = await call(handler, { url: `${prefix}/status` });
  assert.equal(status2.body.apps.find((app) => app.app === "claude").providers.length, 1);
});

test("provider-switch api: mutations rejected without local auth", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const req = makeReq({
    method: "POST",
    url: "/api/provider-switch/switch",
    body: JSON.stringify({ app: "claude", id: "p_x" }),
  });
  const res = makeRes();
  await handleProviderSwitchApiRequest(req, res, new URL("http://localhost/api/provider-switch/switch"), {
    isAuthorizedLocalMutation: () => false,
  });
  assert.equal(res.statusCode, 401);
});

test("provider-switch api: codex switch stashes official login and restores it", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";

  const official = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({ app: "codex", name: "OpenAI Official", category: "official", settingsConfig: { auth: null, config: {} } }),
  });
  const relay = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "codex",
      name: "Relay",
      category: "custom",
      settingsConfig: {
        auth: null,
        config: { model: "gpt-5.2", model_provider: "custom", model_providers: { custom: { name: "R", base_url: "https://r.example.com/v1" } } },
      },
    }),
  });

  const codexDir = path.join(tmpHome, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const login = { tokens: { access_token: "tok" } };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(login));
  fs.writeFileSync(path.join(codexDir, "config.toml"), 'model = "gpt-5"\nnotify = ["bash", "/hooks/notify.sh"]\n');

  // official -> relay: auth stashed, auth.json cleared, config patched.
  const away = await call(handler, {
    method: "POST",
    url: `${prefix}/switch`,
    body: JSON.stringify({ app: "codex", id: relay.body.provider.id }),
  });
  assert.equal(away.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), {});
  const configAway = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
  assert.match(configAway, /model = "gpt-5\.2"/);
  assert.match(configAway, /\[model_providers\.custom\]/);
  assert.match(configAway, /notify = \["bash", "\/hooks\/notify\.sh"\]/);
  const stashFile = path.join(tmpHome, ".aitool", "provider-switch", "codex-auth-stash.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(stashFile, "utf8")).auth, login);
  const statusAway = await call(handler, { url: `${prefix}/status` });
  assert.ok(statusAway.body.codexAuthStash, "status reports the stash");

  // relay -> official: stash restored, stash file removed.
  const back = await call(handler, {
    method: "POST",
    url: `${prefix}/switch`,
    body: JSON.stringify({ app: "codex", id: official.body.provider.id }),
  });
  assert.equal(back.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), login);
  assert.equal(fs.existsSync(stashFile), false);
});
