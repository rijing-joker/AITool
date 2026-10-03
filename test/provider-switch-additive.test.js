"use strict";

// Tests for the provider-switch additive layer (cc-switch's additive-mode
// port): the generic projection/extract/editor-save engine for opencode,
// openclaw and MiniMax Code (mcode), the per-app presets, and the visible
// apps setting exposed through /api/provider-switch/*.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
  });

  const next = await store.updateVisibleApps({ claude: false, opencode: false, bogus: false });
  assert.deepEqual(next, {
    claude: false,
    codex: true,
    gemini: true,
    opencode: false,
    openclaw: true,
    mcode: true,
  });
  // Persisted across a fresh read.
  assert.equal((await store.readVisibleApps()).claude, false);

  await assert.rejects(
    () => store.updateVisibleApps({ claude: false, codex: false, gemini: false, opencode: false, openclaw: false, mcode: false }),
    /At least one/,
  );
});
