"use strict";
// Kimi Code integration tests: native config engine, official OAuth manager,
// provider-switch API wiring, and the CLI session reader.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const kimi = require("../src/lib/provider-switch/kimi");
const kimiAccounts = require("../src/lib/provider-switch/kimi-accounts");

let tmpHome;
let prevHome;
let prevKimiHome;

test.beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-kimi-home-"));
  prevHome = process.env.HOME;
  prevKimiHome = process.env.KIMI_CODE_HOME;
  process.env.HOME = tmpHome;
  process.env.KIMI_CODE_HOME = path.join(tmpHome, ".kimi-code");
});

test.afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = prevKimiHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const kimiHome = () => process.env.KIMI_CODE_HOME;
const configPath = () => path.join(kimiHome(), "config.toml");
const writeConfig = async (doc) => {
  await fsp.mkdir(kimiHome(), { recursive: true });
  await fsp.writeFile(configPath(), kimi.serializeDocument(doc));
};

function openaiRow(overrides = {}) {
  return {
    provider: { type: "openai", base_url: "https://api.moonshot.cn/v1", api_key: "sk-test", ...overrides.provider },
    models: {
      "relay/kimi-k3": { model: "kimi-k3", max_context_size: 262144, provider: overrides.slotKey || "relay" },
    },
    ...(overrides.create !== undefined ? { create: overrides.create } : {}),
  };
}

test("kimi engine: setProvider writes the node without moving default_model; useProvider selects a model", async () => {
  await writeConfig({
    providers: { other: { type: "openai", base_url: "https://example.com/v1", api_key: "k" } },
    models: { "other/m": { model: "m", max_context_size: 8192, provider: "other" } },
    default_model: "other/m",
  });
  await kimi.setProvider("relay", openaiRow());
  const doc = await kimi.readDocument();
  assert.equal(doc.providers.relay.type, "openai");
  assert.equal(doc.models["relay/kimi-k3"].provider, "relay");
  assert.equal(doc.default_model, "other/m", "adding never changes the selected model");
  await kimi.useProvider("relay", openaiRow());
  const switched = await kimi.readDocument();
  assert.equal(switched.default_model, "relay/kimi-k3");
  assert.equal(kimi.currentProviderKey(switched), "relay");
});

test("kimi engine: validation rejects bad protocols, missing keys and empty models", () => {
  assert.throws(() => kimi.validateProviderRow("x", { provider: { type: "bogus" }, models: { a: { model: "a", max_context_size: 1, provider: "x" } } }), /provider type/);
  assert.throws(() => kimi.validateProviderRow("x", { provider: { type: "openai", base_url: "https://e.com" }, models: { a: { model: "a", max_context_size: 1, provider: "x" } } }), /API key/);
  assert.throws(() => kimi.validateProviderRow("x", { provider: { type: "openai", base_url: "https://e.com", api_key: "k" }, models: {} }), /at least one/);
  assert.throws(() => kimi.validateProviderRow("x", { provider: { type: "openai", base_url: "https://e.com", api_key: "k" }, models: { a: { model: "a", max_context_size: 0, provider: "x" } } }), /context size/);
});

test("kimi engine: model aliases are globally unique and removal refuses in-use providers", async () => {
  await writeConfig({
    providers: { a: { type: "openai", base_url: "https://a.com/v1", api_key: "k" } },
    models: { shared: { model: "m", max_context_size: 8192, provider: "a" } },
    default_model: "shared",
  });
  await assert.rejects(kimi.setProvider("b", {
    provider: { type: "openai", base_url: "https://b.com/v1", api_key: "k" },
    models: { shared: { model: "m", max_context_size: 8192, provider: "b" } },
  }), /belongs to another provider/);
  await assert.rejects(kimi.removeProvider("a"), /in use/);
  const doc = await kimi.readDocument();
  delete doc.default_model;
  await fsp.writeFile(configPath(), kimi.serializeDocument(doc));
  await kimi.removeProvider("a");
  const after = await kimi.readDocument();
  assert.equal(after.providers.a, undefined);
  assert.equal(after.models.shared, undefined);
});

test("kimi engine: official nodes are protected from provider CRUD and removable only via the account manager", async () => {
  await writeConfig({
    providers: { "managed:kimi-code": { type: "kimi", base_url: "https://api.kimi.com/coding/v1", api_key: "", oauth: { key: "oauth/kimi-code" } } },
    models: { "kimi-code/k3": { model: "k3", max_context_size: 262144, provider: "managed:kimi-code" } },
    default_model: "kimi-code/k3",
  });
  await assert.rejects(kimi.setProvider("managed:kimi-code", openaiRow()), /account center/);
  await assert.rejects(kimi.removeProvider("managed:kimi-code"), /account center/);
  assert.equal(kimi.officialProviderName("managed:kimi-code", null), "Kimi Official");
  assert.equal(kimi.officialProviderName("Kimi Subscription Ada", null), "Kimi Official · Ada");
});

test("kimi engine: saveOauthLogin merges the catalog, keeps user fields, adds services and rolls back on credential failure", async () => {
  await writeConfig({
    providers: { "managed:kimi-code": { type: "kimi", base_url: "https://api.kimi.com/coding/v1", api_key: "", oauth: { key: "oauth/kimi-code" }, custom_headers: { x: "1" } } },
    models: { "kimi-code/k3": { model: "k3", max_context_size: 262144, provider: "managed:kimi-code", overrides: { capabilities: ["custom_cap"] } } },
  });
  const credentialPath = path.join(kimiHome(), "credentials", "kimi-code.json");
  await kimi.saveOauthLogin({
    accountId: "managed:kimi-code",
    credentialPath,
    credential: { access_token: "a", refresh_token: "r", expires_at: 1, expires_in: 3600 },
    baseUrl: "https://api.kimi.com/coding/v1",
    oauth: { key: "oauth/kimi-code" },
    models: { "kimi-code/k3": { provider: "managed:kimi-code", model: "k3", max_context_size: 131072, capabilities: ["tool_use"] } },
  });
  const doc = await kimi.readDocument();
  assert.equal(doc.providers["managed:kimi-code"].custom_headers.x, "1", "user fields survive re-login");
  assert.equal(doc.models["kimi-code/k3"].max_context_size, 131072, "catalog fields are re-owned");
  assert.equal(doc.models["kimi-code/k3"].overrides.capabilities[0], "custom_cap", "overrides survive");
  assert.equal(doc.services.moonshot_search.base_url, "https://api.kimi.com/coding/v1/search");
  assert.equal(doc.default_model, "kimi-code/k3");
  const stored = JSON.parse(await fsp.readFile(credentialPath, "utf8"));
  assert.equal(stored.refresh_token, "r");
  // Credential write failure restores the config byte for byte.
  const before = await fsp.readFile(configPath(), "utf8");
  await assert.rejects(kimi.saveOauthLogin({
    accountId: "managed:kimi-code",
    credentialPath: path.join(kimiHome(), "credentials", "sub", "..", "..", "config.toml"),
    credential: { access_token: "a", refresh_token: "r", expires_at: 1, expires_in: 3600 },
    baseUrl: "https://api.kimi.com/coding/v1",
    oauth: { key: "oauth/kimi-code" },
    models: { "kimi-code/k9": { provider: "managed:kimi-code", model: "k9", max_context_size: 131072, capabilities: [] } },
  }));
  assert.equal(await fsp.readFile(configPath(), "utf8"), before, "config restored after a failed credential save");
});

test("kimi engine: removeOauthAccount repoints services at the default login", async () => {
  const oauth = { storage: "file", key: "oauth/kimi-code-ccs-abcdef12", oauth_host: "https://auth.kimi.com" };
  await writeConfig({
    providers: {
      "managed:kimi-code": { type: "kimi", base_url: "https://api.kimi.com/coding/v1", api_key: "", oauth: { key: "oauth/kimi-code" } },
      "Kimi Subscription Ada": { type: "kimi", base_url: "https://api.kimi.com/coding/v1", api_key: "", oauth },
    },
    models: {
      "kimi-code/k3": { model: "k3", max_context_size: 1, provider: "managed:kimi-code" },
      "kimi-code-ccs-abcdef12/k3": { model: "k3", max_context_size: 1, provider: "Kimi Subscription Ada" },
    },
    default_model: "kimi-code/k3",
    services: { moonshot_search: { base_url: "https://api.kimi.com/coding/v1/search", api_key: "", oauth } },
  });
  await kimi.removeOauthAccount("Kimi Subscription Ada");
  const doc = await kimi.readDocument();
  assert.equal(doc.providers["Kimi Subscription Ada"], undefined);
  assert.equal(doc.models["kimi-code-ccs-abcdef12/k3"], undefined);
  assert.equal(doc.services.moonshot_search.oauth.key, "oauth/kimi-code", "services fall back to the default login");
});

// ---------------------------------------------------------------------------
// OAuth manager (device flow against a mocked official API)
// ---------------------------------------------------------------------------

function mockKimiApi({ user = "u1", nickname = "Ada" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, method: init?.method || "GET", body: String(init?.body || "") });
    const json = (payload, status = 200) => ({ status, ok: status < 300, json: async () => payload });
    if (target.endsWith("/api/oauth/device_authorization")) {
      const host = target.includes("auth.kimi.ai") ? "https://auth.kimi.ai" : "https://auth.kimi.com";
      return json({ device_code: "dev", user_code: "ABCD-EFGH", verification_uri_complete: `${host}/verify?user_code=ABCD-EFGH`, expires_in: 600, interval: 1 });
    }
    if (target.endsWith("/api/oauth/token")) {
      if (String(init?.body || "").includes("grant_type=refresh_token")) return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
      return json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, token_type: "Bearer", scope: "" });
    }
    if (target.endsWith("/me")) return json({ user_id: user, nickname, avatar: "" });
    if (target.endsWith("/models")) {
      return json({ data: [{ id: "k3", limit: { context: 262144 }, supports_tool_use: true, display_name: "K3", reasoning: { type: "both" } }] });
    }
    if (target.endsWith("/usages")) {
      return json({ limits: [{ detail: { limit: 100, remaining: 25, resetTime: "2026-10-24T00:00:00Z" } }], usage: { limit: 1000, remaining: 900 } });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
  return { fetchImpl, calls };
}

function manager(options = {}) {
  return kimiAccounts.createManager({
    root: path.join(tmpHome, ".aitool", "provider-switch"),
    home: kimiHome(),
    fetchImpl: options.fetchImpl,
    platform: "darwin",
    now: options.now || Date.now,
  });
}

async function completeLogin(accounts, { region = "cn", accountId = null } = {}) {
  const flow = await accounts.startLogin(region, accountId);
  for (let i = 0; i < 6; i += 1) {
    const result = await accounts.pollLogin(flow.flowId);
    if (result.status !== "pending") return result;
  }
  throw new Error("login did not complete");
}

test("kimi accounts: first login takes the default slot, models are scoped, quota refreshes near expiry", async () => {
  const mock = mockKimiApi();
  const accounts = manager({ fetchImpl: mock.fetchImpl });
  let clock = Date.parse("2026-10-24T00:00:00Z");
  const accounts2 = kimiAccounts.createManager({
    root: path.join(tmpHome, ".aitool", "provider-switch"),
    home: kimiHome(),
    fetchImpl: mock.fetchImpl,
    platform: "darwin",
    now: () => clock,
  });
  const flow = await accounts2.startLogin("cn");
  let result = { status: "pending" };
  for (let i = 0; i < 6 && result.status === "pending"; i += 1) result = await accounts2.pollLogin(flow.flowId);
  assert.equal(result.status, "success");
  const doc = await kimi.readDocument();
  assert.equal(doc.providers["managed:kimi-code"].type, "kimi");
  assert.equal(doc.models["kimi-code/k3"].capabilities.includes("thinking"), true);
  assert.equal(doc.models["kimi-code/k3"].max_context_size, 262144);
  const status = await accounts2.status();
  assert.equal(status.accounts.length, 1);
  assert.equal(status.accounts[0].nickname, "Ada");
  assert.equal(status.accounts[0].primary, true);
  assert.equal(status.currentAccountId, "managed:kimi-code");
  // Expired access token: quota refreshes under the slot lock and succeeds.
  clock = Date.parse("2026-10-24T04:00:00Z");
  const quota = await accounts2.quota("managed:kimi-code");
  assert.equal(quota.credentialStatus, "valid");
  assert.equal(quota.tiers.length, 2);
  assert.equal(quota.tiers[0].id, "five_hour");
  assert.equal(Math.round(quota.tiers[0].usedPercent), 75);
  const refreshed = JSON.parse(await fsp.readFile(path.join(kimiHome(), "credentials", "kimi-code.json"), "utf8"));
  assert.equal(refreshed.access_token, "access-2", "the rotated token is persisted");
});

test("kimi accounts: a second account gets a stable separate slot and readable id; re-login keeps it", async () => {
  const mock = mockKimiApi();
  const accounts = manager({ fetchImpl: mock.fetchImpl });
  assert.equal((await completeLogin(accounts, { region: "cn" })).status, "success");
  const second = mockKimiApi({ user: "u2", nickname: "Bo" });
  const accounts2 = manager({ fetchImpl: second.fetchImpl });
  assert.equal((await completeLogin(accounts2, { region: "cn" })).status, "success");
  const doc = await kimi.readDocument();
  const ids = Object.keys(doc.providers);
  assert.ok(ids.includes("Kimi Subscription Bo"), `readable provider id, got ${ids}`);
  const suffix = kimiAccounts.accountSuffix("cn", "u2");
  assert.equal(doc.providers["Kimi Subscription Bo"].oauth.key, `oauth/kimi-code-ccs-${suffix}`);
  assert.equal(doc.models[`kimi-code-ccs-${suffix}/k3`].provider, "Kimi Subscription Bo");
  assert.equal(doc.models[`kimi-code-ccs-${suffix}/k3`].display_name, "K3 (Bo)");
  // Re-login as the same user keeps the account in place (no third provider).
  const again = mockKimiApi({ user: "u2", nickname: "Bo" });
  const accounts3 = manager({ fetchImpl: again.fetchImpl });
  assert.equal((await completeLogin(accounts3, { region: "cn" })).status, "success");
  const finalDoc = await kimi.readDocument();
  assert.equal(Object.keys(finalDoc.providers).length, 2, "the same account signs in again in place");
  // Use account 2, then removing it is refused while current; removing the
  // default only hides it from the list.
  await accounts3.useAccount("Kimi Subscription Bo");
  await assert.rejects(accounts3.remove("Kimi Subscription Bo"), /in use/);
  const dismissed = await accounts3.remove("managed:kimi-code");
  assert.equal(dismissed.dismissed, true);
  const status = await accounts3.status();
  assert.deepEqual(status.accounts.map(row => row.id), ["Kimi Subscription Bo"]);
});

test("kimi accounts: global region uses its own hosts and never falls back across regions", async () => {
  const mock = mockKimiApi({ user: "g1", nickname: "G" });
  const accounts = manager({ fetchImpl: mock.fetchImpl });
  const flow = await accounts.startLogin("global");
  assert.equal(flow.verificationUri.startsWith("https://auth.kimi.ai/"), true);
  let result = { status: "pending" };
  for (let i = 0; i < 6 && result.status === "pending"; i += 1) result = await accounts.pollLogin(flow.flowId);
  assert.equal(result.status, "success");
  assert.ok(mock.calls.every(call => !call.url.includes("auth.kimi.com")), "no cross-region fallback");
  const doc = await kimi.readDocument();
  assert.equal(doc.providers["managed:kimi-code"].base_url, "https://api.kimi.ai/coding/v1");
});

// ---------------------------------------------------------------------------
// Provider-switch API wiring
// ---------------------------------------------------------------------------

test("kimi api: save/switch/delete provider rows through the provider-switch handler", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const handler = handleProviderSwitchApiRequest;
  const { Readable } = require("node:stream");
  const makeReq = ({ method = "GET", url, body }) => {
    const base = Readable.from(body != null ? [Buffer.from(body)] : []);
    base.method = method;
    base.url = url;
    base.headers = { host: "localhost" };
    return base;
  };
  const makeRes = () => ({
    statusCode: null,
    body: null,
    writeHead(status) { this.statusCode = status; },
    end(payload) { this.body = payload ? String(payload) : ""; },
  });
  const call = async (options) => {
    const req = makeReq(options);
    const res = makeRes();
    const handled = await handler(req, res, new URL(`http://localhost${options.url}`), { isAuthorizedLocalMutation: () => true });
    assert.equal(handled, true);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const created = await call({
    method: "POST",
    url: "/api/provider-switch/providers",
    body: JSON.stringify({
      app: "kimi",
      name: "Relay",
      category: "custom",
      settingsConfig: { slotKey: "relay", provider: { type: "openai", base_url: "https://api.moonshot.cn/v1", api_key: "sk-1" }, models: { "relay/kimi-k3": { model: "kimi-k3", max_context_size: 262144 } } },
    }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const doc = await kimi.readDocument();
  assert.equal(doc.providers.relay.api_key, "sk-1");
  assert.equal(doc.models["relay/kimi-k3"].provider, "relay", "the save path stamps model.provider");
  const listed = await call({ method: "GET", url: "/api/provider-switch/providers?app=kimi" });
  assert.equal(listed.body.providers.length, 1);
  const rowId = listed.body.providers[0].id;
  const switched = await call({ method: "POST", url: "/api/provider-switch/switch", body: JSON.stringify({ app: "kimi", id: rowId }) });
  assert.equal(switched.status, 200);
  assert.equal((await kimi.readDocument()).default_model, "relay/kimi-k3");
  const busy = await call({ method: "DELETE", url: `/api/provider-switch/providers/${rowId}?app=kimi` });
  assert.equal(busy.status, 400, "removing the current provider is refused while the row survives");
  assert.equal((await kimi.readDocument()).providers.relay.api_key, "sk-1");
  const disconnected = await call({ method: "POST", url: "/api/provider-switch/switch", body: JSON.stringify({ app: "kimi", id: "" }) });
  assert.equal(disconnected.status, 200);
  const docAfterDisconnect = await kimi.readDocument();
  assert.equal(docAfterDisconnect.providers.relay, undefined, "disconnecting removes the live node");
  assert.equal(docAfterDisconnect.default_model, undefined);
  const removed = await call({ method: "DELETE", url: `/api/provider-switch/providers/${rowId}?app=kimi` });
  assert.equal(removed.status, 200);
  const after = await kimi.readDocument();
  assert.equal(after.providers.relay, undefined, "deleting the card removes the native node");
  assert.equal(after.models["relay/kimi-k3"], undefined);
});

// ---------------------------------------------------------------------------
// CLI session reader
// ---------------------------------------------------------------------------

test("kimi sessions: state metadata + committed wire projection with branch hiding", async () => {
  const sessionDir = path.join(kimiHome(), "sessions", "wd_project", "session-1", "agents", "main");
  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.writeFile(path.join(path.dirname(path.dirname(sessionDir)), "state.json"), JSON.stringify({
    title: "Project", lastPrompt: "Fix this", cwd: "/project", createdAt: 1700000000000, updatedAt: 1700000001000,
  }));
  await fsp.writeFile(path.join(sessionDir, "wire.jsonl"), [
    JSON.stringify({ type: "context.append_loop_event", event: { type: "step.begin", uuid: "s1", turnId: "0", step: 1 } }),
    JSON.stringify({ type: "llm.request", agentId: "main", kind: "loop", turnStep: "0.1", model: "actual-model" }),
    JSON.stringify({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "legacy duplicate" }] } }),
    JSON.stringify({ type: "agent.message.appended", message: { message: { role: "user", content: [{ type: "text", text: "Fix this" }] } } }),
    JSON.stringify({ type: "agent.message.appended", message: { message: { role: "assistant", content: [{ type: "text", text: "Done" }, { type: "think", think: "reasoning" }], toolCalls: [] }, meta: { messageId: "m1", model: { model: "agent-loop" }, usage: { inputOther: 10, output: 20, inputCacheRead: 30, inputCacheCreation: 0 } } } }),
    JSON.stringify({ type: "context.append_loop_event", event: { type: "step.end", uuid: "s1", messageId: "m1", llmFirstTokenLatencyMs: 1000, llmStreamDurationMs: 9000 } }),
  ].join("\n"));
  const sources = require("../src/lib/session-sources");
  const validate = async () => {};
  const listed = await sources.list("kimi", tmpHome, { KIMI_CODE_HOME: kimiHome() }, validate);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, "Project");
  assert.equal(listed[0].projectDir, "/project");
  assert.equal(listed[0].resumeCommand.includes("kimi --session session-1"), true);
  const read = await sources.read("kimi", listed[0].sourcePath, validate);
  assert.deepEqual(read.messages.map(row => row.role), ["user", "assistant"]);
  assert.equal(read.messages[0].content, "Fix this", "committed projection wins over the legacy stream");
  assert.equal(read.messages[1].thinking, "reasoning");
  assert.equal(read.messages[1].model, "actual-model", "the loop request resolves the real model");
  assert.equal(read.messages[1].usage.inputTokens, 10);
  assert.equal(read.usage.inputTokens, 10);
  assert.equal(read.usage.cacheReadTokens, 30);
});

test("kimi sessions: branch switches hide abandoned turns", async () => {
  const sessionDir = path.join(kimiHome(), "sessions", "wd", "session-2", "agents", "main");
  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.writeFile(path.join(path.dirname(path.dirname(sessionDir)), "state.json"), JSON.stringify({ cwd: "/p" }));
  const message = text => JSON.stringify({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text }] } });
  await fsp.writeFile(path.join(sessionDir, "wire.jsonl"), [
    message("keep"),
    message("undone"),
    JSON.stringify({ type: "agent.switched", branch: "fork", base: { branch: "main", line: 1 } }),
    message("replacement"),
  ].join("\n"));
  const sources = require("../src/lib/session-sources");
  const validate = async () => {};
  const read = await sources.read("kimi", path.join(sessionDir, "wire.jsonl"), validate);
  assert.deepEqual(read.messages.map(row => row.content), ["keep", "replacement"]);
});

// ---------------------------------------------------------------------------
// MCP projection
// ---------------------------------------------------------------------------

test("kimi mcp: stdio and sse entries round-trip through mcp.json", async () => {
  const mcp = require("../src/lib/provider-switch/mcp");
  const file = path.join(kimiHome(), "mcp.json");
  await fsp.mkdir(kimiHome(), { recursive: true });
  await mcp.upsertServer({ id: "fetch", name: "fetch", apps: { kimi: true }, server: { command: "node", args: ["fetch.js"], env: { A: "1" } } });
  await mcp.upsertServer({ id: "remote", name: "remote", apps: { kimi: true }, server: { url: "https://mcp.example/sse", type: "sse" } });
  const doc = JSON.parse(await fsp.readFile(file, "utf8"));
  assert.deepEqual(doc.mcpServers.fetch, { command: "node", args: ["fetch.js"], env: { A: "1" } });
  assert.deepEqual(doc.mcpServers.remote, { url: "https://mcp.example/sse", transport: "sse" });
  const imported = await mcp.importFromApps(["kimi"]);
  assert.equal(imported.changed >= 0, true);
  await mcp.deleteServer("fetch");
  const after = JSON.parse(await fsp.readFile(file, "utf8"));
  assert.equal(after.mcpServers.fetch, undefined);
  assert.equal(after.mcpServers.remote.transport, "sse");
});
