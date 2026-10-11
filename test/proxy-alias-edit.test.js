"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");

// Alias edits run against the local kernel's management API. Stub that seam
// (plus the model-list HTTP fetch) so the alias-config engine can be exercised
// in-process. node --test runs each file in its own process, so these module
// patches cannot leak into other suites.
const management = require("../src/lib/proxy/management");
const config = require("../src/lib/proxy/config");
const undici = require("undici");

let currentPayload = null;
const writes = [];

management.request = async (method, route, options = {}) => {
  if (method === "GET" && route === "/v8/management/config") {
    return { ok: true, status: 200, data: currentPayload };
  }
  if (method === "PUT" || method === "POST") {
    writes.push({ method, route, body: options.body });
    return { ok: true, status: 200, data: {} };
  }
  return { ok: false, status: 404, data: "not_found", error: "not_found" };
};

config.getServerPort = () => 8081;
undici.request = async () => ({
  statusCode: 200,
  body: {
    text: async () => JSON.stringify({ data: [{ id: "gemini-3-pro" }, { id: "gemini-3-flash" }, { id: "src-one" }, { id: "src-two" }] }),
  },
});

const aliasConfig = require("../src/lib/proxy/alias-config");

// Two rows share each alias on purpose: the ported EasyCLIProxyAPI 209e159
// behavior addresses an edit by the row's (source model, alias) pair at its
// saved position, so duplicate aliases must edit independently.
const freshPayload = () => ({
  oauth: {
    "model-alias": {
      vertex: [
        { name: "gemini-3-pro", alias: "shared", fork: true },
        { name: "gemini-3-flash", alias: "shared", fork: true },
      ],
    },
  },
  "api-keys": {
    "openai-compatibility": [
      {
        name: "provider-one",
        "base-url": "https://example.test/v1",
        "api-key": "sk-test",
        models: [{ name: "src-one", alias: "dup" }, { name: "src-two", alias: "dup" }],
      },
    ],
  },
  requests: { payload: {} },
  access: { "api-keys": ["client-key"] },
});

test("OAuth alias edit-source resolves the row's own channel and source model", async () => {
  currentPayload = freshPayload();
  writes.length = 0;
  const context = await aliasConfig.getEditContext({
    alias: "shared",
    section: "oauth-model-alias",
    providerIndex: null,
    modelIndex: 1,
    oauthChannel: "vertex",
    sourceModel: "gemini-3-flash",
  });
  assert.equal(context.source.model, "gemini-3-flash");
});

test("OAuth alias edit-source still resolves when the client omits the channel", async () => {
  currentPayload = freshPayload();
  const context = await aliasConfig.getEditContext({
    alias: "shared",
    section: "oauth-model-alias",
    providerIndex: null,
    modelIndex: 1,
    oauthChannel: null,
    sourceModel: "gemini-3-flash",
  });
  assert.equal(context.source.model, "gemini-3-flash");
});

test("OAuth alias edit-source re-scans by (source model, alias) and rejects unknown pairs", async () => {
  currentPayload = freshPayload();
  const moved = await aliasConfig.getEditContext({
    alias: "shared",
    section: "oauth-model-alias",
    providerIndex: null,
    modelIndex: 1,
    oauthChannel: "vertex",
    sourceModel: "gemini-3-pro",
  });
  assert.equal(moved.source.model, "gemini-3-pro");
  await assert.rejects(
    aliasConfig.getEditContext({
      alias: "shared",
      section: "oauth-model-alias",
      providerIndex: null,
      modelIndex: 1,
      oauthChannel: "vertex",
      sourceModel: "gemini-9-gone",
    }),
    /Alias row moved or changed/,
  );
});

test("OAuth alias save rewrites the pair-verified row and leaves the sibling duplicate alone", async () => {
  currentPayload = freshPayload();
  writes.length = 0;
  await aliasConfig.createAlias({
    sourceId: "alias-edit:shared",
    alias: "shared-2",
    originalAlias: "shared",
    effort: "",
    fast: false,
    section: "oauth-model-alias",
    providerIndex: null,
    modelIndex: 1,
    oauthChannel: "vertex",
    sourceModel: "gemini-3-flash",
  });
  const put = writes.find((write) => write.route === "/v8/management/config/oauth/model-alias");
  assert.ok(put, "expected the oauth model-alias write");
  assert.deepEqual(put.body.vertex, [
    { name: "gemini-3-pro", alias: "shared", fork: true },
    { name: "gemini-3-flash", alias: "shared-2", fork: true },
  ]);
});

test("Config alias edit-source falls back to the (source model, alias) pair when rows moved", async () => {
  currentPayload = freshPayload();
  const moved = await aliasConfig.getEditContext({
    alias: "dup",
    section: "openai-compatibility",
    providerIndex: 0,
    modelIndex: 1,
    sourceModel: "src-one",
  });
  assert.equal(moved.source.model, "src-one");
});

test("Config alias save with moved rows rewrites the pair-verified row only", async () => {
  currentPayload = freshPayload();
  writes.length = 0;
  await aliasConfig.createAlias({
    sourceId: "alias-edit:dup",
    alias: "dup-2",
    originalAlias: "dup",
    effort: "",
    fast: false,
    section: "openai-compatibility",
    providerIndex: 0,
    modelIndex: 1,
    sourceModel: "src-one",
  });
  const put = writes.find((write) => write.route === "/v8/management/config/api-keys/openai-compatibility");
  assert.ok(put, "expected the api-keys write");
  assert.deepEqual(put.body[0].models, [{ name: "src-one", alias: "dup-2" }, { name: "src-two", alias: "dup" }]);
});

test("OAuth alias delete refuses a position whose source model moved", async () => {
  currentPayload = freshPayload();
  writes.length = 0;
  await assert.rejects(
    aliasConfig.deleteAlias({
      alias: "shared",
      kind: "thinking",
      section: "oauth-model-alias",
      providerIndex: null,
      modelIndex: 1,
      oauthChannel: "vertex",
      sourceModel: "gemini-3-pro",
    }),
    /does not exist/,
  );
  assert.equal(writes.length, 0);
});

test("OAuth alias delete removes exactly the pair-verified duplicate", async () => {
  currentPayload = freshPayload();
  writes.length = 0;
  await aliasConfig.deleteAlias({
    alias: "shared",
    kind: "thinking",
    section: "oauth-model-alias",
    providerIndex: null,
    modelIndex: 1,
    oauthChannel: "vertex",
    sourceModel: "gemini-3-flash",
  });
  const put = writes.find((write) => write.route === "/v8/management/config/oauth/model-alias");
  assert.ok(put, "expected the oauth model-alias write");
  assert.deepEqual(put.body.vertex, [{ name: "gemini-3-pro", alias: "shared", fork: true }]);
});

test("Legacy edit-source without any position still scans by alias", async () => {
  currentPayload = freshPayload();
  const context = await aliasConfig.getEditContext({ alias: "shared" });
  assert.equal(context.source.model, "gemini-3-pro");
});
