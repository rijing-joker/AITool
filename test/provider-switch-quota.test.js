"use strict";

// Tests for the provider quota layer (cc-switch coding_plan port, 793e67d):
// Command Code preset registration, credential resolution from provider rows,
// base-URL detection, the /alpha query pipeline with a stubbed fetch, and the
// /api/provider-switch/quota route.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");

const { PRESETS } = require("../src/lib/provider-switch/presets");
const quota = require("../src/lib/provider-switch/quota");
const providerSwitchApi = require("../src/lib/provider-switch/api");

let tmpHome;
let prevHome;
let prevUserProfile;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-quota-home-"));
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
  quota.clearQuotaCache();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// HTTP harness (same shape as provider-switch.test.js)
// ---------------------------------------------------------------------------

function makeReq({ method = "GET", url, headers = {}, body } = {}) {
  const base = Readable.from(body != null ? [Buffer.from(body)] : []);
  base.method = method;
  base.url = url;
  base.headers = { host: "localhost", ...headers };
  return base;
}

function makeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body == null ? null : JSON.parse(body);
    },
  };
  return res;
}

async function call(url, options = {}) {
  const req = makeReq({ url, ...options });
  const res = makeRes();
  const handled = await providerSwitchApi.handleProviderSwitchApiRequest(req, res, new URL(`http://localhost${url}`), {
    isAuthorizedLocalMutation: () => true,
  });
  return { handled, status: res.statusCode, body: res.body };
}

// ---------------------------------------------------------------------------
// Fetch stub shaped like the /alpha control plane
// ---------------------------------------------------------------------------

const FIXTURE = {
  whoami: { org: { id: "org-1" } },
  credits: {
    credits: { monthlyCredits: 1000, purchasedCredits: 200, freeCredits: 100, planId: "individual-pro-v1" },
    windowLimits: {
      limited: true,
      fiveHour: { used: 30, cap: 100, resetAt: 1767225600000 },
      weekly: { used: 400, cap: 1000, resetAt: 1767830400000 },
    },
  },
  subscriptions: { data: { planId: "individual-pro-v1", status: "active", currentPeriodStart: "2026-10-01T00:00:00Z", currentPeriodEnd: "2026-11-01T00:00:00Z" } },
  summary: { totalCost: 300 },
};

function stubFetch(responses, calls = []) {
  return async (url) => {
    calls.push(url);
    const path = new URL(url).pathname;
    if (path.endsWith("/whoami")) return json(200, responses.whoami);
    if (path.endsWith("/billing/credits")) return json(responses.creditsStatus ?? 200, responses.credits);
    if (path.endsWith("/billing/subscriptions")) return json(200, responses.subscriptions);
    if (path.endsWith("/usage/summary")) return json(200, responses.summary);
    return json(404, { error: "not found" });
  };
}

function json(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

const CLAUDE_ROW = {
  id: "p_cc",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://api.commandcode.ai/provider",
      ANTHROPIC_AUTH_TOKEN: "sk-relay-key",
    },
  },
};

const CODEX_ROW = {
  id: "p_ccx",
  settingsConfig: {
    auth: { OPENAI_API_KEY: "sk-relay-key" },
    config: {
      model_provider: "command_code",
      model_providers: { command_code: { base_url: "https://api.commandcode.ai/provider/v1" } },
    },
  },
};

test("Command Code presets are registered for claude and codex", () => {
  const claude = PRESETS.claude.find((preset) => preset.id === "claude_commandcode");
  assert.ok(claude, "claude_commandcode preset exists");
  assert.equal(claude.settingsConfig.env.ANTHROPIC_BASE_URL, "https://api.commandcode.ai/provider");
  assert.equal(claude.settingsConfig.env.ANTHROPIC_MODEL, "deepseek/deepseek-v4.1-flash");
  assert.deepEqual(claude.endpointCandidates, ["https://api.commandcode.ai/provider"]);
  assert.equal(claude.modelsUrl, "https://api.commandcode.ai/provider/v1/models");

  const codex = PRESETS.codex.find((preset) => preset.id === "codex_commandcode");
  assert.ok(codex, "codex_commandcode preset exists");
  // The provider block must live in the `custom` slot — the projection
  // pipeline (projectCodex/floor CODEX_PROVIDER_TABLE) owns only
  // [model_providers.custom] and injects the relay key there.
  assert.equal(codex.settingsConfig.config.model_provider, "custom");
  assert.equal(
    codex.settingsConfig.config.model_providers.custom.base_url,
    "https://api.commandcode.ai/provider/v1",
  );
  assert.equal(codex.settingsConfig.config.model_providers.custom.wire_api, "responses");
});

test("credentials resolve per app and base URLs detect the Command Code provider", () => {
  const claude = quota.resolveProviderCredential("claude", CLAUDE_ROW);
  assert.deepEqual(claude, { baseUrl: "https://api.commandcode.ai/provider", apiKey: "sk-relay-key" });
  const codex = quota.resolveProviderCredential("codex", CODEX_ROW);
  assert.deepEqual(codex, { baseUrl: "https://api.commandcode.ai/provider/v1", apiKey: "sk-relay-key" });
  // Codex relays may ride the key as experimental_bearer_token instead of auth.
  const bearerRow = {
    settingsConfig: {
      auth: null,
      config: {
        model_provider: "custom",
        model_providers: { custom: { base_url: "https://api.commandcode.ai/provider/v1", experimental_bearer_token: "sk-bearer" } },
      },
    },
  };
  assert.equal(quota.resolveProviderCredential("codex", bearerRow).apiKey, "sk-bearer");

  assert.equal(quota.detectQuotaProvider(claude.baseUrl, "claude").id, "command_code");
  assert.equal(quota.detectQuotaProvider(codex.baseUrl, "codex").id, "command_code");
  assert.equal(quota.detectQuotaProvider("https://api.deepseek.com/anthropic", "claude"), null);
  assert.equal(quota.detectQuotaProvider(claude.baseUrl, "gemini"), null, "app scope limits detection");
});

test("queries whoami → credits/subscriptions → summary and parses rolling + monthly tiers", async () => {
  const calls = [];
  const result = await quota.queryProviderQuota({
    app: "claude",
    provider: CLAUDE_ROW,
    fetchImpl: stubFetch(FIXTURE, calls),
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "command_code");
  assert.equal(result.credentialStatus, "valid");
  assert.equal(result.plan, "Pro");
  assert.deepEqual(result.tiers.map((tier) => [tier.id, tier.used_percent]), [
    ["five_hour", 30],
    ["weekly", 40],
    ["monthly", 300 / 1600 * 100],
  ]);
  assert.equal(result.tiers.at(-1).reset_at, "2026-11-01T00:00:00Z");
  assert.deepEqual(result.credits, { monthly: 1000, purchased: 200, free: 100, spent: 300 });
  assert.ok(calls.some((url) => url.includes("/alpha/whoami?limits=1")), "whoami carries limits=1");
  assert.ok(calls.some((url) => url.includes("orgId=org-1")), "billing calls carry the org");
  assert.ok(calls.some((url) => url.includes("since=2026-10-01T00")), "summary is scoped to the period");
});

test("results cache for a minute and nocache re-queries", async () => {
  const calls = [];
  const fetchImpl = stubFetch(FIXTURE, calls);
  await quota.queryProviderQuota({ app: "claude", provider: CLAUDE_ROW, fetchImpl });
  const afterFirst = calls.length;
  await quota.queryProviderQuota({ app: "claude", provider: CLAUDE_ROW, fetchImpl });
  assert.equal(calls.length, afterFirst, "second query is served from cache");
  await quota.queryProviderQuota({ app: "claude", provider: CLAUDE_ROW, fetchImpl, bypassCache: true });
  assert.ok(calls.length > afterFirst, "bypassCache re-queries the control plane");
});

test("401 maps to an expired credential and missing keys short-circuit", async () => {
  const result = await quota.queryProviderQuota({
    app: "claude",
    provider: CLAUDE_ROW,
    fetchImpl: stubFetch({ creditsStatus: 401, whoami: FIXTURE.whoami, credits: null, subscriptions: FIXTURE.subscriptions, summary: FIXTURE.summary }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.credentialStatus, "expired");

  const keyless = await quota.queryProviderQuota({
    app: "claude",
    provider: { id: "p", settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://api.commandcode.ai/provider" } } },
    fetchImpl: stubFetch(FIXTURE),
  });
  assert.equal(keyless.ok, false);
  assert.equal(keyless.error, "provider row has no API key");
});

test("GET /api/provider-switch/quota annotates the list and serves the query", async () => {
  const save = await call("/api/provider-switch/providers", {
    method: "POST",
    body: JSON.stringify({
      app: "claude",
      name: "CC Relay",
      category: "custom",
      settingsConfig: CLAUDE_ROW.settingsConfig,
      notes: "",
      websiteUrl: "https://commandcode.ai",
      icon: "square-terminal",
      iconColor: "blue",
    }),
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  const id = save.body.provider.id;

  const list = await call("/api/provider-switch/providers?app=claude");
  const row = list.body.providers.find((provider) => provider.id === id);
  assert.equal(row.quotaProvider, "command_code", "list rows carry the detected quota provider");

  // Reorder must re-annotate: the page's handleDragEnd replaces its rows
  // with this response wholesale, so quotaProvider has to survive the drag.
  const reordered = await call("/api/provider-switch/providers/reorder", {
    method: "POST",
    body: JSON.stringify({ app: "claude", orderedIds: [id] }),
  });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  const reorderedRow = reordered.body.providers.find((provider) => provider.id === id);
  assert.equal(reorderedRow.quotaProvider, "command_code", "reorder rows keep the quota provider annotation");

  // The route resolves fetchImpl lazily (global fetch); stub it so the test
  // is deterministic and never touches the real control plane. A 401 on
  // whoami maps to the expired-credential envelope.
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 401, ok: false, json: async () => ({ error: "unauthorized" }) });
  const queried = await call(`/api/provider-switch/quota?app=claude&id=${id}`);
  globalThis.fetch = previousFetch;
  assert.equal(queried.status, 200);
  assert.equal(queried.body.ok, true);
  assert.equal(queried.body.quota.ok, false, "auth failure degrades to an error envelope");
  assert.equal(queried.body.quota.credentialStatus, "expired", "401 maps to the expired credential status");
  assert.ok(queried.body.quota.error);
});

test("codex_commandcode preset projects end-to-end through the custom slot pipeline", () => {
  // The Codex projection owns [model_providers.custom] exclusively; a preset
  // using an arbitrary slot name would switch to a dangling model_provider
  // pointer with no table and no credentials (code-review catch).
  const targets = require("../src/lib/provider-switch/targets");
  const codexPreset = PRESETS.codex.find((preset) => preset.id === "codex_commandcode");
  const providerRow = {
    category: "custom",
    settingsConfig: JSON.parse(JSON.stringify(codexPreset.settingsConfig)),
  };
  providerRow.settingsConfig.auth.OPENAI_API_KEY = "sk-relay-key";

  const out = targets.projectCodex({
    prev: null,
    target: providerRow,
    liveToml: 'notify = ["bash", "/hooks/notify.sh"]\n',
    liveAuth: {},
  });
  assert.match(out.configToml, /model_provider = "custom"/);
  assert.match(out.configToml, /\[model_providers\.custom\]/);
  assert.match(out.configToml, /base_url = "https:\/\/api\.commandcode\.ai\/provider\/v1"/);
  assert.match(out.configToml, /wire_api = "responses"/);
  assert.match(out.configToml, /experimental_bearer_token = "sk-relay-key"/, "the relay key lands in the custom route table");
  assert.match(out.configToml, /notify = \["bash", "\/hooks\/notify\.sh"\]/, "user content survives");
});
