const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const paths = require("../src/lib/proxy/paths");
const { handleProxyApiRequest } = require("../src/lib/proxy/api");
const pricing = require("../src/lib/proxy/pricing");
const config = require("../src/lib/proxy/config");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-pricing-test-"));
  const previous = { usageDir: paths.usageDir, bucketsStatePath: paths.bucketsStatePath, pricingPath: paths.pricingPath };
  paths.usageDir = path.join(root, "usage");
  paths.bucketsStatePath = path.join(paths.usageDir, "buckets.json");
  paths.pricingPath = path.join(paths.usageDir, "models-dev-pricing.json");
  fs.mkdirSync(paths.usageDir);
  t.after(() => {
    pricing.__test.clearMemo();
    Object.assign(paths, previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root };
}

function writePricingStore(models, { fetchedAt = Date.now() } = {}) {
  fs.writeFileSync(paths.pricingPath, JSON.stringify({ version: 2, fetchedAt, models }));
  pricing.__test.clearMemo();
}

const MODELS = {
  "claude-sonnet-5": { name: "Claude Sonnet 5", provider: "anthropic", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "gpt-5.2": { name: "GPT-5.2", provider: "openai", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
};

test("normalizeModelId strips vendor prefixes, variants and context markers", () => {
  assert.equal(pricing.normalizeModelId("anthropic/claude-sonnet-5-5[1m]"), "claude-sonnet-5-5");
  assert.equal(pricing.normalizeModelId("gpt-5.2:reasoning"), "gpt-5.2");
  assert.equal(pricing.normalizeModelId("zhipuai/GLM-5.3@preview"), "glm-5.3-preview");
  assert.equal(pricing.normalizeModelId("  Claude-Sonnet-5 "), "claude-sonnet-5");
  assert.equal(pricing.normalizeModelId(""), "");
});

test("flattenModelsDev keeps priced text models and prefers the newest release per id", () => {
  const models = pricing.flattenModelsDev({
    anthropic: {
      models: {
        "claude-sonnet-5": { name: "Claude Sonnet 5", release_date: "2026-09-01", cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }, limit: { context: 200000, output: 64000 } },
        "claude-sonnet-5[1m]": { name: "Claude Sonnet 5 (1M)", release_date: "2026-09-20", cost: { input: 6, output: 22 }, limit: { context: 1000000, output: 64000 }, reasoning_options: [{ type: "effort", values: ["low", "Medium", "bogus"] }, { type: "other", values: ["x"] }] },
        "claude-audio-1": { name: "Claude Audio", cost: { input: 1, output: 2 }, modalities: { output: ["audio"] } },
        "claude-vision-ocr": { name: "Vision OCR", cost: { input: 1, output: 2 } },
        "claude-legacy": { name: "Legacy", status: "deprecated", cost: { input: 1, output: 2 } },
        "claude-unpriced": { name: "Unpriced" },
      },
    },
    reseller: {
      models: {
        "claude-sonnet-5": { name: "Claude Sonnet 5 (resold)", release_date: "2026-08-01", cost: { input: 99, output: 99 } },
      },
    },
  });
  assert.deepEqual([...models.keys()], ["claude-sonnet-5", "claude-vision-ocr"]);
  // Newest release wins on normalized-id collision (the reseller entry loses).
  assert.equal(models.get("claude-sonnet-5").input, 6);
  assert.equal(models.get("claude-sonnet-5").provider, "anthropic");
  // Catalog-fill metadata rides along (v2 store).
  const winner = models.get("claude-sonnet-5");
  assert.equal(winner.contextWindow, 1000000);
  assert.equal(winner.maxOutputTokens, 64000);
  // Effort-type values are kept verbatim (lowercase, deduped); consumers
  // intersect with their own level sets.
  assert.deepEqual(winner.reasoningEfforts, ["low", "medium", "bogus"]);
  assert.equal(models.get("claude-vision-ocr").contextWindow, undefined);
});

test("estimateCostUsd bills fresh input for Claude and cache-inclusive input for OpenAI", () => {
  const claude = pricing.estimateCostUsd(MODELS, "claude-sonnet-5", {
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheCreationTokens: 10,
  });
  assert.equal(claude, (100 * 3 + 50 * 15 + 900 * 0.3 + 10 * 3.75) / 1e6);

  const gpt = pricing.estimateCostUsd(MODELS, "gpt-5.2", {
    inputTokens: 300, outputTokens: 90, cacheReadTokens: 140, cacheCreationTokens: 0,
  });
  assert.equal(gpt, ((300 - 140) * 1.25 + 90 * 10 + 140 * 0.125) / 1e6);

  // Explicit semantics win over the model-name heuristic.
  const explicitInclusive = pricing.estimateCostUsd(MODELS, "claude-sonnet-5", {
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 60, cacheCreationTokens: 0,
  }, { inputInclusive: true });
  assert.equal(explicitInclusive, ((100 - 60) * 3 + 50 * 15 + 60 * 0.3) / 1e6);
});

test("estimateCostUsd returns null for unpriced models and tokenless rows", () => {
  assert.equal(pricing.estimateCostUsd(MODELS, "unknown-model", { inputTokens: 10, outputTokens: 5 }), null);
  assert.equal(pricing.estimateCostUsd(MODELS, "claude-sonnet-5", { inputTokens: 0, outputTokens: 0 }), null);
  assert.equal(pricing.estimateCostUsd(null, "claude-sonnet-5", { inputTokens: 10 }), null);
});

test("pricing store syncs in the background when stale and keeps serving the old index", async (t) => {
  fixture(t);
  writePricingStore(MODELS, { fetchedAt: Date.now() - pricing.PRICING_TTL_MS - 1000 });
  const fetches = [];
  const fetchImpl = async (url) => {
    fetches.push(String(url));
    return { ok: true, status: 200, json: async () => ({ anthropic: { models: { "claude-sonnet-5": { cost: { input: 5, output: 20 } } } } }) };
  };
  const snapshot = await pricing.getPricingSnapshot(paths.pricingPath, { fetchImpl });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.syncing, true);
  assert.equal(snapshot.modelCount, 2);
  // The background sync lands (the explicit call below rejoins it) and the
  // next snapshot is fresh.
  await pricing.syncPricingStore(paths.pricingPath, { fetchImpl });
  const fresh = await pricing.getPricingSnapshot(paths.pricingPath, { fetchImpl });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.modelCount, 1);
  assert.deepEqual(fetches, [pricing.MODELS_DEV_API_URL]);
});

test("a failing or empty models.dev payload never overwrites the store", async (t) => {
  fixture(t);
  writePricingStore(MODELS);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ openai: { models: { "gpt-audio": { cost: { input: 1, output: 2 } } } } }) };
  };
  await assert.rejects(pricing.syncPricingStore(paths.pricingPath, { fetchImpl }));
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.pricingPath, "utf8")).models, MODELS);
  await assert.rejects(pricing.syncPricingStore(paths.pricingPath, { fetchImpl }), /no priced text models/);
  assert.equal(calls, 2);
  const snapshot = await pricing.getPricingSnapshot(paths.pricingPath, { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.modelCount, 2);
});

test("concurrent syncs share one fetch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-pricing-dedup-"));
  const pricingPath = path.join(root, "pricing.json");
  pricing.__test.clearMemo();
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, status: 200, json: async () => ({ openai: { models: { "gpt-5.2": { cost: { input: 1, output: 2 } } } } }) };
  };
  const [a, b] = await Promise.all([
    pricing.syncPricingStore(pricingPath, { fetchImpl }),
    pricing.syncPricingStore(pricingPath, { fetchImpl }),
  ]);
  assert.equal(fetches, 1);
  assert.equal(a.fetchedAt, b.fetchedAt);
  fs.rmSync(root, { recursive: true, force: true });
});

test("records route annotates page rows and stats with costs from the pricing store", async (t) => {
  fixture(t);
  writePricingStore(MODELS);
  const rows = [
    { id: "r1", timestamp: "2026-10-01T08:12:00.000Z", model: "claude-sonnet-5", response_model: "claude-sonnet-5", tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheCreationTokens: 10, totalTokens: 1060 } },
    { id: "r2", timestamp: "2026-10-01T08:13:00.000Z", model: "gpt-5.2", tokens: { inputTokens: 300, outputTokens: 90, cacheReadTokens: 140, totalTokens: 390 } },
    { id: "r3", timestamp: "2026-10-01T08:14:00.000Z", model: "unknown", failed: true, tokens: { totalTokens: 0 } },
  ];
  fs.writeFileSync(
    path.join(paths.usageDir, "records-2026-10-01.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  async function read(query) {
    let payload;
    await handleProxyApiRequest({ method: "GET" }, {
      writeHead(status) { assert.equal(status, 200); },
      end(body) { payload = JSON.parse(body); },
    }, new URL(`http://localhost/api/proxy/usage/records?${query}`), {});
    return payload;
  }
  const result = await read("includeStats=1");
  assert.equal(result.total, 3);
  // Records come back newest-first; locate them by id.
  const byId = new Map(result.records.map((record) => [record.id, record]));
  const r1 = byId.get("r1");
  const r2 = byId.get("r2");
  assert.equal(r1.costUsd, (100 * 3 + 50 * 15 + 900 * 0.3 + 10 * 3.75) / 1e6);
  assert.equal(r2.costUsd, ((300 - 140) * 1.25 + 90 * 10 + 140 * 0.125) / 1e6);
  // The failed row carries no billable tokens and is left untouched.
  assert.equal("costUsd" in byId.get("r3"), false);
  assert.equal(result.stats.total_cost_usd, r1.costUsd + r2.costUsd);
});

test("records route passes records through untouched without a pricing store", async (t) => {
  fixture(t);
  fs.writeFileSync(path.join(paths.usageDir, "records-2026-10-01.jsonl"), JSON.stringify({
    id: "r1", timestamp: "2026-10-01T08:12:00.000Z", model: "claude-sonnet-5",
    tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  }) + "\n");
  // No pricing file exists; the kicked background sync fails offline without
  // affecting the response.
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  let payload;
  await handleProxyApiRequest({ method: "GET" }, {
    writeHead(status) { assert.equal(status, 200); },
    end(body) { payload = JSON.parse(body); },
  }, new URL("http://localhost/api/proxy/usage/records"), {});
  assert.equal(fetchMock.mock.calls.length >= 1, true);
  assert.equal(payload.records.length, 1);
  assert.equal("costUsd" in payload.records[0], false);
});

test("pricing meta route reports sync state without the model index", async (t) => {
  fixture(t);
  const fetchedAt = Date.now();
  writePricingStore(MODELS, { fetchedAt });
  let payload;
  await handleProxyApiRequest({ method: "GET" }, {
    writeHead(status) { assert.equal(status, 200); },
    end(body) { payload = JSON.parse(body); },
  }, new URL("http://localhost/api/proxy/pricing"), {});
  assert.equal(payload.ok, true);
  assert.equal(payload.modelCount, 2);
  assert.equal(payload.fetchedAt, fetchedAt);
  assert.equal(payload.stale, false);
  assert.equal("models" in payload, false);
});

test("heatmap endpoint aggregates per-day tokens, requests and cost", async (t) => {
  fixture(t);
  t.mock.method(Date, "now", () => new Date(2026, 9, 7, 12).getTime());
  writePricingStore({
    "claude-sonnet-5": { name: "Claude Sonnet 5", provider: "anthropic", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  });
  // Two days, one failed row (still counted in requests, not in cost),
  // one row without a timestamp (dropped entirely).
  const rows = [
    { id: "a", timestamp: "2026-10-05T10:00:00Z", model: "claude-sonnet-5", tokens: { totalTokens: 100 }, failed: false },
    { id: "b", timestamp: "2026-10-05T11:00:00Z", model: "claude-sonnet-5", tokens: { totalTokens: 50 }, failed: true },
    { id: "c", timestamp: "2026-10-06T10:00:00Z", model: "claude-sonnet-5", tokens: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, failed: false },
    { id: "d", model: "claude-sonnet-5", tokens: { totalTokens: 999 } },
  ];
  fs.writeFileSync(paths.usageDir + "/records-2026-10-06.jsonl", rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  let payload;
  await handleProxyApiRequest({ method: "GET" }, {
    writeHead(status) { assert.equal(status, 200); },
    end(body) { payload = JSON.parse(body); },
  }, new URL("http://localhost/api/proxy/usage/heatmap"), {});
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.days.map((day) => [day.date, day.requests, day.tokens]), [
    ["2026-10-05", 2, 150],
    ["2026-10-06", 1, 30],
  ]);
  // Cost only on the successful rows: day2 = (10*3 + 20*15)/1e6.
  assert.equal(payload.days[0].costUsd, 0);
  assert.ok(Math.abs(payload.days[1].costUsd - 0.00033) < 1e-9);
});

test("budget and heatmap include their full windows beyond the latest 14 daily files", async (t) => {
  fixture(t);
  const now = new Date(2026, 9, 30, 12).getTime();
  t.mock.method(Date, "now", () => now);
  t.mock.method(config, "readSettings", () => ({ budgets: { enabled: true, monthlyLimitUsd: 25, dailyLimitUsd: 5 } }));
  writePricingStore({ "gpt-fixture": { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const append = (timestamp, receipt = timestamp) => {
    const row = { timestamp: timestamp.toISOString(), model: "gpt-fixture", tokens: { inputTokens: 1e6, totalTokens: 1e6 } };
    fs.appendFileSync(path.join(paths.usageDir, `records-${receipt.toISOString().slice(0, 10)}.jsonl`), JSON.stringify(row) + "\n");
  };
  for (let day = 1; day <= 30; day += 1) append(new Date(2026, 9, day, 10));
  const heatmapStart = new Date(2026, 9, 26 - 52 * 7);
  append(heatmapStart);
  append(new Date(2026, 8, 30, 10)); // Previous month, still inside the heatmap.
  append(new Date(2025, 0, 1, 10)); // Outside both windows.
  append(new Date(2025, 0, 1, 10), new Date(now)); // Backdated event in a recent file.
  async function read(endpoint) {
    let payload;
    await handleProxyApiRequest({ method: "GET" }, {
      writeHead(status) { assert.equal(status, 200); },
      end(body) { payload = JSON.parse(body); },
    }, new URL(`http://localhost/api/proxy/${endpoint}`), {});
    return payload;
  }
  const [budget, heatmap, recent] = await Promise.all([
    read("budget"), read("usage/heatmap"), read("usage/records"),
  ]);
  assert.equal(budget.budget.monthUsd, 30);
  assert.equal(budget.budget.todayUsd, 1);
  assert.equal(budget.budget.monthly.level, "exceeded");
  assert.equal(heatmap.days.length, 32);
  assert.equal(heatmap.days[0].date, "2025-10-27");
  assert.equal(heatmap.days.reduce((sum, day) => sum + day.costUsd, 0), 32);
  assert.equal(recent.total, 15, "the request list still reads 14 daily files, including the late event");
});

test("pricing meta route include=1 returns the fill metadata keyed by normalized id", async (t) => {
  fixture(t);
  writePricingStore({
    "claude-sonnet-5": { name: "Claude Sonnet 5", provider: "anthropic", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, contextWindow: 200000, maxOutputTokens: 64000, reasoningEfforts: ["low", "high"] },
    "gpt-5.2": { name: "GPT-5.2", provider: "openai", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  });
  let payload;
  await handleProxyApiRequest({ method: "GET" }, {
    writeHead(status) { assert.equal(status, 200); },
    end(body) { payload = JSON.parse(body); },
  }, new URL("http://localhost/api/proxy/pricing?include=1"), {});
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.models["claude-sonnet-5"], { contextWindow: 200000, maxOutputTokens: 64000, reasoningEfforts: ["low", "high"] });
  // Pricing fields stay out of the include=1 payload.
  assert.equal("input" in payload.models["gpt-5.2"], false);
  assert.equal(payload.models["gpt-5.2"].contextWindow, undefined);
});

test("estimateCostUsd keys semantics on the executor type when present", () => {
  // A non-Claude model served by the Claude executor bills fresh input.
  const fresh = pricing.estimateCostUsd(MODELS, "gpt-5.2", {
    inputTokens: 300, outputTokens: 90, cacheReadTokens: 140, reasoningTokens: 40,
  }, { executorType: "ClaudeExecutor" });
  assert.equal(fresh, (300 * 1.25 + (90 + 0) * 10 + 140 * 0.125) / 1e6);
  // Claude models served by the OpenAI executor bill cache-inclusive input.
  const inclusive = pricing.estimateCostUsd(MODELS, "claude-sonnet-5", {
    inputTokens: 300, outputTokens: 90, cacheReadTokens: 140,
  }, { executorType: "OpenAIExecutor" });
  assert.equal(inclusive, ((300 - 140) * 3 + 90 * 15 + 140 * 0.3) / 1e6);
});

test("estimateCostUsd bills reasoning for Gemini-family models only", () => {
  const geminiModels = { "gemini-3-pro": { name: "Gemini 3 Pro", provider: "google", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } };
  const cost = pricing.estimateCostUsd(geminiModels, "gemini-3-pro", {
    inputTokens: 500, outputTokens: 100, reasoningTokens: 30, cacheReadTokens: 200,
  }, { inputInclusive: true });
  // billable input 300, output+thoughts 130, cache read 200.
  assert.equal(cost, (300 * 1.25 + 130 * 10 + 200 * 0.125) / 1e6);
  // OpenAI-family reasoning is a subset of output and must not bill twice.
  const gpt = pricing.estimateCostUsd(MODELS, "gpt-5.2", {
    inputTokens: 300, outputTokens: 90, reasoningTokens: 40, cacheReadTokens: 140,
  });
  assert.equal(gpt, ((300 - 140) * 1.25 + 90 * 10 + 140 * 0.125) / 1e6);
});

test("estimateCostUsd falls back to cachedTokens for inclusive rows without cacheReadTokens", () => {
  const cost = pricing.estimateCostUsd(MODELS, "gpt-5.2", {
    inputTokens: 1000, outputTokens: 100, cachedTokens: 900, cacheReadTokens: 0,
  });
  assert.equal(cost, ((1000 - 900) * 1.25 + 100 * 10 + 900 * 0.125) / 1e6);
  // Claude rows never alias cachedTokens into the read bucket (core aliases
  // cache creation there).
  const claude = pricing.estimateCostUsd(MODELS, "claude-sonnet-5", {
    inputTokens: 1000, outputTokens: 100, cachedTokens: 900, cacheReadTokens: 0, cacheCreationTokens: 50,
  });
  assert.equal(claude, (1000 * 3 + 100 * 15 + 50 * 3.75) / 1e6);
});

// The queue fold (usage-bridge) and the Requests-tab estimate must resolve the
// cachedTokens alias identically, or the same request shows two different
// costs: the Tokens page would bill the aliased cache share at the full input
// rate while the Requests tab prices it at the cache-read rate.
test("cacheReadTokensFor resolves the cachedTokens alias for inclusive families only", () => {
  const aliased = { inputTokens: 1000, outputTokens: 100, cachedTokens: 900, cacheReadTokens: 0 };
  assert.equal(pricing.cacheReadTokensFor(aliased, { executorType: "OpenAIExecutor" }), 900);
  assert.equal(pricing.freshInputTokens(aliased, { executorType: "OpenAIExecutor" }), 100);
  // Claude rows alias cache *creation* into cachedTokens, so it is not a read
  // and must not be subtracted from input either.
  assert.equal(pricing.cacheReadTokensFor(aliased, { executorType: "ClaudeExecutor" }), 0);
  assert.equal(pricing.freshInputTokens(aliased, { executorType: "ClaudeExecutor" }), 1000);
  // An explicit cacheReadTokens always wins over the alias.
  const explicit = { inputTokens: 300, cachedTokens: 999, cacheReadTokens: 140 };
  assert.equal(pricing.cacheReadTokensFor(explicit, { executorType: "OpenAIExecutor" }), 140);
  assert.equal(pricing.freshInputTokens(explicit, { executorType: "OpenAIExecutor" }), 160);
});

test("the queue fold and estimateCostUsd bill an aliased cachedTokens row identically", () => {
  const tokens = { inputTokens: 1000, outputTokens: 100, reasoningTokens: 0, cachedTokens: 900, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const semantics = { executorType: "OpenAIExecutor", model: "gpt-5.2" };
  const price = MODELS["gpt-5.2"];
  // Rebuild the queue row usage-bridge writes, then price it the way
  // computeRowCost does on the Tokens page.
  const queueCost = (
    pricing.freshInputTokens(tokens, semantics) * price.input
    + tokens.outputTokens * price.output
    + pricing.cacheReadTokensFor(tokens, semantics) * price.cacheRead
    + tokens.cacheCreationTokens * price.cacheWrite
  ) / 1e6;
  assert.equal(queueCost, pricing.estimateCostUsd(MODELS, "gpt-5.2", tokens, semantics));
  // Guard the regression directly: filing the aliased share under input would
  // bill 1000 input tokens instead of 100 + 900 cache reads.
  assert.notEqual(queueCost, (1000 * price.input + 100 * price.output) / 1e6);
});

test("pricing lookup strips date suffixes from snapshot model ids", () => {
  const models = { "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", provider: "anthropic", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
  assert.equal(pricing.findPricing(models, "claude-sonnet-4-5-20250929"), models["claude-sonnet-4-5"]);
  const gptModels = { "gpt-4o": { name: "GPT-4o", provider: "openai", input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 } };
  assert.equal(pricing.findPricing(gptModels, "gpt-4o-2024-08-06"), gptModels["gpt-4o"]);
  assert.deepEqual(pricing.pricingLookupCandidates("claude-3.5-sonnet"), ["claude-3.5-sonnet", "claude-3-5-sonnet"]);
});

test("a failed sync backs off instead of re-kicking on every poll", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-pricing-backoff-"));
  const pricingPath = path.join(root, "usage", "pricing.json");
  pricing.__test.clearMemo();
  let fetches = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  try {
    const first = await pricing.getPricingSnapshot(pricingPath);
    assert.equal(first.syncing, true);
    await pricing.syncPricingStore(pricingPath).catch(() => {});
    assert.equal(fetchMock.mock.calls.length >= 1, true);
    const callsAfterFirst = fetchMock.mock.calls.length;
    // Within the retry window the next snapshot does not re-kick.
    const second = await pricing.getPricingSnapshot(pricingPath);
    assert.equal(second.syncing, false);
    assert.equal(fetchMock.mock.calls.length, callsAfterFirst);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  void fetches;
});
