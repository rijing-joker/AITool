"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const kimi = require("../src/lib/provider-switch/kimi");
const { createManager } = require("../src/lib/provider-switch/kimi-accounts");
const sessions = require("../src/lib/sessions");
const store = require("../src/lib/provider-switch/store");
const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-kimi-review-"));
  const kimiHome = path.join(home, ".kimi-code");
  const root = path.join(home, ".aitool", "provider-switch");
  t.mock.method(os, "homedir", () => home);
  const prior = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = kimiHome;
  t.after(async () => {
    if (prior === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = prior;
    await fs.rm(home, { recursive: true, force: true });
  });
  await fs.mkdir(kimiHome, { recursive: true });
  return { home, kimiHome, root, configPath: path.join(kimiHome, "config.toml") };
}

const provider = { type: "openai", base_url: "https://example.test/v1", api_key: "fixture-key" };
const model = (owner = "relay") => ({ provider: owner, model: "m", max_context_size: 8192 });
const settingsConfig = () => ({ slotKey: "relay", provider: { ...provider }, models: { primary: model(), secondary: model() } });

async function api(method, url, payload) {
  const req = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []);
  Object.assign(req, { method, url, headers: { host: "localhost" } });
  const res = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  assert.equal(await handleProviderSwitchApiRequest(req, res, new URL(`http://localhost${url}`), {
    isAuthorizedLocalMutation: () => true,
  }), true);
  return res;
}

async function createRelay() {
  const res = await api("POST", "/api/provider-switch/providers", {
    app: "kimi", name: "Relay", settingsConfig: settingsConfig(),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.provider;
}

for (const selected of ["default_model", "secondary_model"]) {
  test(`kimi edits refuse to remove aliases referenced by ${selected}`, () => {
    const before = {
      providers: { relay: provider }, models: { primary: model(), secondary: model(), unused: model() },
      default_model: "primary", secondary_model: { default_model: "secondary" },
    };
    const removed = selected === "default_model" ? "primary" : "secondary";
    const kept = Object.fromEntries(Object.entries(before.models).filter(([key]) => key !== removed));
    assert.throws(() => kimi.stageProvider(before, "relay", { provider, models: kept }), /still selected/);
    assert.deepEqual(Object.keys(before.models), ["primary", "secondary", "unused"]);
    const after = kimi.stageProvider(before, "relay", { provider, models: { primary: model(), secondary: model() } });
    assert.equal(after.models.unused, undefined, "unreferenced aliases remain editable");
    assert.equal(after.default_model, "primary");
    assert.equal(after.secondary_model.default_model, "secondary");
  });
}

test("kimi API refuses referenced-alias edits before writing either store", async t => {
  const x = await fixture(t);
  const row = await createRelay();
  const doc = await kimi.readDocument();
  doc.secondary_model = { default_model: "secondary" };
  await fs.writeFile(x.configPath, kimi.serializeDocument(doc));
  const before = await fs.readFile(x.configPath, "utf8");
  const result = await api("PUT", `/api/provider-switch/providers/${row.id}`, {
    app: "kimi", settingsConfig: { ...settingsConfig(), models: { primary: model() } },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /still selected/);
  assert.equal(await fs.readFile(x.configPath, "utf8"), before);
  assert.deepEqual(await store.getProvider("kimi", row.id), row);
});

test("kimi API fixes existing slot keys while allowing names and credentials to change", async t => {
  const x = await fixture(t);
  const row = await createRelay();
  await api("POST", "/api/provider-switch/switch", { app: "kimi", id: row.id });
  const before = await fs.readFile(x.configPath, "utf8");
  const renamed = await api("PUT", `/api/provider-switch/providers/${row.id}`, {
    app: "kimi", name: "Renamed", settingsConfig: { ...settingsConfig(), slotKey: "renamed",
      models: { renamedPrimary: model("renamed"), renamedSecondary: model("renamed") } },
  });
  assert.equal(renamed.status, 400);
  assert.match(renamed.body.error, /provider keys cannot be changed/);
  assert.equal(await fs.readFile(x.configPath, "utf8"), before);
  assert.deepEqual(await store.getProvider("kimi", row.id), row);
  const edited = await api("PUT", `/api/provider-switch/providers/${row.id}`, {
    app: "kimi", name: "Renamed", settingsConfig: { ...settingsConfig(), slotKey: " relay ", provider: { ...provider, api_key: "new-fixture-key" } },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.provider.name, "Renamed");
  assert.equal(edited.body.provider.settingsConfig.slotKey, "relay");
  const after = await kimi.readDocument();
  assert.deepEqual(Object.keys(after.providers), ["relay"]);
  assert.equal(after.providers[kimi.currentProviderKey(after)].api_key, "new-fixture-key");
  assert.equal(after.default_model, "primary");
});

async function sessionFixture(t, fallback = false) {
  const x = await fixture(t);
  const dir = path.join(x.kimiHome, "sessions", "wd", "session-1");
  const sourcePath = path.join(dir, "agents", "main", "wire.jsonl");
  const statePath = path.join(dir, ...(fallback ? ["session-meta"] : []), "state.json");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(sourcePath, `${JSON.stringify({ type: "context.append_message", time: 1700000000,
    message: { role: "user", content: "a".repeat(5000) } })}\n`);
  await fs.writeFile(statePath, JSON.stringify({ title: "Old", cwd: "/old" }));
  return { ...x, dir, statePath, options: { app: "kimi", home: x.home, env: { KIMI_CODE_HOME: x.kimiHome }, sourcePath } };
}

test("Kimi state-only edits invalidate list metadata and transcript revisions", async t => {
  const x = await sessionFixture(t);
  const listed = await sessions.listSessions(x.options);
  const preview = await sessions.readSession({ ...x.options, preview: true });
  assert.equal(listed[0].title, "Old");
  await fs.writeFile(x.statePath, JSON.stringify({ title: "New title", cwd: "/new/project" }));
  const updated = await sessions.listSessions(x.options);
  assert.equal(updated[0].title, "New title");
  assert.equal(updated[0].projectDir, "/new/project");
  assert.notEqual((await sessions.readSession(x.options)).revision, preview.revision);
  await assert.rejects(sessions.readSessionContent({ ...x.options, revision: preview.revision,
    ref: preview.messages[0].contentRef.id }), /changed|reload/i);
  for (const hidden of [{ archived: true }, { custom: { session_kind: "child" } }]) {
    await fs.writeFile(x.statePath, JSON.stringify(hidden));
    assert.deepEqual(await sessions.listSessions(x.options), []);
    await assert.rejects(sessions.readSession(x.options), /archived or a child/);
  }
  await fs.writeFile(x.statePath, JSON.stringify({ title: "Restored", cwd: "/restored" }));
  assert.equal((await sessions.listSessions(x.options))[0].title, "Restored");
  await fs.unlink(x.statePath);
  assert.deepEqual(await sessions.listSessions(x.options), []);
  await assert.rejects(sessions.readSession(x.options), /state is missing/);
});

test("Kimi fallback state changes, precedence and root checks invalidate cached sessions", async t => {
  const x = await sessionFixture(t, true);
  const first = await sessions.readSession(x.options);
  await sessions.listSessions(x.options);
  await fs.writeFile(x.statePath, JSON.stringify({ title: "Fallback edited", cwd: "/fallback" }));
  assert.equal((await sessions.listSessions(x.options))[0].title, "Fallback edited");
  assert.notEqual((await sessions.readSession(x.options)).revision, first.revision);
  const primaryPath = path.join(x.dir, "state.json");
  await fs.writeFile(primaryPath, JSON.stringify({ title: "Primary", cwd: "/primary" }));
  assert.equal((await sessions.listSessions(x.options))[0].title, "Primary");
  const primary = await sessions.readSession(x.options);
  await fs.unlink(primaryPath);
  assert.equal((await sessions.listSessions(x.options))[0].title, "Fallback edited");
  assert.notEqual((await sessions.readSession(x.options)).revision, primary.revision);
  const outside = path.join(x.home, "outside-state.json");
  await fs.writeFile(outside, JSON.stringify({ title: "Outside" }));
  await fs.unlink(x.statePath);
  await fs.symlink(outside, x.statePath);
  assert.deepEqual(await sessions.listSessions(x.options), []);
  await assert.rejects(sessions.readSession(x.options), /outside/);
});

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Operation blocked by identity lookup")), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

async function accountFixture(t) {
  const x = await fixture(t);
  const id = kimi.OFFICIAL_PROVIDER_ID;
  await fs.writeFile(x.configPath, kimi.serializeDocument({
    providers: { [id]: { type: "kimi", base_url: "https://api.kimi.com/coding/v1", oauth: { key: "oauth/kimi-code" } } },
    models: { official: model(id) }, default_model: "official",
  }));
  await fs.mkdir(path.join(x.kimiHome, "credentials"));
  const credentialPath = path.join(x.kimiHome, "credentials", "kimi-code.json");
  await fs.writeFile(credentialPath, JSON.stringify({
    access_token: "access-fixture", refresh_token: "refresh-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  return { ...x, id, credentialPath };
}

test("background Kimi identity requests share one flight and leave status, login and switching responsive", async t => {
  const x = await accountFixture(t);
  const id = x.id;
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  let identityCalls = 0;
  const accounts = createManager({ root: x.root, home: x.kimiHome, fetchImpl: async url => {
    if (String(url).endsWith("/me")) {
      identityCalls += 1;
      started.resolve();
      await gate.promise;
      return { status: 200, json: async () => ({ user_id: "fixture", nickname: "Identified" }) };
    }
    assert.ok(String(url).endsWith("/api/oauth/device_authorization"));
    return { status: 200, json: async () => ({ device_code: "d", user_code: "CODE",
      verification_uri: "https://auth.kimi.com/verify", expires_in: 600, interval: 1 }) };
  } });
  try {
    await bounded(accounts.status());
    await bounded(started.promise);
    await bounded(accounts.status());
    await bounded(accounts.status());
    assert.equal(identityCalls, 1, "polling must not duplicate a pending identity request");
    assert.ok((await bounded(accounts.startLogin("cn"))).flowId);
    await bounded(accounts.useAccount(id));
    assert.equal(kimi.currentProviderKey(await kimi.readDocument()), id);
  } finally {
    accounts.cancel();
    gate.resolve();
    // Drain the lookup's cache commit before fixture cleanup.
    await bounded((async () => {
      for (;;) {
        if ((await accounts.status()).accounts[0]?.nickname === "Identified") break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })());
  }
});

test("a late Kimi identity response is discarded after native credential rotation", async t => {
  const x = await accountFixture(t);
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  let calls = 0;
  const accounts = createManager({ root: x.root, home: x.kimiHome, fetchImpl: async (url, init) => {
    assert.ok(String(url).endsWith("/me"));
    calls += 1;
    const old = init.headers.authorization === "Bearer access-fixture";
    if (old) { started.resolve(); await gate.promise; }
    return { status: 200, json: async () => ({ user_id: old ? "old-user" : "new-user", nickname: old ? "Old" : "New" }) };
  } });
  try {
    await bounded(accounts.status());
    await bounded(started.promise);
    await fs.writeFile(x.credentialPath, JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    gate.resolve();
    await bounded((async () => {
      for (;;) {
        const nickname = (await accounts.status()).accounts[0]?.nickname;
        assert.notEqual(nickname, "Old", "the old identity must never enter the cache");
        if (nickname === "New") break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })());
    assert.equal(calls, 2, "the rotated credential must get its own identity lookup");
  } finally { gate.resolve(); }
});
