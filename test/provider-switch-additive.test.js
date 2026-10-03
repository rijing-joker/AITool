"use strict";

// Tests for the provider-switch additive layer (cc-switch's additive-mode
// port): the generic projection/extract/editor-save engine for opencode,
// openclaw and MiniMax Code (mcode), the per-app presets, and the visible
// apps setting exposed through /api/provider-switch/*.

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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-psw-additive-"));
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

const additive = require("../src/lib/provider-switch/additive");
const store = require("../src/lib/provider-switch/store");
const editor = require("../src/lib/provider-switch/editor");
const paths = require("../src/lib/provider-switch/paths");
const presets = require("../src/lib/provider-switch/presets");
const { handleProviderSwitchApiRequest, switchProvider } = require("../src/lib/provider-switch/api");

async function saveViaApi(app, edited, base, slotKey, id, { onConflict, expectedStatus = 200 } = {}) {
  const url = `/api/provider-switch/providers${id ? `/${id}` : ""}`;
  const req = Readable.from([Buffer.from(JSON.stringify({
    app, name: "Custom relay", settingsConfig: edited, editor: { base, slotKey, onConflict },
  }))]);
  req.method = id ? "PUT" : "POST";
  req.headers = { host: "localhost" };
  const res = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  await handleProviderSwitchApiRequest(req, res, new URL(url, "http://localhost"), {
    isAuthorizedLocalMutation: () => true,
  });
  assert.equal(res.status, expectedStatus, JSON.stringify(res.body));
  return res.body;
}

// ---------------------------------------------------------------------------
// Store: wrapper sanitization
// ---------------------------------------------------------------------------

test("additive store: wrapper shape, slot key from name, bad slot key rejected", async () => {
  const created = await store.createProvider("opencode", {
    name: "My Relay!",
    settingsConfig: { provider: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://x", apiKey: "k" } } },
  });
  assert.equal(created.settingsConfig.slotKey, "my-relay");
  assert.equal(created.settingsConfig.modelId, "");
  assert.equal(created.settingsConfig.provider.options.apiKey, "k");

  await assert.rejects(
    () =>
      store.createProvider("opencode", {
        name: "Bad",
        settingsConfig: { provider: { options: {} }, slotKey: "NOT VALID!" },
      }),
    /slotKey/,
  );
  await assert.rejects(
    () => store.createProvider("opencode", { name: "Bad", settingsConfig: { slotKey: "ok" } }),
    /settingsConfig.provider/,
  );
  // The switch-mode shape must not leak into additive apps.
  await assert.rejects(
    () => store.createProvider("opencode", { name: "Bad", settingsConfig: { env: {} } }),
    /settingsConfig.provider/,
  );
});

// ---------------------------------------------------------------------------
// Projection: switch writes the slot + pointer, preserves the user's own
// entries, and clears the previous provider's residue
// ---------------------------------------------------------------------------

test("additive opencode projection: residue removal, pointer handling, user keys preserved", () => {
  const prev = {
    settingsConfig: {
      slotKey: "kimi",
      modelId: "kimi/kimi-k3",
      provider: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://m", apiKey: "a" }, models: {} },
    },
  };
  const target = {
    settingsConfig: {
      slotKey: "deepseek",
      modelId: "deepseek/deepseek-chat",
      provider: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://d", apiKey: "b" }, models: {} },
    },
  };
  const live = {
    theme: "dark",
    model: "kimi/kimi-k3",
    mcp: { fs: { type: "local" } },
    provider: {
      kimi: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://m", apiKey: "a" }, models: {} },
      mine: { npm: "@ai-sdk/anthropic" },
    },
  };

  const next = additive.projectAdditive("opencode", { prev, target, live });
  assert.equal(next.theme, "dark");
  assert.deepEqual(next.mcp, { fs: { type: "local" } });
  // The previous provider's (untouched) entry is residue and disappears.
  assert.equal(next.provider.kimi, undefined);
  // The user's own entry survives; the target's entry lands.
  assert.deepEqual(next.provider.mine, { npm: "@ai-sdk/anthropic" });
  assert.equal(next.provider.deepseek.options.baseURL, "https://d");
  assert.equal(next.model, "deepseek/deepseek-chat");
  // Pure: the input document is not mutated.
  assert.ok(live.provider.kimi);

  // A hand-edited previous entry is NOT residue (value changed) — kept.
  const touched = JSON.parse(JSON.stringify(live));
  touched.provider.kimi.options.apiKey = "changed";
  const kept = additive.projectAdditive("opencode", { prev, target, live: touched });
  assert.equal(kept.provider.kimi.options.apiKey, "changed");
  assert.equal(kept.provider.deepseek.options.baseURL, "https://d");
});

test("additive openclaw projection: nested container and default model", () => {
  const target = {
    settingsConfig: {
      slotKey: "kimi",
      modelId: "kimi/kimi-k2.7-code",
      provider: { baseUrl: "https://m", apiKey: "a", api: "openai-completions", models: [] },
    },
  };
  const next = additive.projectAdditive("openclaw", { prev: null, target, live: {} });
  assert.deepEqual(next.models.providers.kimi, target.settingsConfig.provider);
  assert.equal(next.agents.defaults.model.primary, "kimi/kimi-k2.7-code");

  // Model refs are stored verbatim — ids may contain slashes (ModelScope).
  const ms = {
    settingsConfig: {
      slotKey: "modelscope",
      modelId: "modelscope/ZhipuAI/GLM-5.2",
      provider: { baseUrl: "https://ms", apiKey: "", api: "openai-completions", models: [] },
    },
  };
  const nextMs = additive.projectAdditive("openclaw", { prev: target, target: ms, live: next });
  assert.equal(nextMs.agents.defaults.model.primary, "modelscope/ZhipuAI/GLM-5.2");
  assert.equal(nextMs.models.providers.kimi, undefined);
});

test("additive mcode projection: YAML document round-trip, no model pointer", () => {
  const target = {
    settingsConfig: {
      slotKey: "minimax",
      provider: { name: "MiniMax", kind: "custom", enabled: true, api: "anthropic-messages", options: { baseURL: "https://m", apiKey: "k" }, models: {} },
    },
  };
  const liveText = "# header comment\ncustom_provider:\n  mine:\n    kind: custom\n";
  const live = additive.parseLive("mcode", liveText);
  const next = additive.projectAdditive("mcode", { prev: null, target, live });
  assert.equal(next.custom_provider.minimax.api, "anthropic-messages");
  const text = additive.serializeLive("mcode", next);
  const reparsed = additive.parseLive("mcode", text);
  assert.equal(reparsed.custom_provider.minimax.options.baseURL, "https://m");
});

// ---------------------------------------------------------------------------
// Import from live
// ---------------------------------------------------------------------------

test("additive extract: pointer-referenced entry, single-entry fallback, errors", () => {
  const wrapper = additive.extractAdditive("opencode", {
    model: "other/m1",
    provider: { other: { npm: "n", options: { baseURL: "https://o", apiKey: "k" }, models: { m1: {} } } },
  });
  assert.equal(wrapper.slotKey, "other");
  assert.equal(wrapper.modelId, "other/m1");
  assert.equal(wrapper.provider.options.apiKey, "k");

  const single = additive.extractAdditive("mcode", { custom_provider: { only: { kind: "custom" } } });
  assert.equal(single.slotKey, "only");

  assert.throws(() => additive.extractAdditive("opencode", { provider: { a: {}, b: {} } }), /multiple providers/i);
  assert.throws(() => additive.extractAdditive("opencode", {}), /No provider entries/);
});

// ---------------------------------------------------------------------------
// Editor view + save split
// ---------------------------------------------------------------------------

test("additive editor view and planSave: row keys split from global changes", async () => {
  fs.mkdirSync(path.dirname(paths.targetFile("opencode", "config").path), { recursive: true });
  fs.writeFileSync(
    paths.targetFile("opencode", "config").path,
    JSON.stringify({ theme: "dark", provider: { mine: { npm: "@ai-sdk/anthropic" } } }, null, 2),
  );

  const row = await store.createProvider("opencode", {
    name: "Kimi",
    settingsConfig: {
      slotKey: "kimi",
      modelId: "kimi/kimi-k3",
      provider: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://m", apiKey: "a" }, models: { "kimi-k3": {} } },
    },
  });

  const view = await editor.buildEditorView("opencode", { settingsConfig: row.settingsConfig, id: row.id });
  assert.equal(view.slotKey, "kimi");
  const base = additive.parseLive("opencode", view.configText);
  assert.equal(base.model, "kimi/kimi-k3");
  assert.ok(base.provider.mine);

  // Simulate the dialog round-trip: the user edits the key, the theme, and
  // adds a foreign provider entry.
  const edited = JSON.parse(JSON.stringify(base));
  edited.provider.kimi.options.apiKey = "a2";
  edited.provider.newone = { npm: "n" };
  edited.theme = "light";
  edited.model = "kimi/kimi-k2.7-code";
  const plan = editor.planSave("opencode", row.settingsConfig, edited, base, view.slotKey);
  assert.equal(plan.rowSettings.slotKey, "kimi");
  assert.equal(plan.rowSettings.provider.options.apiKey, "a2");
  assert.equal(plan.rowSettings.modelId, "kimi/kimi-k2.7-code");
  // Global changes only: the slot entry and the pointer are row-owned.
  assert.deepEqual(
    plan.changes.map((change) => change.path.join(".")).sort(),
    ["provider.newone", "theme"],
  );

  // Removing the row's own entry in the editor is refused.
  const withoutSlot = JSON.parse(JSON.stringify(base));
  delete withoutSlot.provider.kimi;
  assert.throws(() => editor.planSave("opencode", row.settingsConfig, withoutSlot, base, view.slotKey), /cannot be removed/);
});

test("additive editor conflicts: three-way check against the live file", async () => {
  fs.mkdirSync(path.dirname(paths.targetFile("mcode", "config").path), { recursive: true });
  fs.writeFileSync(paths.targetFile("mcode", "config").path, "top: v1\n");

  const changes = [
    { path: ["top"], before: "v1", after: "v2" }, // live still v1 → no conflict
    { path: ["other"], before: "x", after: "y" }, // live has z → conflict
  ];
  fs.appendFileSync(paths.targetFile("mcode", "config").path, "other: z\n");
  const lives = { config: { exists: true, content: fs.readFileSync(paths.targetFile("mcode", "config").path, "utf8") } };
  const marked = editor.resolveConflicts("mcode", changes, lives);
  assert.equal(marked[0].conflict, false);
  assert.equal(marked[1].conflict, true);

  const patched = editor.applyChanges("mcode", lives, changes);
  const doc = additive.parseLive("mcode", patched.config.content);
  assert.equal(doc.top, "v2");
  assert.equal(doc.other, "y");
});

for (const app of ["opencode", "openclaw"]) {
  test(`additive ${app}: first model is saved without changing live config until switch`, async () => {
    const preset = presets.listPresets(app).find((item) => item.group === "custom");
    const view = await editor.buildEditorView(app, { settingsConfig: preset.settingsConfig });
    const base = additive.parseLive(app, view.configText);
    const edited = structuredClone(base);
    const ref = "custom/vendor/model";
    if (app === "opencode") edited.model = ref;
    else edited.agents = { defaults: { model: { primary: ref } } };
    const plan = editor.planSave(app, null, edited, base, view.slotKey);
    assert.equal(plan.rowSettings.modelId, ref);
    assert.deepEqual(plan.changes, [], "the model belongs to the row, including newly added ancestors");

    const saved = await saveViaApi(app, edited, base, view.slotKey);
    assert.equal(saved.provider.settingsConfig.modelId, ref);
    const livePath = paths.targetFile(app, "config").path;
    assert.equal(fs.existsSync(livePath), false, "creating a provider must not activate its model");
    await switchProvider({ app, id: saved.provider.id });
    const live = additive.parseLive(app, fs.readFileSync(livePath, "utf8"));
    assert.equal(app === "opencode" ? live.model : live.agents.defaults.model.primary, ref);

    // Clearing the current row's model removes the reference it wrote.
    const cleared = structuredClone(live);
    if (app === "opencode") delete cleared.model;
    else delete cleared.agents;
    const updated = await saveViaApi(app, cleared, live, view.slotKey, saved.provider.id);
    assert.equal(updated.provider.settingsConfig.modelId, "");
    const after = additive.parseLive(app, fs.readFileSync(livePath, "utf8"));
    assert.equal(app === "opencode" ? after.model : after.agents?.defaults?.model?.primary, undefined);
  });
}

test("additive openclaw: new model ancestors keep sibling globals in three-way conflict handling", () => {
  const stored = { slotKey: "custom", provider: { apiKey: "fixture-key" } };
  const base = { models: { providers: { custom: stored.provider } } };
  const edited = {
    ...base,
    agents: { defaults: { model: { primary: "custom/model", fallbacks: ["other/backup"] }, workspace: "/mine" } },
  };
  const plan = editor.planSave("openclaw", stored, edited, base, "custom");
  assert.equal(plan.rowSettings.modelId, "custom/model");
  assert.deepEqual(plan.changes.map((change) => change.path.join(".")).sort(), [
    "agents.defaults.model.fallbacks", "agents.defaults.workspace",
  ]);
  const emptyLives = { config: { exists: false, content: "" } };
  assert.ok(editor.resolveConflicts("openclaw", plan.changes, emptyLives).every((entry) => !entry.conflict));
  const added = additive.parseLive("openclaw", editor.applyChanges("openclaw", emptyLives, plan.changes).config.content);
  assert.deepEqual(added.agents, {
    defaults: { model: { fallbacks: ["other/backup"] }, workspace: "/mine" },
  });
  const lives = { config: { exists: true, content: JSON.stringify({
    agents: { defaults: { model: { primary: "other/current" }, workspace: "/external" } },
  }) } };
  const marked = editor.resolveConflicts("openclaw", plan.changes, lives);
  assert.deepEqual(marked.filter((entry) => entry.conflict).map((entry) => entry.change.path.join(".")), ["agents.defaults.workspace"]);
  const accepted = marked.filter((entry) => !entry.conflict).map((entry) => entry.change);
  const patched = additive.parseLive("openclaw", editor.applyChanges("openclaw", lives, accepted).config.content);
  assert.equal(patched.agents.defaults.workspace, "/external");
  assert.equal(patched.agents.defaults.model.primary, "other/current");
  assert.deepEqual(patched.agents.defaults.model.fallbacks, ["other/backup"]);
});

test("additive openclaw: external model shorthand respects every editor conflict policy", async () => {
  const stored = { slotKey: "custom", provider: { apiKey: "fixture-key" }, modelId: "" };
  const base = { models: { providers: { custom: stored.provider } } };
  const edited = {
    ...base,
    agents: { defaults: { model: { fallbacks: ["other/backup"] }, workspace: "/mine" } },
  };
  const livePath = paths.targetFile("openclaw", "config").path;
  const external = { agents: { defaults: { model: "other/current" } } };
  fs.mkdirSync(path.dirname(livePath), { recursive: true });
  fs.writeFileSync(livePath, JSON.stringify(external));

  const refused = await saveViaApi("openclaw", edited, base, "custom", undefined, { expectedStatus: 409 });
  assert.deepEqual(refused.conflicts, ["agents.defaults.model.fallbacks"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(livePath, "utf8")), external);
  assert.deepEqual((await store.listProviders("openclaw")).providers, []);

  const saved = await saveViaApi("openclaw", edited, base, "custom", undefined, { onConflict: "keepTheirs" });
  assert.deepEqual(JSON.parse(fs.readFileSync(livePath, "utf8")), {
    agents: { defaults: { model: "other/current", workspace: "/mine" } },
  });
  assert.equal(saved.provider.settingsConfig.modelId, "");

  await saveViaApi("openclaw", edited, base, "custom", saved.provider.id, { onConflict: "keepMine" });
  assert.deepEqual(JSON.parse(fs.readFileSync(livePath, "utf8")), {
    agents: { defaults: { model: { fallbacks: ["other/backup"] }, workspace: "/mine" } },
  });
});

test("additive openclaw: adding or removing nested globals conflicts with non-object ancestors", () => {
  const stored = { slotKey: "custom", provider: { apiKey: "fixture-key" } };
  const withoutAgents = { models: { providers: { custom: stored.provider } } };
  const withAgents = {
    ...withoutAgents,
    agents: { defaults: { model: { primary: "custom/model", fallbacks: ["other/backup"] } } },
  };
  for (const [base, edited] of [[withoutAgents, withAgents], [withAgents, withoutAgents]]) {
    const plan = editor.planSave("openclaw", stored, edited, base, "custom");
    for (const value of ["other/current", null, ["other/current"]]) {
      for (const live of [
        { agents: value },
        { agents: { defaults: value } },
        { agents: { defaults: { model: value } } },
      ]) {
        const lives = { config: { exists: true, content: JSON.stringify(live) } };
        const marked = editor.resolveConflicts("openclaw", plan.changes, lives);
        assert.deepEqual(marked.map((entry) => entry.conflict), [true], JSON.stringify({ base, edited, live }));
        const accepted = marked.filter((entry) => !entry.conflict).map((entry) => entry.change);
        const patched = editor.applyChanges("openclaw", lives, accepted);
        assert.deepEqual(JSON.parse(patched.config.content), live);
      }
    }
  }
});

test("additive editor rejects invalid slot values instead of erasing the provider", () => {
  const base = { provider: { custom: { options: { apiKey: "fixture-key" } } } };
  for (const invalid of [true, null, [], "invalid"]) {
    assert.throws(() => editor.planSave("opencode", null, { provider: { custom: invalid } }, base, "custom"), /provider must be an object/);
  }
});

test("additive editor resolves a stored slot when the client omits its echo", () => {
  const stored = { slotKey: "custom", provider: { options: { apiKey: "fixture-key" } } };
  const base = { provider: { custom: stored.provider, other: {} } };
  assert.equal(editor.planSave("opencode", stored, base, base).rowSettings.slotKey, "custom");
});

// ---------------------------------------------------------------------------
// Presets + visible apps
// ---------------------------------------------------------------------------

test("additive presets: every app has a custom template and valid wrappers", () => {
  for (const app of additive.ADDITIVE_APPS) {
    const list = presets.listPresets(app);
    assert.ok(list.length >= 2, `${app} needs presets`);
    const custom = list.find((preset) => preset.group === "custom");
    assert.ok(custom, `${app} needs a custom template`);
    assert.ok(custom.formFields.some((field) => field.id === "api_key"));
    for (const preset of list) {
      assert.ok(preset.settingsConfig.provider, `${preset.id} carries a provider fragment`);
      assert.match(preset.settingsConfig.slotKey, /^[a-z0-9_-]*$/);
    }
  }
  // mcode has no default-model pointer, so its presets carry no modelId.
  for (const preset of presets.listPresets("mcode")) {
    assert.equal(preset.settingsConfig.modelId, undefined);
  }
});

test("visible apps: normalized, persisted, last-visible guard", async () => {
  assert.deepEqual(await store.readVisibleApps(), {
    claude: true,
    codex: true,
    gemini: true,
    opencode: true,
    openclaw: true,
    mcode: true,
    hermes: true,
    pi: true,
    grokbuild: true,
  });

  const next = await store.updateVisibleApps({ claude: false, opencode: false, bogus: false });
  assert.deepEqual(next, {
    claude: false,
    codex: true,
    gemini: true,
    opencode: false,
    openclaw: true,
    mcode: true,
    hermes: true,
    pi: true,
    grokbuild: true,
  });
  // Persisted across a fresh read.
  assert.equal((await store.readVisibleApps()).claude, false);

  const allNine = Object.fromEntries(store.SUPPORTED_APPS.map((app) => [app, false]));
  await assert.rejects(() => store.updateVisibleApps(allNine), /At least one/);
});

// ---------------------------------------------------------------------------
// Hermes: list container keyed by `name`, model.default/model.provider
// pointers, read-only providers dict
// ---------------------------------------------------------------------------

const HERMES_KIMI_ENTRY = {
  name: "kimi",
  base_url: "https://api.moonshot.cn/v1",
  api_key: "a",
  api_mode: "chat_completions",
  model: "kimi-k2.7-code",
  models: { "kimi-k2.7-code": {} },
};

test("additive hermes projection: list container, pointer sync, residue, dict-only guard", () => {
  const prev = { settingsConfig: { slotKey: "kimi", modelId: "kimi-k2.7-code", provider: JSON.parse(JSON.stringify(HERMES_KIMI_ENTRY)) } };
  const target = {
    settingsConfig: {
      slotKey: "deepseek",
      modelId: "deepseek-v4-pro",
      provider: { name: "deepseek", base_url: "https://api.deepseek.com", api_key: "b", api_mode: "chat_completions", model: "deepseek-v4-pro", models: { "deepseek-v4-pro": {} } },
    },
  };
  const live = {
    _config_version: 19,
    providers: { builtin: { name: "builtin" } },
    custom_providers: [JSON.parse(JSON.stringify(HERMES_KIMI_ENTRY)), { name: "mine", base_url: "https://x" }],
    model: { default: "kimi-k2.7-code", provider: "kimi" },
  };

  const next = additive.projectAdditive("hermes", { prev, target, live });
  // The previous provider's entry is residue and disappears; the user's own
  // entry survives and the target lands after it.
  assert.deepEqual(next.custom_providers.map((entry) => entry.name), ["mine", "deepseek"]);
  assert.equal(next.model.default, "deepseek-v4-pro");
  assert.equal(next.model.provider, "deepseek");
  // Hermes' self-managed providers dict is untouched; _config_version passes through.
  assert.deepEqual(next.providers, { builtin: { name: "builtin" } });
  assert.equal(next._config_version, 19);

  // A switch whose slot would shadow a dict-only entry is refused...
  const dictTarget = { settingsConfig: { slotKey: "builtin", provider: { name: "builtin", base_url: "https://b" } } };
  assert.throws(() => additive.projectAdditive("hermes", { prev: target, target: dictTarget, live: next }), /managed by Hermes/);
  // ...unless the same name also exists in custom_providers (list wins there).
  const listed = JSON.parse(JSON.stringify(next));
  listed.custom_providers.push({ name: "builtin", base_url: "https://b" });
  const ok = additive.projectAdditive("hermes", { prev: target, target: dictTarget, live: listed });
  assert.ok(ok.custom_providers.find((entry) => entry.name === "builtin"));

  // YAML round-trip keeps the sequence shape.
  const reparsed = additive.parseLive("hermes", additive.serializeLive("hermes", next));
  assert.deepEqual(reparsed.custom_providers, next.custom_providers);
});

test("additive hermes wrapper sanitize: camelCase aliases, UI markers, models sync", () => {
  const wrapper = additive.sanitizeWrapper(
    "hermes",
    {
      slotKey: "kimi",
      provider: { baseUrl: "https://m", apiKey: "k", apiMode: "chat_completions", model: "kimi-k2.7-code", _cc_source: "custom_providers", provider_key: "kimi", api: "legacy" },
    },
    "Kimi",
  );
  const entry = wrapper.provider;
  assert.equal(entry.base_url, "https://m");
  assert.equal(entry.api_key, "k");
  assert.equal(entry.api_mode, "chat_completions");
  assert.equal(entry.baseUrl, undefined);
  assert.equal(entry.api, undefined);
  assert.equal(entry._cc_source, undefined);
  assert.equal(entry.provider_key, undefined);
  // The singular model id is guaranteed to be a key of the models catalog.
  assert.deepEqual(entry.models, { "kimi-k2.7-code": {} });

  // No singular model: cc-switch derives one from the first catalog key.
  const derived = additive.sanitizeWrapper("hermes", { slotKey: "x", provider: { models: { "m-1": {}, "m-2": {} } } }, "X");
  assert.equal(derived.provider.model, "m-1");
});

test("additive hermes editor view and planSave: named list entries split, dict edits refused", async () => {
  fs.mkdirSync(path.dirname(paths.targetFile("hermes", "config").path), { recursive: true });
  fs.writeFileSync(
    paths.targetFile("hermes", "config").path,
    ["_config_version: 19", "custom_providers:", "  - name: mine", "    base_url: https://x", "model:", "  default: old"].join("\n") + "\n",
  );

  const row = await store.createProvider("hermes", {
    name: "Kimi",
    settingsConfig: { slotKey: "kimi", modelId: "kimi-k2.7-code", provider: JSON.parse(JSON.stringify(HERMES_KIMI_ENTRY)) },
  });

  const view = await editor.buildEditorView("hermes", { settingsConfig: row.settingsConfig, id: row.id });
  assert.equal(view.slotKey, "kimi");
  const base = additive.parseLive("hermes", view.configText);
  assert.equal(base.model.default, "kimi-k2.7-code");
  assert.equal(base.model.provider, "kimi");
  assert.ok(base.custom_providers.find((entry) => entry.name === "mine"));

  // The user edits their entry's model + key, adds a foreign entry, and moves
  // the pointer — pointer and slot are row-owned, only the foreign entry is a
  // global change.
  const edited = JSON.parse(JSON.stringify(base));
  const kimi = edited.custom_providers.find((entry) => entry.name === "kimi");
  kimi.model = "kimi-k3";
  kimi.api_key = "a2";
  edited.custom_providers.push({ name: "another", base_url: "https://y" });
  edited.model.default = "kimi-k3";
  const plan = editor.planSave("hermes", row.settingsConfig, edited, base, view.slotKey);
  assert.equal(plan.rowSettings.provider.model, "kimi-k3");
  assert.equal(plan.rowSettings.provider.api_key, "a2");
  assert.equal(plan.rowSettings.modelId, "kimi-k3"); // derived from the entry
  assert.deepEqual(plan.changes.map((change) => change.path.join(".")), ["custom_providers.another"]);

  // Removing the row's own entry is refused.
  const withoutSlot = JSON.parse(JSON.stringify(base));
  withoutSlot.custom_providers = withoutSlot.custom_providers.filter((entry) => entry.name !== "kimi");
  assert.throws(() => editor.planSave("hermes", row.settingsConfig, withoutSlot, base, view.slotKey), /cannot be removed/);

  // Editing Hermes' self-managed providers dict is refused.
  const withDictEdit = JSON.parse(JSON.stringify(base));
  withDictEdit.providers = { builtin: { name: "builtin", base_url: "https://z" } };
  assert.throws(() => editor.planSave("hermes", row.settingsConfig, withDictEdit, base, view.slotKey), /Hermes Web UI/);
});

// ---------------------------------------------------------------------------
// Pi: providers dict in models.json, no pointer, lowercase-dash slot keys
// ---------------------------------------------------------------------------

test("additive pi projection: membership semantics, no pointer, slug charset", () => {
  const target = {
    settingsConfig: {
      slotKey: "kimi",
      modelId: "kimi-k2.7-code",
      provider: { name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions", apiKey: "a", models: [{ id: "kimi-k2.7-code", name: "Kimi K2.7 Code" }] },
    },
  };
  const live = { providers: { openai: { name: "OpenAI" } } };
  const next = additive.projectAdditive("pi", { prev: null, target, live });
  assert.deepEqual(next.providers.kimi, target.settingsConfig.provider);
  assert.ok(next.providers.openai);
  // Membership is enabling: no pointer is written anywhere.
  assert.equal(next.defaultProvider, undefined);
  assert.equal(next.defaultModel, undefined);

  // Pi slot keys only allow lowercase letters, digits and '-'.
  assert.throws(
    () => additive.sanitizeWrapper("pi", { slotKey: "my_key", provider: { name: "X" } }, "Bad"),
    /slotKey/,
  );
  assert.equal(additive.normalizeSlotKey("My Provider_2!", "pi"), "my-provider-2");

  // Import: single entry falls back; multiple entries without a pointer fail.
  const single = additive.extractAdditive("pi", { providers: { only: { name: "Only", models: [{ id: "m-1" }] } } });
  assert.equal(single.slotKey, "only");
  assert.equal(single.modelId, "m-1");
  assert.throws(() => additive.extractAdditive("pi", { providers: { a: { name: "A" }, b: { name: "B" } } }), /multiple providers/i);
});

test("additive pi editor save: models array rides the row entry", () => {
  const entry = { name: "Kimi", baseUrl: "https://m", api: "openai-completions", apiKey: "a", models: [{ id: "kimi-k2.7-code" }] };
  const row = { settingsConfig: { slotKey: "kimi", modelId: "kimi-k2.7-code", provider: JSON.parse(JSON.stringify(entry)) } };
  const base = { providers: { kimi: JSON.parse(JSON.stringify(entry)), mine: { name: "Mine" } } };
  const edited = JSON.parse(JSON.stringify(base));
  edited.providers.kimi.models[0].id = "kimi-k3";
  edited.providers.kimi.apiKey = "a2";
  const plan = editor.planSave("pi", row.settingsConfig, edited, base, "kimi");
  assert.equal(plan.rowSettings.modelId, "kimi-k3");
  assert.equal(plan.rowSettings.provider.models[0].id, "kimi-k3");
  assert.deepEqual(plan.changes, []); // only the row's own entry changed
});

// ---------------------------------------------------------------------------
// Grok Build: TOML [model.*] tables + [models] default pointer
// ---------------------------------------------------------------------------

const GROK_XAI_ENTRY = {
  name: "xAI (Grok)",
  model: "grok-4.5",
  base_url: "https://api.x.ai/v1",
  api_key: "k1",
  api_backend: "responses",
  context_window: 500000,
};

test("additive grokbuild projection: TOML tables, slot-key pointer, previous table retired", () => {
  const prev = { settingsConfig: { slotKey: "xai", modelId: "grok-4.5", provider: JSON.parse(JSON.stringify(GROK_XAI_ENTRY)) } };
  const target = {
    settingsConfig: {
      slotKey: "openrouter",
      modelId: "x-ai/grok-4.5",
      provider: { name: "OpenRouter", model: "x-ai/grok-4.5", base_url: "https://openrouter.ai/api/v1", api_key: "k2", api_backend: "responses", context_window: 500000 },
    },
  };
  const liveText = [
    "[models]",
    'default = "xai"',
    "",
    '[model."xai"]',
    'model = "grok-4.5"',
    'base_url = "https://api.x.ai/v1"',
    'name = "xAI (Grok)"',
    'api_key = "k1"',
    'api_backend = "responses"',
    "context_window = 500000",
    "",
    "[mcp_servers.fs]",
    'command = "fs"',
  ].join("\n");
  const live = additive.parseLive("grokbuild", liveText);

  const next = additive.projectAdditive("grokbuild", { prev, target, live });
  // The pointer names the table; the previous (unchanged) table is retired;
  // unrelated sections (mcp_servers) survive untouched.
  assert.equal(next.models.default, "openrouter");
  assert.equal(next.model.xai, undefined);
  assert.equal(next.model.openrouter.api_key, "k2");
  assert.deepEqual(next.mcp_servers, { fs: { command: "fs" } });

  // TOML round-trip.
  const reparsed = additive.parseLive("grokbuild", additive.serializeLive("grokbuild", next));
  assert.equal(reparsed.models.default, "openrouter");
  assert.equal(reparsed.model.openrouter.model, "x-ai/grok-4.5");

  // Import: the pointer selects the table and the model id comes from it.
  const wrapper = additive.extractAdditive("grokbuild", JSON.parse(JSON.stringify(next)));
  assert.equal(wrapper.slotKey, "openrouter");
  assert.equal(wrapper.modelId, "x-ai/grok-4.5");
});

test("additive grokbuild editor save: pointer + table row-owned, other keys global", () => {
  const row = { settingsConfig: { slotKey: "xai", modelId: "grok-4.5", provider: JSON.parse(JSON.stringify(GROK_XAI_ENTRY)) } };
  const base = {
    models: { default: "xai" },
    model: { xai: JSON.parse(JSON.stringify(GROK_XAI_ENTRY)) },
    ui: { theme: "dark" },
  };
  const edited = JSON.parse(JSON.stringify(base));
  edited.model.xai.api_key = "k2";
  edited.model.xai.model = "grok-4.6";
  edited.ui.theme = "light";
  const plan = editor.planSave("grokbuild", row.settingsConfig, edited, base, "xai");
  assert.equal(plan.rowSettings.provider.api_key, "k2");
  assert.equal(plan.rowSettings.modelId, "grok-4.6"); // derived from the table's model
  assert.deepEqual(plan.changes.map((change) => change.path.join(".")), ["ui.theme"]);
});

test("additive presets for hermes/pi/grokbuild carry their native shapes", () => {
  for (const preset of presets.listPresets("hermes")) {
    assert.ok(preset.settingsConfig.provider.api_mode, `${preset.id} carries an api_mode`);
    assert.ok("model" in preset.settingsConfig.provider, `${preset.id} carries a singular model`);
  }
  for (const preset of presets.listPresets("pi")) {
    assert.ok(Array.isArray(preset.settingsConfig.provider.models) && preset.settingsConfig.provider.models.length > 0, `${preset.id} carries models`);
    assert.match(preset.settingsConfig.slotKey, /^[a-z0-9-]*$/);
  }
  for (const preset of presets.listPresets("grokbuild")) {
    assert.equal(preset.settingsConfig.provider.api_backend, "responses", `${preset.id} pins api_backend`);
    assert.equal(preset.settingsConfig.provider.context_window, 500000);
  }
});
