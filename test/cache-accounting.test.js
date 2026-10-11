const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { normalizeCodexUsage } = require("../src/lib/codex-token-usage");
const { parseRolloutIncremental, parseClaudeIncremental } = require("../src/lib/rollout");
const { scanClaudeSession } = require("../src/lib/session-analytics");
const { computeClaudeGroundTruthBuckets } = require("../src/lib/claude-categorizer");
const { readSession } = require("../src/lib/sessions");
const { computeRowCost } = require("../src/lib/pricing");
const { estimateCostUsd } = require("../src/lib/proxy/pricing");

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-cache-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}
const readRows = async (file) => (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);

test("Codex scanner and reader partition cache writes without billing reasoning twice", async (t) => {
  const home = await fixture(t);
  const root = path.join(home, ".codex", "sessions");
  await fs.mkdir(root, { recursive: true });
  const sourcePath = path.join(root, "rollout-11111111-1111-4111-8111-111111111111.jsonl");
  const raw = { input_tokens: 1000, cached_input_tokens: 300, cache_write_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 };
  assert.equal(normalizeCodexUsage(raw).input_tokens, 100);
  assert.equal(normalizeCodexUsage(raw).total_tokens, 1050);
  assert.deepEqual(normalizeCodexUsage({ ...raw, cache_write_input_tokens: undefined, cache_creation_input_tokens: 600 }), normalizeCodexUsage(raw));
  await fs.writeFile(sourcePath, [
    { type: "session_meta", payload: { id: "cache-test" } },
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    ...[1, 2].map(() => ({ timestamp: "2026-10-10T01:00:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: raw, total_token_usage: raw } } })),
  ].map(JSON.stringify).join("\n") + "\n");
  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  await parseRolloutIncremental({ rolloutFiles: [sourcePath], cursors, queuePath });
  const rows = await readRows(queuePath);
  assert.equal(rows.at(-1).input_tokens, 100);
  assert.equal(rows.at(-1).cache_creation_input_tokens, 600);
  assert.equal(rows.at(-1).total_tokens, 1050);
  await parseRolloutIncremental({ rolloutFiles: [sourcePath], cursors, queuePath });
  assert.deepEqual(await readRows(queuePath), rows);
  const { usage } = await readSession({ app: "codex", home, sourcePath });
  assert.equal(usage.inputTokens, 1000);
  assert.equal(usage.cacheCreationTokens, 600);
  assert.equal(usage.totalTokens, 1050);
});

test("Claude TTL subset survives queues, projects, sessions and ground truth without increasing totals", async (t) => {
  const home = await fixture(t);
  const root = path.join(home, ".claude", "projects", "test");
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, ".git", "config"), '[remote "origin"]\nurl = https://github.com/example/test.git\n');
  const sourcePath = path.join(root, "session.jsonl");
  const usage = { input_tokens: 100, cache_read_input_tokens: 300, cache_creation_input_tokens: 1500, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 500 }, output_tokens: 50 };
  const message = { type: "assistant", sessionId: "ttl", cwd: root, timestamp: "2026-10-10T01:00:00Z", message: { role: "assistant", id: "m1", model: "claude-opus-4-6", usage, content: [] } };
  await fs.writeFile(sourcePath, JSON.stringify(message) + "\n");
  const queuePath = path.join(home, "queue.jsonl"), projectQueuePath = path.join(home, "project.queue.jsonl");
  const cursors = {};
  const args = { projectFiles: [sourcePath], cursors, queuePath, projectQueuePath, publicRepoResolver: async ({ projectRef }) => ({ status: "public_verified", projectKey: "test", projectRef }) };
  await parseClaudeIncremental(args);
  const rows = await readRows(queuePath), projectRows = await readRows(projectQueuePath);
  for (const row of [rows.at(-1), projectRows.at(-1), (await computeClaudeGroundTruthBuckets({ rootDir: root })).rows[0]]) {
    assert.equal(row.cache_creation_1h_input_tokens, 1000);
    assert.equal(row.total_tokens, 1950);
  }
  await parseClaudeIncremental(args);
  assert.deepEqual(await readRows(queuePath), rows);
  const session = await scanClaudeSession(sourcePath);
  assert.equal(session.tokens.cache_creation_1h_input_tokens, 1000);
  assert.equal(session.total_tokens, 1950);
  const transcript = await readSession({ app: "claude", home, sourcePath });
  assert.equal(transcript.usage.cacheCreation1hTokens, 1000);
  assert.equal(transcript.usage.perModel[0].cacheCreation1hTokens, 1000);
});

test("both pricing sources price explicit 1h writes at 2x input and retain legacy estimates", () => {
  const row = { source: "claude", model: "claude-opus-4-6", cache_creation_input_tokens: 1000, cache_creation_1h_input_tokens: 1000 };
  assert.equal(computeRowCost(row), 0.01);
  assert.equal(computeRowCost({ ...row, cache_creation_1h_input_tokens: undefined }), 0.00625);
  const mixed = { ...row, cache_creation_input_tokens: 1500 };
  assert.equal(computeRowCost(mixed), 0.013125);
  const models = { "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } };
  assert.equal(estimateCostUsd(models, row.model, { inputTokens: 0, cacheCreationTokens: 1500, cacheCreation1hTokens: 1000 }), 0.013125);
});
