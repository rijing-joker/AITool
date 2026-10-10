const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const files = require("../src/lib/codex-rollout-file");
const { listRolloutFilesDeep, parseRolloutIncremental } = require("../src/lib/rollout");
const { parseCodexRolloutFile } = require("../src/lib/codex-rollout-parser");
const { listSessions, readSession } = require("../src/lib/sessions");
const compress = (bytes) => zlib.zstdCompress ? promisify(zlib.zstdCompress)(bytes) : require("@mongodb-js/zstd").compress(bytes, 3);
const id = "11111111-1111-4111-8111-111111111111";
const usage = (input) => ({ input_tokens: input, output_tokens: 50, total_tokens: input + 50 });
const event = (second, input) => ({ timestamp: `2026-10-10T00:00:${second}Z`, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage(input) } } });
const text = [
  { type: "session_meta", payload: { id, cwd: "/test" }, timestamp: "2026-10-10T00:00:00Z" },
  { type: "turn_context", payload: { model: "gpt-5.5" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "example" }] } },
  event("01", 1000),
].map(JSON.stringify).join("\n") + "\n";

test("Codex compression, sibling overlap, resume and archive preserve usage", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-zstd-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".codex", "sessions");
  await fs.mkdir(root, { recursive: true });
  const plain = path.join(root, `rollout-2026-10-10-${id}.jsonl`);
  const packed = `${plain}.zst`;
  const queuePath = path.join(home, "queue.jsonl");
  const cursors = { version: 1, files: {} };
  const sync = async (paths = null) => parseRolloutIncremental({ rolloutFiles: paths || await listRolloutFilesDeep(root), cursors, queuePath });
  await fs.writeFile(plain, text);
  await sync();
  const initial = await fs.readFile(queuePath, "utf8");
  await fs.writeFile(packed, await compress(Buffer.from(text)));
  assert.deepEqual(await listRolloutFilesDeep(root), [plain]);
  await fs.unlink(plain);
  await sync();
  await sync();
  assert.equal(await fs.readFile(queuePath, "utf8"), initial);
  const parsed = await parseCodexRolloutFile(packed);
  assert.equal(parsed.totals.total_tokens, 1050);
  assert.equal((await listSessions({ app: "codex", home })).length, 1);
  assert.equal((await readSession({ app: "codex", home, sourcePath: plain })).usage.totalTokens, 1050);
  await fs.writeFile(plain, text + JSON.stringify(event("02", 1200)) + "\n");
  await fs.unlink(packed);
  await sync();
  const updated = await fs.readFile(queuePath, "utf8");
  assert.equal(JSON.parse(updated.trim().split("\n").at(-1)).total_tokens, 1250);
  const archived = path.join(home, ".codex", "archived_sessions", path.basename(packed));
  await fs.mkdir(path.dirname(archived), { recursive: true });
  await fs.writeFile(archived, await compress(await fs.readFile(plain)));
  await fs.unlink(plain);
  await sync([archived]);
  assert.equal(await fs.readFile(queuePath, "utf8"), updated);
});

test("bad compressed snapshots leave cursors and queues unchanged; sibling escape is rejected", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-zstd-invalid-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".codex", "sessions");
  await fs.mkdir(root, { recursive: true });
  const packed = path.join(root, `rollout-2026-10-10-${id}.jsonl.zst`);
  const queuePath = path.join(home, "queue.jsonl");
  await fs.writeFile(queuePath, "previous\n");
  await fs.writeFile(packed, await compress(Buffer.from(text + "broken\n")));
  const cursors = { version: 1, files: {} };
  await assert.rejects(parseRolloutIncremental({ rolloutFiles: [packed], cursors, queuePath }));
  assert.deepEqual(cursors, { version: 1, files: {} });
  assert.equal(await fs.readFile(queuePath, "utf8"), "previous\n");
  await assert.rejects(files.readSnapshot(packed, { maxOutputBytes: 1 }), /exceeds/);
  await fs.unlink(packed);
  const outside = path.join(home, "outside.jsonl.zst");
  await fs.writeFile(outside, await compress(Buffer.from(text)));
  await fs.symlink(outside, packed);
  await assert.rejects(readSession({ app: "codex", home, sourcePath: files.logicalPath(packed) }), /outside/);
});
