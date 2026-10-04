const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const bridge = require("../src/lib/proxy/usage-bridge");
const { normalizeRecord, maskApiKey } = require("../src/lib/proxy/usage-record");
const { createUsageRecordStore } = require("../src/lib/proxy/usage-records");
const paths = require("../src/lib/proxy/paths");
const localApi = require("../src/lib/local-api");

// The core publishes snake_case payloads (internal/redisqueue/plugin.go).
// Until the normalize layer existed, every camelCase read in the bridge, the
// API and the dashboard silently summed to zero on real data — these tests
// pin the canonical shape for both spellings.

const rawCoreRecord = {
  timestamp: "2026-10-03T12:00:00.000Z",
  request_id: "req-1",
  latency_ms: 1500,
  ttft_ms: 220,
  source: "codex",
  model: "gpt-5.5",
  alias: "",
  provider: "up-a",
  endpoint: "/v1/responses",
  api_key: "sk-test-1234567890abcd",
  reasoning_effort: "high",
  tokens: {
    input_tokens: 100,
    output_tokens: 40,
    reasoning_tokens: 10,
    cached_tokens: 5,
    cache_read_tokens: 60,
    cache_creation_tokens: 8,
    total_tokens: 150,
  },
  failed: false,
  fail: { status_code: 200, body: "" },
  response_headers: { "x-secret": "1" },
};

test("normalizes the core's raw snake_case payload onto canonical camelCase rows", () => {
  const row = normalizeRecord(rawCoreRecord);
  assert.deepEqual(row.tokens, {
    inputTokens: 100, outputTokens: 40, reasoningTokens: 10, cachedTokens: 5,
    cacheReadTokens: 60, cacheCreationTokens: 8, totalTokens: 150,
  });
  assert.equal(row.latencyMs, 1500);
  assert.equal(row.ttftMs, 220);
  assert.equal(row.id, "req-1");
  assert.equal(row.request_id, "req-1");
  assert.equal(row.failure_status, 200);
  assert.equal(row.reasoning_effort, "high");
  assert.equal(row.failed, false);
  assert.equal(row.canceled, false);
  // Secrets never survive normalization.
  assert.equal(row.api_key, undefined);
  assert.equal(row.apiKey, undefined);
  assert.equal(row.response_headers, undefined);
  assert.equal(row.api_key_display, "sk-t••••abcd");
  assert.equal(row.api_key_hash, normalizeRecord(rawCoreRecord).api_key_hash);
  assert.match(row.api_key_hash, /^[0-9a-f]{64}$/);
});

test("normalization is idempotent and derives canceled failures like the upstream GUI", () => {
  const once = normalizeRecord(rawCoreRecord);
  const twice = normalizeRecord(once);
  assert.deepEqual(twice.tokens, once.tokens);
  assert.equal(twice.canceled, once.canceled);
  assert.equal(twice.api_key_hash, once.api_key_hash);

  const failed499 = normalizeRecord({ ...rawCoreRecord, failed: true, fail: { status_code: 499, body: "" } });
  assert.equal(failed499.canceled, true);
  const canceledBody = normalizeRecord({ ...rawCoreRecord, canceled: true, failed: true, fail: { status_code: 500, body: "stream closed: context canceled" } });
  assert.equal(canceledBody.canceled, true);
  const plainFailure = normalizeRecord({ ...rawCoreRecord, failed: true, fail: { status_code: 502, body: "bad gateway" } });
  assert.equal(plainFailure.canceled, false);
  assert.equal(plainFailure.failure_body, "bad gateway");
  assert.equal(plainFailure.failure_message, "bad gateway");
  // An explicit false must not be flipped by the body heuristic.
  const explicit = normalizeRecord({ ...rawCoreRecord, canceled: false, failed: true, fail: { status_code: 499, body: "" } });
  assert.equal(explicit.canceled, false);
});

test("masks short and long keys without ever keeping the raw value", () => {
  assert.equal(maskApiKey("sk-1"), "sk••••");
  assert.equal(maskApiKey("abcdefgh"), "ab••••");
  assert.equal(maskApiKey("sk-test-1234567890abcd"), "sk-t••••abcd");
  assert.equal(maskApiKey(""), "");
  assert.equal(maskApiKey(null), "");
});

test("bridge fusion accumulates snake_case tokens into half-hour buckets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-shape-test-"));
  const previous = { usageDir: paths.usageDir, bucketsStatePath: paths.bucketsStatePath };
  paths.usageDir = path.join(root, "usage");
  paths.bucketsStatePath = path.join(paths.usageDir, "buckets.json");
  const queuePath = path.join(root, "queue.jsonl");
  t.mock.method(localApi, "resolveQueuePath", () => queuePath);
  fs.mkdirSync(paths.usageDir);
  t.after(() => {
    bridge.stopBridge();
    Object.assign(paths, previous);
    fs.rmSync(root, { recursive: true, force: true });
  });

  bridge.handleUsagePayload(JSON.stringify(rawCoreRecord));
  const dayFile = fs.readdirSync(paths.usageDir).find((name) => name.endsWith(".jsonl"));
  const [stored] = fs.readFileSync(path.join(paths.usageDir, dayFile), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(stored.tokens.inputTokens, 100, "persisted records are canonical");
  assert.equal(stored.api_key, undefined, "raw credentials are stripped before persisting");

  const row = JSON.parse(fs.readFileSync(queuePath, "utf8").split("\n").filter(Boolean).at(-1));
  assert.equal(row.conversation_count, 1);
  // OpenAI-family input includes the cache amounts; the fold applies the
  // queue contract (input_tokens = non-cached only) so computeRowCost does
  // not double-bill the cached share. Reasoning rides inside output.
  assert.equal(row.input_tokens, 32, "the fusion folds fresh input for cache-inclusive upstreams");
  assert.equal(row.cached_input_tokens, 60);
  assert.equal(row.cache_creation_input_tokens, 8);
  assert.equal(row.reasoning_output_tokens, 0);
  assert.equal(row.output_tokens, 40);
  assert.equal(row.total_tokens, 150);
});

test("the record store normalizes legacy raw rows on read", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-legacy-records-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "records-2026-10-02.jsonl");
  fs.writeFileSync(file, JSON.stringify(rawCoreRecord) + "\n");
  const store = createUsageRecordStore();
  const [row] = await store.readRecords(dir);
  assert.equal(row.tokens.inputTokens, 100);
  assert.equal(row.api_key, undefined);
  assert.equal(row.api_key_display, "sk-t••••abcd");
});
