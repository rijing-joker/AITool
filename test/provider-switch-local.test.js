const assert = require("node:assert/strict");
const { test } = require("node:test");
const { listPresets } = require("../src/lib/provider-switch/presets");
const { projectClaude, projectCodex } = require("../src/lib/provider-switch/targets");
const { buildCodexCatalog } = require("../src/lib/provider-switch/catalog");

test("local presets project bearer keys, model mappings and editable endpoints into Claude and Codex", () => {
  for (const preset of listPresets("claude").filter((row) => row.group === "local")) {
    const projected = projectClaude({ prev: null, target: { category: "custom", settingsConfig: preset.settingsConfig }, live: { permissions: { allow: ["Read"] } } });
    assert.equal(projected.env.ANTHROPIC_AUTH_TOKEN, preset.settingsConfig.env.ANTHROPIC_AUTH_TOKEN);
    assert.equal(projected.env.ANTHROPIC_API_KEY, "");
    assert.equal(projected.env.ANTHROPIC_MODEL, projected.env.ANTHROPIC_DEFAULT_SONNET_MODEL);
    assert.deepEqual(projected.permissions, { allow: ["Read"] });
  }
  for (const preset of listPresets("codex").filter((row) => row.group === "local")) {
    const projected = projectCodex({ prev: null, target: { category: "custom", settingsConfig: preset.settingsConfig }, liveToml: 'notify = ["my-hook"]\n', liveAuth: {} });
    assert.match(projected.configToml, /experimental_bearer_token = /);
    assert.match(projected.configToml, /wire_api = "responses"/);
    assert.match(projected.configToml, /disable_response_storage = true/);
    assert.match(projected.configToml, /notify = \["my-hook"\]/);
    const catalog = JSON.parse(buildCodexCatalog(preset.meta.codexCatalogModels, []));
    assert.ok(catalog.models.some((model) => model.slug === preset.settingsConfig.config.model));
    assert.ok(catalog.models.every((model) => !model.apply_patch_tool_type && !model.supports_parallel_tool_calls));
  }
});

test("local OpenCode defaults always select a model present in their provider entry", () => {
  const presets = listPresets("opencode").filter((row) => row.group === "local");
  assert.equal(presets.length, 5);
  for (const { settingsConfig: { slotKey, modelId, provider } } of presets) {
    assert.ok(provider.models[modelId.slice(slotKey.length + 1)]);
  }
});
