"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const clients = require("../src/lib/proxy/desktop-clients");
const jsonc = require("jsonc-parser");
const values = { apiKey: "fixture-key", model: "vision", selectedModels: ["vision"], models: [{ id: "vision", contextWindow: 200000, maxOutputTokens: 32000, inputModalities: ["image"], reasoning: true }] };
async function fixture(t, client) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-desktop-clients-"));
  t.after(() => fs.rm(home, { force: true, recursive: true }));
  const options = { home, env: {}, port: 19997, saveCredential: async () => {} };
  const files = clients.locations(client, options);
  await fs.mkdir(path.dirname(files.target), { recursive: true });
  return { options, files };
}

for (const client of ["workbuddy", "workbuddy-ai"]) test(`${client} keeps user models and native toggles through reconnect and restore`, async t => {
  const { options, files } = await fixture(t, client);
  const user = { id: "user", apiKey: "user-key", url: "https://user.invalid" };
  await fs.writeFile(files.target, JSON.stringify({ models: [user], availableModels: ["user"], preferences: { theme: "user" } }));
  await clients.connect(client, values, options);
  let doc = JSON.parse(await fs.readFile(files.target));
  assert.equal(doc.models[1].url, "http://127.0.0.1:19997/v1/chat/completions");
  assert.equal(doc.models[1].supportsImages, true); assert.equal(doc.models[1].supportsReasoning, true);
  doc.models[1].disabled = true; doc.models[1].reasoning = "high"; doc.preferences.theme = "changed";
  await fs.writeFile(files.target, JSON.stringify(doc));
  await clients.connect(client, { ...values, apiKey: "fixture-key-2" }, options);
  doc = JSON.parse(await fs.readFile(files.target));
  assert.equal(doc.models[1].disabled, true); assert.equal(doc.models[1].reasoning, "high");
  await clients.restore(client, options);
  assert.deepEqual(JSON.parse(await fs.readFile(files.target)), { models: [user], availableModels: ["user"], preferences: { theme: "changed" } });
  assert.equal((await fs.stat((await fs.readdir(path.dirname(files.state))).map(name => path.join(path.dirname(files.state), name)).find(name => name.includes("backup")))).mode & 0o777, 0o600);
});

test("Zed JSONC retains user comments, restores default and never puts the key in config", async t => {
  const { options, files } = await fixture(t, "zed");
  await fs.writeFile(files.target, '{\n // User theme comment\n "theme": "User",\n "agent": { "default_model": { "provider": "user", "model": "old" }, "enabled": true },\n}\n');
  let calls = 0;
  options.saveCredential = async (url, key) => { calls++; assert.equal(url, "http://127.0.0.1:19997/v1"); assert.equal(key, "fixture-key"); };
  await clients.connect("zed", values, options);
  const raw = await fs.readFile(files.target, "utf8"), doc = jsonc.parse(raw);
  assert.match(raw, /User theme comment/); assert.doesNotMatch(raw, /fixture-key/);
  assert.equal(doc.language_models.openai_compatible.aitool.available_models[0].max_output_tokens, 32000);
  assert.deepEqual(doc.agent.default_model, { provider: "aitool", model: "vision" });
  await fs.writeFile(files.target, raw.replace('"theme": "User"', '"theme": "Changed"'));
  await clients.restore("zed", options);
  const restored = jsonc.parse(await fs.readFile(files.target, "utf8"));
  assert.equal(restored.theme, "Changed"); assert.equal(restored.language_models, undefined);
  assert.deepEqual(restored.agent, { default_model: { provider: "user", model: "old" }, enabled: true });
  assert.equal(calls, 1);
});

test("native setup external edits are retained and block target replacement", async t => {
  const { options, files } = await fixture(t, "zed");
  await fs.writeFile(files.target, '{"theme":"before"}');
  options.saveCredential = async () => fs.writeFile(files.target, '{"theme":"during"}');
  await assert.rejects(clients.connect("zed", values, options), /changed during setup/);
  assert.deepEqual(JSON.parse(await fs.readFile(files.target)), { theme: "during" });
  await assert.rejects(fs.stat(files.state), { code: "ENOENT" });
});

test("duplicate keys, malformed config and colliding native names fail without writing", async t => {
  const { options, files } = await fixture(t, "zed");
  for (const raw of ['{"theme":1,"theme":2}', '{"language_models":false}', '{"language_models":{"openai_compatible":{"aitool":{}}}}', '{"secret":"fixture-secret" invalid}']) {
    await fs.writeFile(files.target, raw);
    await assert.rejects(clients.connect("zed", values, options), error => !error.message.includes("fixture-secret"));
    assert.equal(await fs.readFile(files.target, "utf8"), raw);
  }
  const buddy = clients.locations("workbuddy", options);
  await fs.mkdir(path.dirname(buddy.target), { recursive: true });
  await fs.writeFile(buddy.target, '[{"id":"vision","name":"user"}]');
  await assert.rejects(clients.connect("workbuddy", values, options), /user model/);
});

test("journal interrupted before and after replacement is recoverable", async t => {
  const { options, files } = await fixture(t, "workbuddy");
  await clients.connect("workbuddy", values, options);
  let receipt = JSON.parse(await fs.readFile(files.state));
  receipt.pending = receipt.applied; receipt.pendingIds = receipt.ids; delete receipt.applied; receipt.ids = [];
  await fs.writeFile(files.state, JSON.stringify(receipt));
  await clients.connect("workbuddy", values, options);
  await clients.restore("workbuddy", options); await assert.rejects(fs.stat(files.target), { code: "ENOENT" });
  await fs.writeFile(files.state, JSON.stringify({ target: files.target, original: null, ids: [], pending: { models: [], availableModels: null }, pendingIds: ["vision"] }));
  assert.equal((await clients.restore("workbuddy", options)).restored, true);
});

test("edited managed addresses block reconnect and restore; status reports drift", async t => {
  const { options, files } = await fixture(t, "workbuddy");
  await clients.connect("workbuddy", values, options);
  const doc = JSON.parse(await fs.readFile(files.target)); doc[0].url = "https://edited.invalid";
  await fs.writeFile(files.target, JSON.stringify(doc));
  await assert.rejects(clients.connect("workbuddy", values, options), /changed/);
  await assert.rejects(clients.restore("workbuddy", options), /changed/);
  assert.equal((await clients.status(options)).find(row => row.client === "workbuddy").configured, false);
});

test("native credential helpers keep keys out of argv and sanitize command errors", async t => {
  const { options } = await fixture(t, "zed");
  delete options.saveCredential;
  const bundle = path.join(options.home, "Zed.app"); await fs.mkdir(bundle);
  for (const platform of ["linux", "darwin", "win32"]) {
    options.platform = platform; options.zedAppPath = bundle;
    options.commandRunner = async (cmd, args, config) => {
      assert.doesNotMatch(args.join(" "), /fixture-key/);
      if (cmd === "which") return { status: 0, stdout: "/usr/bin/secret-tool\n" };
      assert.equal(config.useShell, false); assert.match(config.input, /fixture-key/);
      if (platform === "linux") assert.deepEqual(args, ["store", "--label=zed-github-account", "url", "http://127.0.0.1:19997/v1", "username", "Bearer"]);
      if (platform === "darwin") assert.match(config.input, /-T.*Zed\.app/);
      return { status: 0, stdout: "", stderr: "" };
    };
    await clients.saveZedCredential("http://127.0.0.1:19997/v1", "fixture-key", options);
  }
  options.commandRunner = async () => ({ status: 1, stderr: "fixture-key" });
  await assert.rejects(clients.saveZedCredential("http://127.0.0.1:19997/v1", "fixture-key", options), error => !error.message.includes("fixture-key"));
});
