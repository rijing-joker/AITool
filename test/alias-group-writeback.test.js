const assert = require("node:assert/strict");
const { test } = require("node:test");

const { flattenV8ProviderGroups, applyModelsToNativeProviderGroups } = require("../src/lib/proxy/alias-config");

// Port of EasyCLIProxyAPI be9a2b6's update_v8_provider_group_models tests:
// an alias update may only change models[], and the write-back must apply
// those changes onto the NATIVE v8 group arrays — multi-key groups stay
// intact, keys that inherit the group's model list are updated at group
// level, per-key overrides keep their own entries, and anything else
// (names, connection settings, unknown fields) is preserved verbatim.

const GATEWAY_GROUPS = [
  {
    name: "gateway",
    "base-url": "https://example.test/v1",
    models: [{ name: "original" }],
    headers: { "X-Group": "shared" },
    keys: [
      { "api-key": "first", weight: 2, priority: null },
      { "api-key": "second", weight: 5, models: null, headers: {}, "excluded-models": [], "disable-cooling": false },
      { "api-key": "third", models: [{ name: "private" }] },
    ],
  },
];

const clone = (value) => structuredClone(value);

test("per-key model change lands on that key and preserves the group layout", () => {
  const before = flattenV8ProviderGroups("codex", GATEWAY_GROUPS);
  const after = clone(before);
  after[0].models = [{ name: "original" }, { name: "original", alias: "fast" }];

  const updated = applyModelsToNativeProviderGroups("codex", GATEWAY_GROUPS, before, after);

  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0].models, GATEWAY_GROUPS[0].models);
  assert.deepEqual(updated[0].keys[0].models, after[0].models);
  assert.deepEqual(updated[0].keys[0].priority, null);
  assert.deepEqual(updated[0].keys[1], GATEWAY_GROUPS[0].keys[1]);
  assert.deepEqual(updated[0].keys[2], GATEWAY_GROUPS[0].keys[2]);
  assert.deepEqual(flattenV8ProviderGroups("codex", updated), after);
});

test("identical model changes on every inheriting key update the group level", () => {
  const before = flattenV8ProviderGroups("codex", GATEWAY_GROUPS);
  const after = clone(before);
  after[0].models = [{ name: "original" }, { name: "original", alias: "fast" }];
  after[1].models = clone(after[0].models);

  const updated = applyModelsToNativeProviderGroups("codex", GATEWAY_GROUPS, before, after);

  assert.deepEqual(updated[0].models, after[0].models);
  assert.deepEqual(updated[0].keys, GATEWAY_GROUPS[0].keys);
  assert.deepEqual(flattenV8ProviderGroups("codex", updated), after);
});

test("empty groups and single-key groups stay intact; group models update", () => {
  for (const provider of ["codex", "openai-compatibility"]) {
    const groups = [
      { name: "empty", keys: [] },
      { name: "active", models: [{ name: "model" }], keys: [{ "api-key": "key", "proxy-url": "direct" }] },
    ];
    const before = flattenV8ProviderGroups(provider, groups);
    const after = clone(before);
    const index = after.length - 1;
    after[index].models = [{ name: "model", alias: "alias" }];

    const updated = applyModelsToNativeProviderGroups(provider, groups, before, after);

    assert.deepEqual(updated[0], groups[0]);
    assert.deepEqual(updated[1].keys, groups[1].keys);
    assert.deepEqual(updated[1].models, after[index].models);

    after[index]["base-url"] = "https://changed.test";
    assert.throws(
      () => applyModelsToNativeProviderGroups(provider, groups, before, after),
      /cannot change provider connection settings/,
    );
  }
});

test("openai-compatibility model removal deletes the record's models field", () => {
  const groups = [
    { name: "relay", "base-url": "https://relay.test/v1", models: [{ name: "gpt-x" }], keys: [{ "api-key": "k" }] },
  ];
  const before = flattenV8ProviderGroups("openai-compatibility", groups);
  const after = clone(before);
  delete after[0].models;

  const updated = applyModelsToNativeProviderGroups("openai-compatibility", groups, before, after);

  assert.equal(updated[0].models, undefined);
  assert.deepEqual(updated[0].keys, groups[0].keys);
  assert.deepEqual(updated[0]["base-url"], groups[0]["base-url"]);
});

test("stale native groups, key-count changes, and setting edits are rejected", () => {
  const groups = [{ name: "source", models: [{ name: "model" }], keys: [{ "api-key": "key" }] }];
  const before = flattenV8ProviderGroups("codex", groups);

  const mutated = clone(groups);
  mutated[0].keys[0].priority = 7;
  assert.throws(
    () => applyModelsToNativeProviderGroups("codex", mutated, before, before),
    /Provider groups changed/,
  );

  const after = clone(before);
  after.push(clone(after[0]));
  assert.throws(
    () => applyModelsToNativeProviderGroups("codex", groups, before, after),
    /cannot add or remove provider keys/,
  );

  assert.throws(
    () => applyModelsToNativeProviderGroups("codex", undefined, before, before),
    /Provider groups changed/,
  );
});
