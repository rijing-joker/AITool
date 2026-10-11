const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { parseRolloutIncremental, parseClaudeIncremental } = require("../src/lib/rollout");
const { repairCacheHistory, recoverCacheHistoryRepair, KEYS, JOURNAL } = require("../src/lib/cache-history-repair");

async function fixture(t, source) {
  const trackerDir = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-repair-"));
  t.after(() => fs.rm(trackerDir, { recursive: true, force: true }));
  const root = path.join(trackerDir, `.${source}`, source === "codex" ? "sessions" : "projects");
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, ".git", "config"), '[remote "origin"]\nurl = https://github.com/example/test.git\n');
  const file = path.join(root, source === "codex" ? "rollout-11111111-1111-4111-8111-111111111111.jsonl" : "session.jsonl");
  const timestamp = "2026-10-10T01:00:00Z";
  const events = source === "codex" ? [
    { type: "session_meta", payload: { cwd: root } },
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 300, cache_write_input_tokens: 600, output_tokens: 50, total_tokens: 1050 } } } },
  ] : [{ timestamp, cwd: root, type: "assistant", message: { id: "m1", model: "claude-opus-4-6", usage: { input_tokens: 100, cache_creation_input_tokens: 1500, cache_creation: { ephemeral_1h_input_tokens: 1000 }, output_tokens: 50 } } }];
  await fs.writeFile(file, events.map(JSON.stringify).join("\n") + "\n");
  const args = { publicRepoResolver: async ({ projectRef }) => ({ status: "public_verified", projectKey: "test", projectRef }), source, trackerDir, files: [file], roots: [root], cursors: {}, queuePath: path.join(trackerDir, "queue.jsonl"), projectQueuePath: path.join(trackerDir, "project.queue.jsonl"), queueStatePath: path.join(trackerDir, "queue.state.json"), projectQueueStatePath: path.join(trackerDir, "project.queue.state.json") };
  if (source === "codex") await parseRolloutIncremental({ ...args, rolloutFiles: [file] });
  else await parseClaudeIncremental({ ...args, projectFiles: [file] });
  const row = JSON.parse((await fs.readFile(args.queuePath, "utf8")).trim());
  if (source === "codex") row.input_tokens = 700;
  else delete row.cache_creation_1h_input_tokens;
  await fs.writeFile(args.queuePath, JSON.stringify(row) + '\n{"source":"gemini","total_tokens":999}\n');
  await fs.writeFile(args.queueStatePath, '{"offset":123}');
  args.commitCursors = async (next) => fs.writeFile(path.join(trackerDir, "cursors.json"), JSON.stringify(next));
  await args.commitCursors(args.cursors);
  return { args, file };
}

for (const source of ["codex", "claude"]) {
  test(`${source} repair replaces only its own source, backs up and is idempotent`, async (t) => {
    const { args } = await fixture(t, source);
    const original = await fs.readFile(args.queuePath, "utf8");
    assert.equal(await repairCacheHistory(args), true);
    const updated = await fs.readFile(args.queuePath, "utf8");
    const records = updated.trim().split("\n").map(JSON.parse);
    assert.equal(records.find((row) => row.source === "gemini").total_tokens, 999);
    const row = records.find((row) => row.source === source);
    if (source === "codex") assert.equal(row.input_tokens, 100);
    else assert.equal(row.cache_creation_1h_input_tokens, 1000);
    assert.equal(JSON.parse(await fs.readFile(args.queueStatePath)).offset, 0);
    assert.equal(args.cursors.migrations[KEYS[source]].status, "complete");
    const backups = await fs.readdir(path.join(args.trackerDir, "repair-backups"));
    assert.equal(await fs.readFile(path.join(args.trackerDir, "repair-backups", backups[0], "0.before"), "utf8"), original);
    assert.equal(await repairCacheHistory(args), false);
    if (source === "codex") await parseRolloutIncremental({ ...args, rolloutFiles: args.files });
    else await parseClaudeIncremental({ ...args, projectFiles: args.files });
    if (source === "codex") await parseRolloutIncremental({ ...args, rolloutFiles: args.files });
    else await parseClaudeIncremental({ ...args, projectFiles: args.files });
    assert.equal(await fs.readFile(args.queuePath, "utf8"), updated);
  });
}

for (const failure of ["missing", "malformed", "changed", "truncated", "project_gap"]) {
  test(`repair defers ${failure} logs without losing history and retries`, async (t) => {
    const { args, file } = await fixture(t, "codex");
    const original = await fs.readFile(args.queuePath, "utf8");
    const log = await fs.readFile(file, "utf8");
    if (failure === "missing") { await fs.unlink(file); args.files = []; }
    if (failure === "malformed") await fs.appendFile(file, "broken\n");
    if (failure === "changed") args.beforeValidate = () => fs.appendFile(file, "{}\n");
    if (failure === "truncated") await fs.writeFile(file, "{}\n");
    if (failure === "project_gap") await fs.writeFile(args.projectQueuePath, JSON.stringify({ source: "codex", project_key: "lost", model: "gpt-5.5", hour_start: "2026-10-10T01:00:00.000Z", total_tokens: 999 }) + "\n");
    assert.equal(await repairCacheHistory(args), false);
    assert.equal(args.cursors.migrations[KEYS.codex].status, failure === "malformed" ? "failed" : "deferred");
    assert.equal(await fs.readFile(args.queuePath, "utf8"), original);
    await fs.writeFile(file, log);
    if (failure === "project_gap") await fs.unlink(args.projectQueuePath);
    args.files = [file]; delete args.beforeValidate;
    assert.equal(await repairCacheHistory(args), true);
  });
}

test("interrupted publication recovers queues, upload offsets and cursors together", async (t) => {
  const { args } = await fixture(t, "codex");
  args.afterPublish = async () => { throw new Error("simulated crash"); };
  await assert.rejects(repairCacheHistory(args), /simulated crash/);
  await fs.access(path.join(args.trackerDir, JOURNAL));
  await fs.appendFile(args.queuePath, '{"source":"cliproxy","total_tokens":456}\n');
  const restarted = JSON.parse(await fs.readFile(path.join(args.trackerDir, "cursors.json")));
  assert.equal(await recoverCacheHistoryRepair({ ...args, cursors: restarted }), true);
  assert.equal(restarted.migrations[KEYS.codex].status, "complete");
  assert.equal(JSON.parse(await fs.readFile(args.queueStatePath)).offset, 0);
  assert.match(await fs.readFile(args.queuePath, "utf8"), /"source":"cliproxy","total_tokens":456/);
  assert.equal(await recoverCacheHistoryRepair({ ...args, cursors: restarted }), false);
  assert.equal(await repairCacheHistory({ ...args, cursors: restarted }), false);
});

test("compressed archive replaces a plain cursor and still repairs the same session", async (t) => {
  const { args, file } = await fixture(t, "codex");
  const zlib = require("node:zlib");
  const compressed = zlib.zstdCompress
    ? await require("node:util").promisify(zlib.zstdCompress)(await fs.readFile(file))
    : await require("@mongodb-js/zstd").compress(await fs.readFile(file), 3);
  const archive = path.join(args.trackerDir, ".codex", "archived_sessions", path.basename(file) + ".zst");
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(archive, compressed);
  await fs.unlink(file);
  args.files = [archive];
  assert.equal(await repairCacheHistory(args), true);
  assert.equal(args.cursors.files[file], undefined);
  assert.equal(args.cursors.files[archive].offset, compressed.length);
});
