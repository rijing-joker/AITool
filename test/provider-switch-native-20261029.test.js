"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const YAML = require("yaml");
const dsh = require("../src/lib/provider-switch/dsh");
const { patch } = require("../src/lib/provider-switch/yaml-text");

test("native YAML edits preserve handwritten flow maps, comments and unrelated anchors", () => {
  const original = "# owner\nsettings: &defaults {timeout: 30} # manual\ncopy: *defaults\nproviders:\n  old:\n    apiKey: old # local\n    models: [one, two]\n";
  const next = YAML.parse(original);
  next.providers.old.apiKey = "new";
  next.providers.new = { apiKey: "another", models: ["three"] };
  const edited = patch(original, next);
  assert.ok(edited.startsWith(original.slice(0, original.indexOf("providers:"))));
  assert.ok(edited.includes("apiKey: new # local"));
  assert.ok(edited.includes("models: [one, two]"));
  delete next.providers.old;
  assert.deepEqual(YAML.parse(patch(edited, next)), next);
  const aliasEdit = YAML.parse(original); aliasEdit.settings.timeout = 50;
  assert.throws(() => patch(original, aliasEdit), /alias|conflict/i);
});

test("DSH credentials use versioned native refs, hydrate read-only and clean only unchanged owned refs", () => {
  const profile = "# profile\n- id: custom\n  config: {setting: keep}\n- id: llm-pi-ai\n  config:\n    providers:\n      native: {apiKeyEnv: OWNER_KEY, models: []}\n";
  const credentials = "version: 1\nrefs: {OWNER_KEY: owner}\nrecords: {login: keep}\n";
  const next = dsh.hydrate(dsh.parse(profile), credentials, {});
  next.providers.relay = { apiKey: "secret", baseURL: "https://relay.example", models: [] };
  const staged = dsh.stage(profile, credentials, next);
  const native = dsh.parse(staged.profileText);
  assert.equal(native.providers.relay.apiKey, undefined);
  assert.equal(native.providers.relay.apiKeyEnv, "AITOOL_DSH_RELAY");
  assert.equal(native.providers.native.apiKeyEnv, "OWNER_KEY");
  assert.ok(staged.profileText.includes("- id: custom\n  config: {setting: keep}"));
  const previous = { settingsConfig: { slotKey: "relay", provider: next.providers.relay } };
  delete next.providers.relay;
  const cleaned = dsh.stage(staged.profileText, staged.credentialsText, next, previous);
  assert.deepEqual(YAML.parse(cleaned.credentialsText), YAML.parse(credentials));
  const external = staged.credentialsText.replace("secret", "external");
  assert.equal(YAML.parse(dsh.stage(staged.profileText, external, next, previous).credentialsText).refs.AITOOL_DSH_RELAY, "external");
  assert.throws(() => dsh.credentialDocument("version: 2\nrefs: {}"), /Unsupported/);
});

test("DSH MCP creates native insert plugins and preserves foreign plugins on edit/remove", () => {
  const initial = "# patch layer\n[]\n";
  const added = dsh.projectMcp(initial, "test", { type: "http", url: "https://example.com/mcp" });
  assert.ok(added.startsWith("# patch layer\n"));
  const [entry] = dsh.mcpEntries(added);
  assert.equal(entry.config.transport, "streamable-http");
  assert.equal(YAML.parse(added)[0].insert[0].id, "aitool-mcp-test");
  const foreign = "- id: custom\n  config: {expression: !!js process.env.TEST}\n";
  const mixed = foreign + added.slice(added.indexOf("- insert:"));
  const edited = dsh.projectMcp(mixed, "test", { command: "node", args: ["server.cjs"] });
  assert.ok(edited.startsWith(foreign));
  assert.equal(dsh.mcpEntries(edited)[0].config.transport, "stdio");
  assert.equal(dsh.projectMcp(edited, "test", null), foreign);
  assert.equal(dsh.projectMcp(added, "test", null), initial);
  assert.throws(() => dsh.projectMcp(initial, "test", { type: "sse", url: "https://example.com" }), /SSE/);
});
