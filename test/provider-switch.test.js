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

// Keep the suite hermetic: never probe the local `codex` CLI for the official
// model list. Tests that need mirroring pass fixture rows explicitly.
require("../src/lib/provider-switch/catalog").setCodexOfficialModelsForTests([]);

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

test("provider-switch claude projection: gateway auto-mode compat key reaches settings.json", async () => {
  const targets = require("../src/lib/provider-switch/targets");

  // Claude Code 2.1.281 auto mode classifier only works on official
  // endpoints; gateway providers carry CLAUDE_CODE_AUTO_MODE_SERVER=0 and it
  // must reach the projected settings.json (cc-switch cf567ca).
  const gateway = {
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://gw.example",
        ANTHROPIC_AUTH_TOKEN: "sk-gw",
        CLAUDE_CODE_AUTO_MODE_SERVER: "0",
      },
    },
  };
  const kimi = {
    settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://kimi.example", ANTHROPIC_AUTH_TOKEN: "sk-kimi" } },
  };

  const switched = targets.projectClaude({
    prev: kimi,
    target: gateway,
    live: {
      env: {
        ANTHROPIC_BASE_URL: "https://kimi.example",
        ANTHROPIC_AUTH_TOKEN: "sk-kimi",
      },
    },
  });
  assert.equal(switched.env.CLAUDE_CODE_AUTO_MODE_SERVER, "0");
  assert.equal(switched.env.ANTHROPIC_BASE_URL, "https://gw.example");

  // Switching back to a row without it removes the untouched value.
  const back = targets.projectClaude({
    prev: gateway,
    target: { settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: "sk-official" } } },
    live: {
      env: {
        ANTHROPIC_BASE_URL: "https://gw.example",
        ANTHROPIC_AUTH_TOKEN: "sk-gw",
        CLAUDE_CODE_AUTO_MODE_SERVER: "0",
      },
    },
  });
  assert.equal(back.env.CLAUDE_CODE_AUTO_MODE_SERVER, undefined);
  assert.equal(back.env.ANTHROPIC_AUTH_TOKEN, "sk-official");
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

  // cc-switch's current projection: the row's key rides into the route table
  // as experimental_bearer_token (Codex 0.149+ ignores auth.json keys for
  // custom providers), and requires_openai_auth is recomputed — with no login
  // left on disk it is written false so Codex doesn't sit at the login screen.
  const withKey = {
    category: "custom",
    settingsConfig: {
      auth: { OPENAI_API_KEY: "sk-relay" },
      config: {
        model: "gpt-5.2",
        model_provider: "custom",
        model_providers: {
          custom: { name: "New", base_url: "https://new.example.com/v1", wire_api: "responses", requires_openai_auth: true },
        },
      },
    },
  };
  const outKey = targets.projectCodex({ prev, target: withKey, liveToml, liveAuth: {} });
  assert.match(outKey.configToml, /experimental_bearer_token = "sk-relay"/);
  assert.match(outKey.configToml, /requires_openai_auth = false/);
  assert.equal(outKey.auth.action, "keep", "the row key never lands in auth.json");

  // A table that carries its own credentials (env_key / Authorization header)
  // gets no injected key; headers routes also drop requires_openai_auth.
  const withEnvKey = {
    category: "custom",
    settingsConfig: {
      auth: { OPENAI_API_KEY: "sk-relay" },
      config: {
        model_provider: "custom",
        model_providers: { custom: { name: "New", base_url: "https://new.example.com/v1", env_key: "RELAY_KEY" } },
      },
    },
  };
  const outEnvKey = targets.projectCodex({ prev, target: withEnvKey, liveToml, liveAuth: {} });
  assert.doesNotMatch(outEnvKey.configToml, /experimental_bearer_token/);
  assert.match(outEnvKey.configToml, /env_key = "RELAY_KEY"/);
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

  // A third-party row's key never reaches auth.json (cc-switch's current
  // projection writes it into config.toml's route table instead).
  const rowWithKey = targets.resolveCodexAuth({
    prev: null,
    target: { category: "custom", settingsConfig: { auth: { OPENAI_API_KEY: "sk-z" }, config: {} } },
    liveAuth: {},
    stash: null,
  });
  assert.equal(rowWithKey.action, "keep");

  // A live login is stashed on ANY third-party switch, not only when leaving
  // the official card.
  const relayAfterRelay = targets.resolveCodexAuth({ prev: relay, target: relay, liveAuth: chatgptLogin, stash: null });
  assert.equal(relayAfterRelay.action, "stash");
  assert.deepEqual(relayAfterRelay.stashContent, chatgptLogin);

  // auth.json holding only OPENAI_API_KEY is stale third-party residue from
  // the old projection: cleared, but never stashed as if it were a login.
  const residue = targets.resolveCodexAuth({ prev: relay, target: relay, liveAuth: { OPENAI_API_KEY: "sk-old" }, stash: null });
  assert.equal(residue.action, "write");
  assert.deepEqual(residue.content, {});

  // Third-party -> third-party with a clean auth.json: untouched.
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

  // Status on a fresh machine (claude/codex/gemini + the six additive apps
  // opencode/openclaw/mcode/hermes/pi/grokbuild — see additive.js APP_SPECS).
  const status0 = await call(handler, { url: `${prefix}/status` });
  assert.equal(status0.status, 200);
  assert.equal(status0.body.ok, true);
  assert.equal(status0.body.apps.length, 9);
  const claude0 = status0.body.apps.find((app) => app.app === "claude");
  assert.equal(claude0.current, null);
  assert.equal(claude0.files[0].path, path.join(tmpHome, ".claude", "settings.json"));

  // Presets list.
  const presets = await call(handler, { url: `${prefix}/presets?app=codex` });
  assert.ok(presets.body.presets.some((p) => p.group === "official"));

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

test("provider-switch api: codex switch injects the row key into the route table, not auth.json", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";

  const relay = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "codex",
      name: "Relay Key",
      category: "custom",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "sk-e2e" },
        config: { model: "gpt-5.2", model_provider: "custom", model_providers: { custom: { name: "R", base_url: "https://rk.example.com/v1" } } },
      },
    }),
  });

  const codexDir = path.join(tmpHome, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), 'model = "gpt-5"\n');
  // Stale residue from the old auth.json projection must be cleared, not
  // carried into the new provider's live auth.
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-old" }));

  const switched = await call(handler, {
    method: "POST",
    url: `${prefix}/switch`,
    body: JSON.stringify({ app: "codex", id: relay.body.provider.id }),
  });
  assert.equal(switched.status, 200);
  const configToml = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
  assert.match(configToml, /experimental_bearer_token = "sk-e2e"/);
  assert.match(configToml, /requires_openai_auth = false/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), {});
});

// ---------------------------------------------------------------------------
// cc-switch interaction parity: editor view / import-live / reorder / apply
// ---------------------------------------------------------------------------

test("provider-switch editor-view: the full post-switch projection (floor from row, rest from live)", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";

  const created = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "claude",
      name: "Relay",
      category: "custom",
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://a.example.com", ANTHROPIC_AUTH_TOKEN: "sk-a" } },
    }),
  });
  await call(handler, {
    method: "POST",
    url: `${prefix}/switch`,
    body: JSON.stringify({ app: "claude", id: created.body.provider.id }),
  });

  // Hand-edit the live file after the switch: a floor key (row-owned) and a
  // user-owned env var plus top-level hooks (live-owned).
  const livePath = path.join(tmpHome, ".claude", "settings.json");
  const live = JSON.parse(fs.readFileSync(livePath, "utf8"));
  live.env.ANTHROPIC_BASE_URL = "https://hand-edited.example.com";
  live.env.MY_OWN_VAR = "keep-me";
  live.hooks = { SessionStart: "echo hi" };
  fs.writeFileSync(livePath, JSON.stringify(live, null, 2) + "\n");

  const view = await call(handler, {
    method: "POST",
    url: `${prefix}/editor-view`,
    body: JSON.stringify({ app: "claude", id: created.body.provider.id }),
  });
  assert.equal(view.body.isCurrent, true);
  // Floor keys come from the row (the row owns them), user keys from live.
  assert.equal(view.body.settings.env.ANTHROPIC_BASE_URL, "https://a.example.com");
  assert.equal(view.body.settings.env.ANTHROPIC_AUTH_TOKEN, "sk-a");
  assert.equal(view.body.settings.env.MY_OWN_VAR, "keep-me");
  assert.deepEqual(view.body.settings.hooks, { SessionStart: "echo hi" });

  // Editing a non-current provider shows the full file after switching to
  // it: its floor keys replace the current provider's, user keys stay.
  const other = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "claude",
      name: "Other",
      category: "custom",
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://x.example.com" } },
    }),
  });
  const viewOther = await call(handler, {
    method: "POST",
    url: `${prefix}/editor-view`,
    body: JSON.stringify({ app: "claude", id: other.body.provider.id }),
  });
  assert.equal(viewOther.body.isCurrent, false);
  assert.equal(viewOther.body.settings.env.ANTHROPIC_BASE_URL, "https://x.example.com");
  assert.equal(viewOther.body.settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(viewOther.body.settings.env.MY_OWN_VAR, "keep-me");
  assert.deepEqual(viewOther.body.settings.hooks, { SessionStart: "echo hi" });
});

test("provider-switch editor save: floor keys go to the row, other edits go to live", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";

  const created = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "claude",
      name: "Relay",
      category: "custom",
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://a.example.com", ANTHROPIC_AUTH_TOKEN: "sk-a" } },
    }),
  });
  const relayId = created.body.provider.id;
  await call(handler, { method: "POST", url: `${prefix}/switch`, body: JSON.stringify({ app: "claude", id: relayId }) });

  const livePath = path.join(tmpHome, ".claude", "settings.json");
  const liveText = fs.readFileSync(livePath, "utf8");
  const base = JSON.parse(liveText); // what the editor view showed

  // User edits the full config: floor endpoint, a new global env flag, and
  // a hooks change — while editing a NON-current provider.
  const other = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "claude",
      name: "Other",
      category: "custom",
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://x.example.com" } },
    }),
  });
  const edited = JSON.parse(JSON.stringify(base));
  edited.env.ANTHROPIC_BASE_URL = "https://x.example.com";
  edited.env.MY_CUSTOM_FLAG = "1";
  edited.hooks = { SessionStart: "echo edited" };

  const saved = await call(handler, {
    method: "PUT",
    url: `${prefix}/providers/${other.body.provider.id}`,
    body: JSON.stringify({
      app: "claude",
      name: "Other",
      category: "custom",
      settingsConfig: edited,
      editor: { base },
    }),
  });
  assert.equal(saved.status, 200);

  // The row keeps only floor/exclusive keys.
  const state = await call(handler, { url: `${prefix}/providers?app=claude` });
  const row = state.body.providers.find((p) => p.id === other.body.provider.id);
  assert.deepEqual(Object.keys(row.settingsConfig), ["env"]);
  assert.equal(row.settingsConfig.env.ANTHROPIC_BASE_URL, "https://x.example.com");

  // Global edits were written into the live file; the current provider's
  // floor keys are untouched (the row change is not applied to live).
  const liveNow = JSON.parse(fs.readFileSync(livePath, "utf8"));
  assert.equal(liveNow.env.MY_CUSTOM_FLAG, "1");
  assert.deepEqual(liveNow.hooks, { SessionStart: "echo edited" });
  assert.equal(liveNow.env.ANTHROPIC_BASE_URL, "https://a.example.com");
  assert.equal(liveNow.env.ANTHROPIC_AUTH_TOKEN, "sk-a");

  // Saving the current provider applies its floor keys to live in one save.
  const currentEdited = JSON.parse(JSON.stringify(liveNow));
  currentEdited.env.ANTHROPIC_BASE_URL = "https://a2.example.com";
  const currentSave = await call(handler, {
    method: "PUT",
    url: `${prefix}/providers/${relayId}`,
    body: JSON.stringify({
      app: "claude",
      name: "Relay",
      category: "custom",
      settingsConfig: currentEdited,
      editor: { base: liveNow },
    }),
  });
  assert.equal(currentSave.status, 200);
  assert.ok(currentSave.body.applied && currentSave.body.applied.wrote.length > 0, "current provider save applied");
  const liveAfter = JSON.parse(fs.readFileSync(livePath, "utf8"));
  assert.equal(liveAfter.env.ANTHROPIC_BASE_URL, "https://a2.example.com");
  assert.equal(liveAfter.env.MY_CUSTOM_FLAG, "1");
  assert.deepEqual(liveAfter.hooks, { SessionStart: "echo edited" });
});

test("provider-switch editor save: three-way conflict refuse / keepTheirs / keepMine", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";

  const livePath = path.join(tmpHome, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(livePath), { recursive: true });
  fs.writeFileSync(livePath, `${JSON.stringify({ env: { MY_FLAG: "original" } }, null, 2)}\n`);
  const base = JSON.parse(fs.readFileSync(livePath, "utf8"));

  const created = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "claude",
      name: "Relay",
      category: "custom",
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://a.example.com" } },
    }),
  });

  // Another program changed the live value after the editor opened.
  const edited = JSON.parse(JSON.stringify(base));
  edited.env.MY_FLAG = "from-editor";

  fs.writeFileSync(livePath, `${JSON.stringify({ env: { MY_FLAG: "changed-elsewhere" } }, null, 2)}\n`);

  // Refuse (default): 409 with the conflicting key paths.
  const refused = await call(handler, {
    method: "PUT",
    url: `${prefix}/providers/${created.body.provider.id}`,
    body: JSON.stringify({
      app: "claude",
      name: "Relay",
      category: "custom",
      settingsConfig: edited,
      editor: { base },
    }),
  });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body.conflicts, ["env.MY_FLAG"]);
  assert.equal(JSON.parse(fs.readFileSync(livePath, "utf8")).env.MY_FLAG, "changed-elsewhere");

  // keepTheirs: the conflicting key keeps the external value.
  await call(handler, {
    method: "PUT",
    url: `${prefix}/providers/${created.body.provider.id}`,
    body: JSON.stringify({
      app: "claude",
      name: "Relay",
      category: "custom",
      settingsConfig: edited,
      editor: { base, onConflict: "keepTheirs" },
    }),
  });
  assert.equal(JSON.parse(fs.readFileSync(livePath, "utf8")).env.MY_FLAG, "changed-elsewhere");

  // keepMine: the editor's value wins.
  await call(handler, {
    method: "PUT",
    url: `${prefix}/providers/${created.body.provider.id}`,
    body: JSON.stringify({
      app: "claude",
      name: "Relay",
      category: "custom",
      settingsConfig: edited,
      editor: { base, onConflict: "keepMine" },
    }),
  });
  assert.equal(JSON.parse(fs.readFileSync(livePath, "utf8")).env.MY_FLAG, "from-editor");
});

test("provider-switch update on the current provider re-applies the projection", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";

  const created = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "claude",
      name: "Relay",
      category: "custom",
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://a.example.com", ANTHROPIC_AUTH_TOKEN: "sk-a" } },
    }),
  });
  await call(handler, {
    method: "POST",
    url: `${prefix}/switch`,
    body: JSON.stringify({ app: "claude", id: created.body.provider.id }),
  });

  const updated = await call(handler, {
    method: "PUT",
    url: `${prefix}/providers/${created.body.provider.id}`,
    body: JSON.stringify({
      app: "claude",
      name: "Relay 2",
      websiteUrl: "https://relay.example.com",
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://b.example.com", ANTHROPIC_AUTH_TOKEN: "sk-b" } },
    }),
  });
  assert.equal(updated.status, 200);
  assert.ok(updated.body.applied, "editing the current provider re-applies it");
  assert.deepEqual(updated.body.applied.wrote, [path.join(tmpHome, ".claude", "settings.json")]);

  const live = JSON.parse(fs.readFileSync(path.join(tmpHome, ".claude", "settings.json"), "utf8"));
  assert.equal(live.env.ANTHROPIC_BASE_URL, "https://b.example.com");
  assert.equal(updated.body.provider.websiteUrl, "https://relay.example.com");

  // websiteUrl validation
  await assert.rejects(async () => {
    const bad = await call(handler, {
      method: "PUT",
      url: `${prefix}/providers/${created.body.provider.id}`,
      body: JSON.stringify({ app: "claude", websiteUrl: "not a url" }),
    });
    if (bad.status !== 200) throw new Error(bad.body.error);
  });
});

test("provider-switch import-live creates a provider from the live key fields only", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";

  // Live claude settings with user keys the import must NOT absorb.
  const livePath = path.join(tmpHome, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(livePath), { recursive: true });
  fs.writeFileSync(
    livePath,
    JSON.stringify(
      {
        hooks: { Stop: [] },
        permissions: { allow: ["Bash"] },
        env: { ANTHROPIC_BASE_URL: "https://a.example.com", ANTHROPIC_AUTH_TOKEN: "sk-a", MY_KEY: "user" },
        model: "claude-sonnet-4-6",
      },
      null,
      2,
    ) + "\n",
  );

  const imported = await call(handler, {
    method: "POST",
    url: `${prefix}/providers/import-live`,
    body: JSON.stringify({ app: "claude" }),
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.provider.category, "custom");
  const config = imported.body.provider.settingsConfig;
  assert.equal(config.env.ANTHROPIC_BASE_URL, "https://a.example.com");
  assert.equal(config.env.ANTHROPIC_AUTH_TOKEN, "sk-a");
  assert.equal(config.env.MY_KEY, undefined, "user env keys are not absorbed");
  assert.equal(config.model, "claude-sonnet-4-6");
  assert.equal(config.hooks, undefined, "user-owned top-level keys are not absorbed");
});

test("provider-switch presets carry declarative formFields and reorder persists drag order", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";

  const presets = await call(handler, { url: `${prefix}/presets?app=codex` });
  const custom = presets.body.presets.find((preset) => preset.id === "codex_custom");
  assert.deepEqual(
    custom.formFields.map((field) => field.id),
    ["api_key", "base_url", "model"],
    "codex custom mirrors cc-switch's CodexFormFields: API key, endpoint, default model"
  );
  const official = presets.body.presets.find((preset) => preset.id === "codex_official");
  assert.deepEqual(official.formFields, [], "official login preset has no fields");

  const a = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({ app: "codex", name: "A", settingsConfig: { auth: null, config: {} } }),
  });
  const b = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({ app: "codex", name: "B", settingsConfig: { auth: null, config: {} } }),
  });
  const c = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({ app: "codex", name: "C", settingsConfig: { auth: null, config: {} } }),
  });

  const reordered = await call(handler, {
    method: "POST",
    url: `${prefix}/providers/reorder`,
    body: JSON.stringify({
      app: "codex",
      orderedIds: [c.body.provider.id, a.body.provider.id, b.body.provider.id],
    }),
  });
  assert.equal(reordered.status, 200);
  assert.deepEqual(
    reordered.body.providers.map((p) => p.name),
    ["C", "A", "B"],
  );
  assert.deepEqual(
    reordered.body.providers.map((p) => p.sortIndex),
    [0, 1, 2],
  );
});

// ---------------------------------------------------------------------------
// Endpoint speed test + model discovery (backend-proxied cc-switch features)
// ---------------------------------------------------------------------------

const http = require("node:http");

function startMockUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-5.2" }, { id: "gpt-5.2-codex" }] }));
        return;
      }
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }]));
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("provider-switch speed-test probes endpoints and fetch-models discovers lists", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";
  const upstream = await startMockUpstream();
  const port = upstream.address().port;
  try {
    // speed test: reachable + unreachable, latency reported for both
    const speed = await call(handler, {
      method: "POST",
      url: `${prefix}/speed-test`,
      body: JSON.stringify({
        urls: [`http://127.0.0.1:${port}/`, "http://127.0.0.1:9/", "not-a-url"],
        timeoutMs: 2000,
      }),
    });
    assert.equal(speed.status, 200);
    const results = speed.body.results;
    assert.equal(results.length, 2, "invalid urls are dropped");
    const reachable = results.find((row) => row.url === `http://127.0.0.1:${port}/`);
    assert.equal(reachable.ok, true);
    assert.ok(Number.isFinite(reachable.latencyMs));
    const dead = results.find((row) => row.url === "http://127.0.0.1:9/");
    assert.equal(dead.ok, false);

    // fetch models: OpenAI shape at /v1/models
    const openai = await call(handler, {
      method: "POST",
      url: `${prefix}/fetch-models`,
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "sk-test" }),
    });
    assert.deepEqual(openai.body.models, ["gpt-5.2", "gpt-5.2-codex"]);

    // fetch models: bare-array shape at /models fallback
    const bare = await call(handler, {
      method: "POST",
      url: `${prefix}/fetch-models`,
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v9` }),
    });
    assert.deepEqual(bare.body.models, ["deepseek-v4-pro", "deepseek-flash"]);

    // fetch models: explicit modelsUrl wins (cc-switch's DeepSeek override)
    const explicit = await call(handler, {
      method: "POST",
      url: `${prefix}/fetch-models`,
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${port}/anthropic`,
        modelsUrl: `http://127.0.0.1:${port}/models`,
      }),
    });
    assert.deepEqual(explicit.body.models, ["deepseek-v4-pro", "deepseek-flash"]);

    // fetch models: no model list anywhere -> error
    const empty = await call(handler, {
      method: "POST",
      url: `${prefix}/fetch-models`,
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:9" }),
    });
    assert.equal(empty.status, 400);
  } finally {
    upstream.close();
  }
});

test("provider-switch providers carry icon/iconColor/meta and sanitize them", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";

  const created = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "claude",
      name: "Kimi",
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic" } },
      icon: "moon",
      iconColor: "indigo",
      meta: {
        apiFormat: "anthropic",
        customUserAgent: "claude-cli/2.0",
        localProxyRequestOverrides: { headers: '{"X-Test":"1"}' },
      },
    }),
  });
  assert.equal(created.body.provider.icon, "moon");
  assert.equal(created.body.provider.iconColor, "indigo");
  assert.equal(created.body.provider.meta.customUserAgent, "claude-cli/2.0");

  // oversized meta rejected (limit raised to 256 KiB in the P2 round —
  // official template base_instructions alone are ~21 KiB)
  const bad = await call(handler, {
    method: "PUT",
    url: `${prefix}/providers/${created.body.provider.id}`,
    body: JSON.stringify({ app: "claude", meta: { blob: "x".repeat(300 * 1024) } }),
  });
  assert.equal(bad.status, 400);

  // meta round-trips through status
  const status = await call(handler, { url: `${prefix}/status` });
  const claude = status.body.apps.find((app) => app.app === "claude");
  const stored = claude.providers.find((p) => p.id === created.body.provider.id);
  assert.equal(stored.meta.apiFormat, "anthropic");
});

// ---------------------------------------------------------------------------
// Codex model catalog (model_catalog_json sidecar)
// ---------------------------------------------------------------------------

test("provider-switch codex catalog: build/parse round-trip and projection pointer", async () => {
  const catalog = require("../src/lib/provider-switch/catalog");
  const content = catalog.buildCodexCatalog([
    { model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", contextWindow: "1048576", reasoningLevels: ["low", "high", "max"], defaultReasoningLevel: "high" },
    { model: "", displayName: "skipped" },
  ]);
  const parsed = JSON.parse(content);
  assert.equal(parsed.models.length, 1);
  const entry = parsed.models[0];
  assert.equal(entry.slug, "deepseek-v4-pro");
  assert.equal(entry.display_name, "DeepSeek V4 Pro");
  assert.equal(entry.context_window, 1048576);
  assert.equal(entry.max_context_window, 1048576);
  assert.equal(entry.priority, 1000);
  assert.ok(entry.base_instructions, "base_instructions is required by Codex's parser");
  assert.deepEqual(
    entry.supported_reasoning_levels.map((level) => level.effort),
    ["low", "high", "max"],
  );
  assert.equal(entry.default_reasoning_level, "high");

  // Reverse parse back into meta rows.
  const rows = catalog.parseCodexCatalog(content);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "deepseek-v4-pro");
  assert.equal(rows[0].displayName, "DeepSeek V4 Pro");
  assert.deepEqual(rows[0].reasoningLevels, ["low", "high", "max"]);
  assert.equal(rows[0].defaultReasoningLevel, "high");

  // Projection: a provider with catalog rows gets the pointer key; the
  // generic residue logic removes it again when only the prev had it.
  const { projectCodex } = require("../src/lib/provider-switch/targets");
  const withCatalog = {
    id: "relay",
    category: "custom",
    settingsConfig: { auth: null, config: { model: "deepseek-v4-pro", model_provider: "custom", model_providers: { custom: { name: "R", base_url: "https://r/v1", wire_api: "responses" } } } },
    meta: { codexCatalogModels: [{ model: "deepseek-v4-pro" }] },
  };
  const projected = projectCodex({ prev: null, target: withCatalog, liveToml: "", liveAuth: {}, stash: null });
  assert.match(projected.configToml, /model_catalog_json = "aitool-model-catalog\.json"/);
  assert.equal(projected.catalog.action, "write");

  const empty = { id: "plain", category: "custom", settingsConfig: { auth: null, config: {} } };
  const cleared = projectCodex({ prev: withCatalog, target: empty, liveToml: projected.configToml, liveAuth: {}, stash: null });
  assert.doesNotMatch(cleared.configToml, /model_catalog_json/);
  assert.equal(cleared.catalog.action, "remove");

  // A hand-pointed foreign catalog is left alone.
  const foreign = projectCodex({
    prev: withCatalog,
    target: empty,
    liveToml: 'model_catalog_json = "my-own-models.json"\n',
    liveAuth: {},
    stash: null,
  });
  assert.match(foreign.configToml, /model_catalog_json = "my-own-models\.json"/);
});

test("provider-switch api: switch writes the catalog file, import reads it back", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";
  const codexDir = path.join(tmpHome, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "");

  const relay = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "codex",
      name: "Catalog Relay",
      category: "custom",
      settingsConfig: { auth: null, config: { model: "deepseek-v4-pro", model_provider: "custom", model_providers: { custom: { name: "R", base_url: "https://r/v1" } } } },
      meta: { codexCatalogModels: [{ model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", contextWindow: "1048576", reasoningLevels: ["high"], defaultReasoningLevel: "high" }] },
    }),
  });

  const switchRes = await call(handler, {
    method: "POST",
    url: `${prefix}/switch`,
    body: JSON.stringify({ app: "codex", id: relay.body.provider.id }),
  });
  assert.equal(switchRes.status, 200);
  const catalogPath = path.join(codexDir, "aitool-model-catalog.json");
  assert.ok(fs.existsSync(catalogPath), "catalog file written on switch");
  const written = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  assert.equal(written.models[0].slug, "deepseek-v4-pro");
  assert.match(fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"), /model_catalog_json = "aitool-model-catalog\.json"/);
  assert.ok(switchRes.body.wrote.includes(catalogPath), "wrote list includes the catalog file");

  // Import from live: rows move into meta, the pointer is dropped from config.
  const imported = await call(handler, {
    method: "POST",
    url: `${prefix}/providers/import-live`,
    body: JSON.stringify({ app: "codex", name: "Imported" }),
  });
  assert.equal(imported.status, 200);
  const storedMeta = imported.body.provider.meta;
  assert.ok(Array.isArray(storedMeta.codexCatalogModels) && storedMeta.codexCatalogModels.length === 1);
  assert.equal(storedMeta.codexCatalogModels[0].model, "deepseek-v4-pro");
  assert.ok(!("model_catalog_json" in imported.body.provider.settingsConfig.config));

  // Switching to a provider without rows removes our sidecar again.
  const plain = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({ app: "codex", name: "Plain", category: "custom", settingsConfig: { auth: null, config: {} } }),
  });
  await call(handler, { method: "POST", url: `${prefix}/switch`, body: JSON.stringify({ app: "codex", id: plain.body.provider.id }) });
  assert.ok(!fs.existsSync(catalogPath), "catalog file removed when the new provider has no rows");
  assert.doesNotMatch(fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"), /model_catalog_json = "aitool-model-catalog\.json"/);
});

test("provider-switch codex editor: view projects the full toml, save splits global table edits", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const { parse: tomlParse } = require("smol-toml");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";
  const codexDir = path.join(tmpHome, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  // A hand-maintained live config with a user-owned mcp server (arrays and
  // comments) and a user env table.
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    `# my codex config\nmodel = "gpt-5.2"\nmodel_provider = "custom"\n\n[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-fs"]  # fs server\n\n[notice]\nmodel = "gpt-5.2-mini"\n`,
  );

  const relay = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "codex",
      name: "Codex Relay",
      category: "custom",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "sk-codex" },
        config: { model_provider: "custom", model: "gpt-5.2", model_providers: { custom: { name: "R", base_url: "https://r/v1" } } },
      },
    }),
  });
  await call(handler, { method: "POST", url: `${prefix}/switch`, body: JSON.stringify({ app: "codex", id: relay.body.provider.id }) });

  // View: the full projected config.toml keeps the user tables + comments.
  const view = await call(handler, {
    method: "POST",
    url: `${prefix}/editor-view`,
    body: JSON.stringify({ app: "codex", id: relay.body.provider.id }),
  });
  assert.equal(view.status, 200);
  assert.match(view.body.configToml, /# my codex config/);
  assert.match(view.body.configToml, /\[mcp_servers\.fs\]/);
  assert.match(view.body.configToml, /args = \["-y", "@modelcontextprotocol\/server-fs"\]/);
  assert.match(view.body.configToml, /experimental_bearer_token = "sk-codex"/);
  assert.deepEqual(view.body.authJson, {});

  const base = { auth: view.body.authJson, config: tomlParse(view.body.configToml) };

  // Edit: change the model (floor → row), add a second mcp server and edit
  // the [notice] model (global → live).
  const editedConfig = JSON.parse(JSON.stringify(base.config));
  editedConfig.model = "gpt-5.3";
  editedConfig.mcp_servers.git = { command: "uvx", args: ["mcp-server-git"] };
  editedConfig.notice.model = "gpt-5.2-nano";
  const saved = await call(handler, {
    method: "PUT",
    url: `${prefix}/providers/${relay.body.provider.id}`,
    body: JSON.stringify({
      app: "codex",
      name: "Codex Relay",
      category: "custom",
      settingsConfig: { auth: { OPENAI_API_KEY: "sk-codex" }, config: editedConfig },
      editor: { base },
    }),
  });
  assert.equal(saved.status, 200);
  assert.ok(saved.body.applied && saved.body.applied.wrote.some((p) => p.endsWith("config.toml")));

  const liveText = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
  assert.match(liveText, /# my codex config/);
  assert.match(liveText, /\[mcp_servers\.git\]/);
  assert.match(liveText, /args = \["mcp-server-git"\]/);
  assert.match(liveText, /model = "gpt-5\.3"/);
  assert.match(liveText, /\[notice\]/);
  const liveParsed = tomlParse(liveText);
  assert.equal(liveParsed.notice.model, "gpt-5.2-nano");
  assert.equal(liveParsed.mcp_servers.fs.args[1], "@modelcontextprotocol/server-fs");

  // The row keeps floors + the route table without the injected auth fields
  // (the key lives in row.auth; requires_openai_auth is recomputed on switch).
  const state = await call(handler, { url: `${prefix}/providers?app=codex` });
  const row = state.body.providers.find((p) => p.id === relay.body.provider.id);
  assert.equal(row.settingsConfig.config.model, "gpt-5.3");
  assert.equal(row.settingsConfig.auth.OPENAI_API_KEY, "sk-codex");
  assert.ok(!("requires_openai_auth" in row.settingsConfig.config.model_providers.custom));
  assert.ok(!("experimental_bearer_token" in row.settingsConfig.config.model_providers.custom));
  assert.ok(!("mcp_servers" in row.settingsConfig.config));
});

test("provider-switch gemini editor: view projects the full .env, save splits global vars", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const prefix = "/api/provider-switch";
  const geminiDir = path.join(tmpHome, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(path.join(geminiDir, ".env"), "# gemini env\nGEMINI_API_KEY=old-key\nGEMINI_MODEL=gemini-2.5-pro\nMY_OWN_VAR=keep\n");

  const relay = await call(handler, {
    method: "POST",
    url: `${prefix}/providers`,
    body: JSON.stringify({
      app: "gemini",
      name: "Gemini Relay",
      category: "custom",
      settingsConfig: { env: { GEMINI_API_KEY: "new-key", GEMINI_MODEL: "gemini-3-pro" } },
    }),
  });
  await call(handler, { method: "POST", url: `${prefix}/switch`, body: JSON.stringify({ app: "gemini", id: relay.body.provider.id }) });

  const view = await call(handler, {
    method: "POST",
    url: `${prefix}/editor-view`,
    body: JSON.stringify({ app: "gemini", id: relay.body.provider.id }),
  });
  assert.match(view.body.envText, /MY_OWN_VAR=keep/);
  assert.match(view.body.envText, /GEMINI_API_KEY=new-key/);

  // Parse the view text like the dialog does, edit, save with the base.
  const parseEnv = (text) => {
    const env = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
    return env;
  };
  const base = { env: parseEnv(view.body.envText) };
  const edited = { env: { ...base.env, MY_OWN_VAR: "edited", GEMINI_API_KEY: "newer-key" } };
  const saved = await call(handler, {
    method: "PUT",
    url: `${prefix}/providers/${relay.body.provider.id}`,
    body: JSON.stringify({ app: "gemini", name: "Gemini Relay", category: "custom", settingsConfig: edited, editor: { base } }),
  });
  assert.equal(saved.status, 200);

  const liveText = fs.readFileSync(path.join(geminiDir, ".env"), "utf8");
  assert.match(liveText, /MY_OWN_VAR=edited/);
  // The provider IS current — the floor key change rides the projection.
  assert.equal(parseEnv(liveText).GEMINI_API_KEY, "newer-key");
  assert.equal(parseEnv(liveText).GEMINI_MODEL, "gemini-3-pro");

  const state = await call(handler, { url: `${prefix}/providers?app=gemini` });
  const row = state.body.providers.find((p) => p.id === relay.body.provider.id);
  assert.deepEqual(row.settingsConfig.env, { GEMINI_API_KEY: "newer-key", GEMINI_MODEL: "gemini-3-pro" });
  assert.ok(!("MY_OWN_VAR" in row.settingsConfig.env));
});

// ---------------------------------------------------------------------------
// Codex catalog: official GPT entry mirroring (cc-switch c6255cc port)
// ---------------------------------------------------------------------------

test("provider-switch codex catalog: official models match like Codex", () => {
  const catalog = require("../src/lib/provider-switch/catalog");
  const officialRows = ["gpt-6", "gpt-6-sol", "gpt-5.5"].map((slug) => ({
    slug,
    base_instructions: `${slug} prompt`,
  }));
  const found = (model) => {
    const hit = catalog.findCodexOfficialModel(model, officialRows);
    return hit ? hit.slug : null;
  };
  // longest case-sensitive prefix
  assert.equal(found("gpt-6-sol"), "gpt-6-sol");
  assert.equal(found("gpt-6-sol-high"), "gpt-6-sol");
  assert.equal(found("gpt-6-luna"), "gpt-6");
  // one simple namespace segment may be stripped
  assert.equal(found("openai/gpt-5.5"), "gpt-5.5");
  assert.equal(found("my_relay-1/gpt-6-sol"), "gpt-6-sol");
  assert.equal(found("a/b/gpt-5.5"), null);
  assert.equal(found("bad ns/gpt-5.5"), null);
  assert.equal(found("/gpt-5.5"), null);
  // case-sensitive, no partial-slug hits
  assert.equal(found("GPT-5.5"), null);
  assert.equal(found("gpt-5"), null);
  assert.equal(found("glm-5"), null);
});

test("provider-switch codex catalog: GPT rows mirror the official entry", () => {
  const catalog = require("../src/lib/provider-switch/catalog");
  const officialRows = [
    {
      slug: "gpt-6-sol",
      display_name: "GPT-6 SOL",
      base_instructions: "gpt-6-sol harness prompt",
      model_messages: { instructions_template: "gpt-6-sol harness prompt" },
      apply_patch_tool_type: "freeform",
      use_responses_lite: true,
      visibility: "hide",
      service_tiers: [{ id: "priority", name: "Fast" }],
      additional_speed_tiers: ["fast"],
      upgrade: { model: "gpt-next" },
      context_window: 272000,
      max_context_window: 872000,
      supports_image_detail_original: true,
      input_modalities: ["text", "image"],
      supports_parallel_tool_calls: false,
      supported_reasoning_levels: [
        { effort: "low", description: "l" },
        { effort: "xhigh", description: "x" },
      ],
      default_reasoning_level: "low",
    },
  ];
  const content = catalog.buildCodexCatalog(
    [
      // the row's own overrides must NOT apply to an official hit
      { model: "gpt-6-sol", displayName: "My Relay Name", contextWindow: "128000", reasoningLevels: ["none"] },
      { model: "gpt-6-sol-high", displayName: "Prefixed" },
      { model: "glm-5", displayName: "Template Row" },
    ],
    officialRows,
  );
  const models = JSON.parse(content).models;
  assert.equal(models.length, 3);

  const direct = models[0];
  assert.equal(direct.slug, "gpt-6-sol");
  // official values win: no user display name, no overridden window/levels
  assert.equal(direct.display_name, "GPT-6 SOL");
  assert.equal(direct.base_instructions, "gpt-6-sol harness prompt");
  assert.equal(direct.context_window, 272000);
  assert.deepEqual(
    direct.supported_reasoning_levels.map((level) => level.effort),
    ["low", "xhigh"],
  );
  assert.equal(direct.default_reasoning_level, "low");
  // account/backend-owned fields reset
  assert.equal(direct.use_responses_lite, false);
  assert.deepEqual(direct.service_tiers, []);
  assert.deepEqual(direct.additional_speed_tiers, []);
  assert.equal(direct.availability_nux, null);
  assert.equal(direct.upgrade, null);
  assert.equal(direct.visibility, "list");

  // a prefixed hit keeps its own name (no stealing the official display name)
  assert.equal(models[1].slug, "gpt-6-sol-high");
  assert.equal(models[1].display_name, "gpt-6-sol-high");

  // a non-official row still comes from the neutral template
  assert.equal(models[2].slug, "glm-5");
  assert.equal(models[2].display_name, "Template Row");
  assert.match(models[2].base_instructions, /You are Codex/);
});

test("provider-switch codex catalog: pure mirrors collapse on import, edited clones stay", () => {
  const catalog = require("../src/lib/provider-switch/catalog");
  const officialRows = [
    {
      slug: "gpt-6-sol",
      display_name: "GPT-6 SOL",
      base_instructions: "gpt-6-sol harness prompt",
      model_messages: { instructions_template: "gpt-6-sol harness prompt" },
      context_window: 272000,
      input_modalities: ["text", "image"],
      supports_parallel_tool_calls: false,
    },
  ];
  const mirror = catalog.buildCodexCatalog([{ model: "gpt-6-sol" }], officialRows);
  const edited = JSON.stringify({
    models: [
      // same official row but the user renamed it: not a pure mirror anymore
      {
        slug: "gpt-6-sol",
        display_name: "My Relay Name",
        base_instructions: "gpt-6-sol harness prompt",
        context_window: 272000,
        input_modalities: ["text", "image"],
        supports_parallel_tool_calls: false,
      },
    ],
  });
  const rows = catalog.parseCodexCatalog(mirror, officialRows);
  assert.deepEqual(rows, [{ model: "gpt-6-sol" }]);
  const editedRows = catalog.parseCodexCatalog(edited, officialRows);
  assert.equal(editedRows.length, 1);
  assert.equal(editedRows[0].model, "gpt-6-sol");
  assert.equal(editedRows[0].displayName, "My Relay Name");
});
