const { test } = require("node:test");
const assert = require("node:assert/strict");
const management = require("../src/lib/proxy/management");
const config = require("../src/lib/proxy/config");
const undici = require("undici");
const aliases = require("../src/lib/proxy/alias-config");

function fixture(t, initial) {
  let state = structuredClone(initial);
  const writes = [];
  let onWrite = null;
  let onRead = null;
  t.mock.method(config, "getServerPort", () => 8318);
  t.mock.method(undici, "request", async () => ({ statusCode: 200, body: { text: async () => JSON.stringify({ data: [
    "model-a", "model-b", "model-c", "shared", "private", "model-a-alias", "model-b-alias",
  ].map((id) => ({ id })) }) } }));
  t.mock.method(management, "request", async (method, route, options = {}) => {
    if (method === "GET" && route === "/v8/management/config") {
      if (onRead) onRead(state);
      return { ok: true, data: structuredClone(state), etag: '"fixture"' };
    }
    if (route.endsWith("/credentials")) return { ok: true, data: { files: [{ provider: "codex" }, { provider: "claude" }] } };
    if (route.includes("/model-definitions/")) return { ok: true, data: { models: ["model-a", "model-b"].map((id) => ({ id, reasoning_levels: ["low", "high"] })) } };
    if (method === "PUT") {
      assert.equal(options.ifMatch, '"fixture"');
      if (onWrite) {
        const response = onWrite(route, options.body, state);
        if (response) return response;
      }
      writes.push(route);
      const body = structuredClone(options.body);
      if (route.endsWith("/oauth/model-alias")) (state.oauth ||= {})["model-alias"] = body;
      else if (route.endsWith("/requests/payload")) (state.requests ||= {}).payload = body;
      else state["api-keys"][route.split("/").at(-1)] = body;
      return { ok: true, status: 200 };
    }
    throw new Error(`Unexpected request: ${method} ${route}`);
  });
  return { get state() { return state; }, writes, onWrite: (callback) => { onWrite = callback; }, onRead: (callback) => { onRead = callback; } };
}

const base = () => ({
  "api-keys": { codex: [{ name: "main", "base-url": "https://example.test", models: [{ name: "model-a" }, { name: "model-a", alias: "shared" }], keys: [
    { "api-key": "key1" }, { "api-key": "key2" }, { "api-key": "key3", models: [{ name: "model-b", alias: "private" }] },
  ] }], "openai-compatibility": [{ name: "relay", keys: [{ "api-key": "key4", models: [{ name: "model-c", alias: "shared" }] }] }] },
  oauth: { "model-alias": { codex: [{ name: "model-a", alias: "shared", fork: true }, { name: "model-b", alias: "shared", fork: true }] } },
});
const allEntries = (state) => [...state.thinkingEntries, ...state.speedEntries.filter((entry) => !state.thinkingEntries.some((other) => other.mappingId === entry.mappingId))];
const editArgs = async (entry, patch) => {
  const context = await aliases.getEditContext(entry);
  return { originalAlias: entry.alias, mappingId: entry.mappingId, expectedRevision: context.revision,
    sourceId: context.source.id, alias: entry.alias, effort: context.effort || "", fast: context.fast, ...patch };
};

test("mapping inventory collapses inherited group models and includes per-key overrides", async (t) => {
  fixture(t, base());
  const entries = allEntries(await aliases.loadState());
  assert.equal(entries.length, 5);
  assert.equal(new Set(entries.map((entry) => entry.mappingId)).size, 5);
  assert.equal(entries.filter((entry) => entry.provider === "main" && entry.alias === "shared").length, 1);
  assert.equal(entries.find((entry) => entry.provider === "relay").keyIndex, 0);
  assert.ok(entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.revision)));
  assert.equal(JSON.stringify(entries).includes("key1"), false);
});

test("OAuth mappings with the same name edit independently; legacy ambiguity is explicit", async (t) => {
  const f = fixture(t, base());
  const entry = allEntries(await aliases.loadState()).find((row) => row.oauthChannel && row.sourceModel === "model-b");
  await assert.rejects(aliases.getEditContext({ alias: "shared" }), /ambiguous/);
  await assert.rejects(aliases.deleteAlias({ alias: "shared" }), /ambiguous/);
  await aliases.createAlias(await editArgs(entry, { alias: "renamed" }));
  assert.deepEqual(f.state.oauth["model-alias"].codex.map((row) => row.alias), ["shared", "renamed"]);
  assert.equal(f.state["api-keys"].codex[0].models[1].alias, "shared");
});

test("shared aliases can be created on multiple OAuth and native sources", async (t) => {
  const f = fixture(t, base());
  const state = await aliases.loadState();
  for (const source of [state.baseSources.find((s) => s.id === "codex-oauth:model-a"), state.baseSources.find((s) => s.kind === "codex-api" && s.model === "model-a")]) {
    await aliases.createAlias({ sourceId: source.id, alias: "shared", effort: "", fast: false });
  }
  assert.equal(f.state.oauth["model-alias"].codex.length, 3);
  assert.equal(f.state["api-keys"].codex[0].models.length, 3);
  assert.equal(f.state["api-keys"].codex[0].keys[0].models, undefined);
  assert.equal(f.state["api-keys"].codex[0].keys[1].models, undefined);
});

test("local revisions accept unrelated edits and reject changed target mappings", async (t) => {
  const f = fixture(t, base());
  const entry = allEntries(await aliases.loadState()).find((row) => row.alias === "private");
  const args = await editArgs(entry, { alias: "my-private" });
  f.state["api-keys"].codex[0].priority = 9;
  f.state["api-keys"].codex[0].models.unshift({ name: "model-c" });
  await aliases.createAlias(args);
  assert.equal(f.state["api-keys"].codex[0].priority, 9);
  assert.equal(f.state["api-keys"].codex[0].keys[2].models[0].alias, "my-private");
  const current = allEntries(await aliases.loadState()).find((row) => row.alias === "my-private");
  const stale = await editArgs(current, { alias: "stale" });
  f.state["api-keys"].codex[0].keys[2].models[0]["display-name"] = "changed";
  await assert.rejects(aliases.createAlias(stale), /mapping changed/);
  assert.equal(f.state["api-keys"].codex[0].keys[2].models[0].alias, "my-private");
});

test("concurrent saves reread and retain both independent mapping edits", async (t) => {
  const initial = base();
  initial["api-keys"].codex[0].models.push({ name: "model-b", alias: "second" });
  const f = fixture(t, initial);
  const entries = allEntries(await aliases.loadState()).filter((row) => row.provider === "main" && row.keyIndex == null);
  const edits = await Promise.all(entries.map((entry) => editArgs(entry, { alias: `${entry.alias}-updated` })));
  await Promise.all(edits.map((args) => aliases.createAlias(args)));
  assert.deepEqual(f.state["api-keys"].codex[0].models.slice(1).map((row) => row.alias), ["shared-updated", "second-updated"]);
});

test("shared parameters survive deletion until the last mapping in that protocol", async (t) => {
  const initial = base();
  initial.requests = { payload: { override: [{ models: [{ name: "shared" }], params: { "reasoning.effort": "high", service_tier: "priority", temperature: 0.4 } }] } };
  const f = fixture(t, initial);
  let entries = allEntries(await aliases.loadState());
  for (const row of entries.filter((entry) => entry.alias === "shared" && entry.protocol === "codex")) {
    // Refresh revisions as the shared configuration is intentionally changed.
    const current = allEntries(await aliases.loadState()).find((entry) => entry.mappingId === row.mappingId);
    await aliases.deleteAlias(current);
  }
  entries = allEntries(await aliases.loadState());
  const remaining = entries.find((entry) => entry.alias === "shared");
  assert.equal(remaining.protocol, "openai");
  assert.equal(remaining.serviceTier, "priority");
  const rules = f.state.requests.payload.override;
  assert.ok(rules.some((rule) => rule.models.some((model) => model.protocol === "openai") && rule.params.service_tier === "priority"));
  assert.ok(!rules.some((rule) => rule.models.some((model) => model.protocol === "codex") && rule.params.service_tier));
  await aliases.deleteAlias(remaining);
  assert.ok(f.state.requests.payload.override.every((rule) => rule.params.service_tier === undefined));
});

test("failed multi-section writes roll back only unchanged sections", async (t) => {
  const f = fixture(t, base());
  const entry = allEntries(await aliases.loadState()).find((row) => row.oauthChannel && row.sourceModel === "model-b");
  const before = structuredClone(f.state);
  f.onWrite((route) => route.endsWith("/requests/payload") ? { ok: false, status: 500 } : null);
  await assert.rejects(aliases.createAlias(await editArgs(entry, { alias: "failed", effort: "high" })), /rejected alias save/);
  assert.deepEqual(f.state, before);

  f.onWrite((route, body, state) => {
    if (!route.endsWith("/requests/payload")) return null;
    state.oauth["model-alias"].codex.push({ name: "model-c", alias: "external" });
    return { ok: false, status: 500 };
  });
  await assert.rejects(aliases.createAlias(await editArgs(entry, { alias: "failed", effort: "high" })), /rollback could not restore/);
  assert.equal(f.state.oauth["model-alias"].codex.at(-1).alias, "external");
});

test("unrelated external changes during save are rebased and disabled groups hide key sources", async (t) => {
  const f = fixture(t, base());
  const entry = allEntries(await aliases.loadState()).find((row) => row.alias === "private");
  const args = await editArgs(entry, { alias: "rebased" });
  let reads = 0;
  f.onRead((state) => { if (++reads === 2) state["api-keys"].codex[0].priority = 7; });
  await aliases.createAlias(args);
  assert.equal(f.state["api-keys"].codex[0].priority, 7);
  assert.equal(f.state["api-keys"].codex[0].keys[2].models[0].alias, "rebased");
  f.state["api-keys"].codex[0].disabled = true;
  assert.ok((await aliases.loadState()).baseSources.every((source) => source.provider !== "main"));
});

test("mapping identities survive reordering and parameter edits affect only their protocol", async (t) => {
  const initial = base();
  initial["api-keys"].codex.push({ name: "second", models: [{ name: "model-c", alias: "second" }], keys: [{ "api-key": "second-key" }] });
  const f = fixture(t, initial);
  const entries = allEntries(await aliases.loadState());
  const chosen = entries.find((entry) => entry.oauthChannel);
  const args = await editArgs(chosen, { effort: "high", fast: true });
  f.state["api-keys"].codex.reverse();
  f.state["api-keys"].codex[1].models.reverse();
  const reordered = allEntries(await aliases.loadState());
  assert.deepEqual(reordered.map((row) => row.mappingId).sort(), entries.map((row) => row.mappingId).sort());
  await aliases.createAlias(args);
  const shared = allEntries(await aliases.loadState()).filter((row) => row.alias === "shared");
  assert.ok(shared.filter((row) => row.protocol === "codex").every((row) => row.effort === "high" && row.serviceTier === "priority"));
  assert.ok(shared.filter((row) => row.protocol === "openai").every((row) => row.effort === null && !row.serviceTier));
  await assert.rejects(aliases.deleteAlias({ alias: chosen.alias, mappingId: chosen.mappingId }), /revision is required/);
  await aliases.deleteAlias({ alias: "private" });
  assert.equal(f.state["api-keys"].codex[1].keys[2].models.length, 0);
});

test("Ultra Fast alias round-trips separately from Fast and Standard removes only its speed override", async t => {
  fixture(t, base());
  let entry = allEntries(await aliases.loadState()).find(row => row.alias === "private");
  await aliases.createAlias(await editArgs(entry, { serviceTier: "ultrafast", fast: false }));
  entry = allEntries(await aliases.loadState()).find(row => row.alias === "private");
  assert.equal(entry.serviceTier, "ultrafast");
  const context = await aliases.getEditContext(entry); assert.equal(context.serviceTier, "ultrafast");
  await aliases.createAlias(await editArgs(entry, { serviceTier: "priority" }));
  entry = allEntries(await aliases.loadState()).find(row => row.alias === "private"); assert.equal(entry.serviceTier, "priority");
  await aliases.createAlias(await editArgs(entry, { serviceTier: "", effort: "high" }));
  const state = await aliases.loadState();
  assert.equal(state.speedEntries.some(row => row.alias === "private"), false);
  assert.equal(state.thinkingEntries.find(row => row.alias === "private").effort, "high");
});
