"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseClaudeIncremental, normalizeClaudeUsage, totalsKey } = require("../src/lib/rollout");
const { computeRowCost } = require("../src/lib/pricing");

// cc-switch 533055b: Anthropic bills 1h cache writes at 2x input vs 1.25x for
// 5m. The queue carries the 1h share as an observed-subset annotation column
// (cache_creation_1h_input_tokens ⊆ cache_creation_input_tokens, same contract
// as priority_*); computeRowCost bills it at 1.6x the cache-write rate. Legacy
// rows without the column keep the blended price.

function writeClaudeSession(dir, index, usage) {
  const file = path.join(dir, `session-${index}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({
    type: "assistant", timestamp: "2026-09-07T03:00:00Z",
    message: { id: `m-${index}`, model: "claude-sonnet-4-6", usage },
  }) + "\n");
  return file;
}

test("normalizeClaudeUsage extracts and clamps the 1h cache-write share", () => {
  assert.deepEqual(normalizeClaudeUsage({
    input_tokens: 100, output_tokens: 50,
    cache_creation_input_tokens: 400, cache_read_input_tokens: 10,
    cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 100 },
  }), {
    input_tokens: 100, cached_input_tokens: 10, cache_creation_input_tokens: 400,
    cache_creation_1h_input_tokens: 100,
    output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 560,
  });
  // Clamp: a 1h breakdown above the reported cache-write total is not trusted.
  assert.equal(normalizeClaudeUsage({
    input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 5,
    cache_creation: { ephemeral_1h_input_tokens: 99 },
  }).cache_creation_1h_input_tokens, 5);
  // Absent or zero breakdown stays omitted — queue rows keep their old shape.
  assert.equal("cache_creation_1h_input_tokens" in normalizeClaudeUsage({
    input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 5,
  }), false);
  assert.equal("cache_creation_1h_input_tokens" in normalizeClaudeUsage({
    input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 5,
    cache_creation: { ephemeral_1h_input_tokens: 0 },
  }), false);
});

test("claude queue rows carry the 1h annotation and re-parse idempotently", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-1h-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = writeClaudeSession(dir, 0, {
    input_tokens: 100, output_tokens: 50,
    cache_creation_input_tokens: 400, cache_read_input_tokens: 10,
    cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 100 },
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const options = { projectFiles: [file], queuePath, cursors: {}, source: "claude" };
  await parseClaudeIncremental(options);
  const row = JSON.parse(fs.readFileSync(queuePath, "utf8").trim().split("\n").at(-1));
  assert.equal(row.cache_creation_input_tokens, 400);
  assert.equal(row.cache_creation_1h_input_tokens, 100);
  assert.equal(row.total_tokens, 560);
  const saved = fs.readFileSync(queuePath, "utf8");
  await parseClaudeIncremental(options);
  assert.equal(fs.readFileSync(queuePath, "utf8"), saved);
});

test("legacy rows price identically; the 1h share bills at 1.6x cache-write", () => {
  const base = {
    source: "claude", model: "claude-haiku-5-5",
    input_tokens: 1e6, output_tokens: 5e5, cached_input_tokens: 1e6,
    cache_creation_input_tokens: 1e6,
  };
  const legacyCost = computeRowCost(base);
  // The Haiku 5.5 seed: 0.1 in + 0.25 out + 0.01 read + 0.125 write.
  assert.ok(Math.abs(legacyCost - 0.485) < 1e-9);
  // Same totals with a 1h annotation: 0.6M·0.125 + 0.4M·0.2 per million.
  const split = computeRowCost({ ...base, cache_creation_1h_input_tokens: 4e5 });
  assert.ok(Math.abs(split - (0.1 + 0.25 + 0.01 + 0.075 + 0.08)) < 1e-9);
  // An annotation above the total clamps to it — every write byte bills at 1.6x.
  assert.ok(Math.abs(
    computeRowCost({ ...base, cache_creation_1h_input_tokens: 99e6 }) - (0.1 + 0.25 + 0.01 + 0.2),
  ) < 1e-9);
  // A zero annotation is exactly the legacy price.
  assert.equal(computeRowCost({ ...base, cache_creation_1h_input_tokens: 0 }), legacyCost);
});

test("totalsKey changes when the 1h share moves at constant cache_creation", () => {
  const totals = {
    input_tokens: 1, cached_input_tokens: 0, cache_creation_input_tokens: 100,
    output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 102, conversation_count: 1,
  };
  const plain = totalsKey(totals);
  assert.notEqual(totalsKey({ ...totals, cache_creation_1h_input_tokens: 40 }), plain);
  assert.equal(totalsKey({ ...totals, cache_creation_1h_input_tokens: 0 }), plain);
});
