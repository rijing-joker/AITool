"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("smol-toml");
const { projectCodex, extractCodexConfig } = require("../src/lib/provider-switch/targets");
const { planSave } = require("../src/lib/provider-switch/editor");
const { sanitizeProviderFields } = require("../src/lib/provider-switch/store");
const { listPresets } = require("../src/lib/provider-switch/presets");
const catalog = require("../src/lib/provider-switch/catalog");
catalog.setCodexOfficialModelsForTests([]);

const row = (config, category = "custom") => ({ name: "Fixture", category, settingsConfig: { auth: { OPENAI_API_KEY: "fixture-key" }, config } });
const project = (target, liveToml = "", extra = {}) => projectCodex({ prev: null, target, liveToml, liveAuth: {}, stash: null, ...extra });

for (const endpointKey of ["base_url", "openai_base_url"]) {
  test(`legacy ${endpointKey} projects and saves as a custom route without changing user settings`, () => {
    const live = `# keep this comment\n${endpointKey} = "https://old.test/v1"\nwire_api = "chat"\nnotify = ["node", "hook.js"] # keep hook\n\n[mcp_servers.fixture]\ncommand = "node"\n`;
    const target = row({ [endpointKey]: "https://relay.test/v1", wire_api: "chat", model: "my-model" });
    const projection = project(target, live);
    const config = parse(projection.configToml);
    assert.equal(config.model_provider, "custom");
    assert.equal(config.model_providers.custom.base_url, "https://relay.test/v1");
    assert.equal(config.model_providers.custom.wire_api, "chat");
    assert.equal(config.model_providers.custom.experimental_bearer_token, "fixture-key");
    assert.equal(config[endpointKey], undefined);
    assert.equal(config.wire_api, undefined);
    assert.match(projection.configToml, /# keep this comment/);
    assert.match(projection.configToml, /notify = \["node", "hook.js"\] # keep hook/);
    assert.equal(config.mcp_servers.fixture.command, "node");
    const imported = extractCodexConfig(live);
    assert.equal(imported.config.model_providers.custom.base_url, "https://old.test/v1");
    assert.equal(imported.config.notify, undefined);
    const edited = { ...target.settingsConfig, config: parse(live) };
    const planned = planSave("codex", target.settingsConfig, edited, edited);
    assert.equal(planned.changes.length, 0);
    assert.equal(planned.rowSettings.config.model_providers.custom.base_url, "https://old.test/v1");
    assert.equal(planned.rowSettings.config[endpointKey], undefined);
    assert.equal(sanitizeProviderFields("codex", target).settingsConfig.config[endpointKey], undefined);
    assert.deepEqual(parse(project(row(planned.rowSettings.config), projection.configToml).configToml).notify, config.notify);
  });
}

test("an existing selected route takes precedence over legacy endpoints", () => {
  const config = { base_url: "https://stale.test", openai_base_url: "https://also-stale.test", model_provider: "relay", model_providers: {
    custom: { base_url: "https://unused.test" },
    relay: { name: "Kept", base_url: "https://active.test/v1", wire_api: "responses", http_headers: { "X-Test": "kept" } },
  } };
  const actual = parse(project(row(config)).configToml);
  assert.equal(actual.model_provider, "custom");
  assert.equal(actual.model_providers.custom.base_url, "https://active.test/v1");
  assert.equal(actual.model_providers.custom.http_headers["X-Test"], "kept");
  assert.equal(actual.base_url, undefined);
});

for (const route of [
  '[model_providers.custom]\nbase_url = "https://old.test"\n',
  '[model_providers]\ncustom = { base_url = "https://old.test" }\n',
  'model_providers.custom = { base_url = "https://old.test" }\n',
  'model_providers."custom".base_url = "https://old.test"\n',
  'model_providers = { custom = { base_url = "https://old.test" }, spare = { base_url = "https://spare.test" } }\n',
]) {
  test(`route projection replaces ${route.split("\n")[0]} without duplicate TOML`, () => {
    const text = `${route}\n[notice]\nnote = """\n[model_providers.custom]\nthis is a string\n"""\n`;
    const target = row({ base_url: "https://new.test/v1" });
    const first = project(target, text).configToml;
    const second = project(target, first).configToml;
    const parsed = parse(second);
    assert.deepEqual(parse(first), parsed);
    assert.equal(parsed.model_providers.custom.base_url, "https://new.test/v1");
    assert.equal(parsed.notice.note, parse(text).notice.note);
    if (parse(text).model_providers.spare) assert.deepEqual(parsed.model_providers.spare, parse(text).model_providers.spare);
    assert.equal(extractCodexConfig(first).config.model_providers.custom.base_url, "https://new.test/v1");
  });
}

test("legacy relay switching still stashes and restores official login", () => {
  const login = { tokens: { access_token: "fixture-login" } };
  const relay = row({ base_url: "https://relay.test/v1" });
  const outgoing = project(relay, "", { liveAuth: login });
  assert.equal(outgoing.auth.action, "stash");
  const official = { name: "Official", category: "official", settingsConfig: { auth: null, config: { model_provider: "openai" } } };
  const incoming = project(official, outgoing.configToml, { prev: relay, stash: outgoing.auth.stashNext });
  assert.equal(incoming.auth.action, "write");
  assert.deepEqual(incoming.auth.content, login);
  assert.equal(parse(incoming.configToml).model_provider, "openai");
  const officialLegacy = row({ openai_base_url: "https://api.openai.com/v1", model_provider: "openai" }, "official");
  assert.equal(sanitizeProviderFields("codex", officialLegacy).settingsConfig.config.model_provider, "openai");
  assert.equal(parse(project(officialLegacy).configToml).model_providers, undefined);
});

test("MoArk catalog has the five exact capabilities and valid default reasoning levels", () => {
  const preset = listPresets("codex").find((item) => item.id === "codex_moark");
  const models = JSON.parse(catalog.buildCodexCatalog(preset.meta.codexCatalogModels, [])).models;
  assert.deepEqual(models.map((model) => model.slug), ["deepseek-v4-flash-0731", "DeepSeek-V4-Pro", "GLM-5.3", "Kimi-K2.7-Code", "qwen3-coder-plus"]);
  assert.deepEqual(models.map((model) => model.context_window), [1000000, 1000000, 1048576, 262144, 1000000]);
  assert.deepEqual(models.map((model) => model.input_modalities), [["text"], ["text"], ["text"], ["text", "image"], ["text"]]);
  assert.deepEqual(models[0].supported_reasoning_levels.map((level) => level.effort), ["low", "high", "max"]);
  assert.equal(models[4].default_reasoning_level, "none");
  assert.ok(models.every((model) => model.supported_reasoning_levels.some((level) => level.effort === model.default_reasoning_level)));
});
