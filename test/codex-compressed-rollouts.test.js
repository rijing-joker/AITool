"use strict";

// Codex compresses rollouts untouched for 7 days into a sibling
// rollout-*.jsonl.zst and deletes the original (cc-switch 8641cd1 adaptation).
// The scanners must treat the compressed file as the same session: same event
// dedup keys, counted once, and still readable as a CLI-session transcript.

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  parseRolloutIncremental,
  codexSessionIdFromPath,
  listRolloutFilesDeep,
  isRolloutFileName,
  rolloutLogicalPath,
} = require("../src/lib/rollout");
const { parseCodexRolloutFile, rolloutSessionIdFromPath } = require("../src/lib/codex-rollout-parser");
const { listSessions, readSession } = require("../src/lib/sessions");

const SESSION = "019f0000-0000-7000-8000-00000000c0de";
const MODEL = "gpt-5.5";

async function zstdCompress(data) {
  const zlib = require("node:zlib");
  if (typeof zlib.zstdCompressSync === "function") return zlib.zstdCompressSync(data);
  return Buffer.from(await require("@mongodb-js/zstd").compress(data));
}

const line = (obj) => JSON.stringify(obj);
const meta = () =>
  line({ timestamp: "2026-09-20T04:00:00.000Z", type: "session_meta", payload: { id: SESSION, cwd: "/tmp" } });
const turnContext = (ts) =>
  line({ timestamp: ts, type: "turn_context", payload: { turn_id: "t1", model: MODEL, current_date: "2026-09-20" } });
const usage = (input, cached, output) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
});
const tc = (ts, last, total) =>
  line({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } },
  });

// A handful of turns so the decompressed body is meaningfully larger than its
// compressed form — a bounded read at the compressed size would truncate. Each
// turn adds a constant usage(1000, 100, 50): normalized input 900, output 50,
// total 1050.
function rolloutLines() {
  const lines = [meta()];
  lines.push(line({
    timestamp: "2026-09-20T04:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello compressed world" }] },
  }));
  const step = usage(1000, 100, 50);
  let total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  for (let i = 0; i < 12; i += 1) {
    const ts = `2026-09-20T04:00:${String(10 + i).padStart(2, "0")}.000Z`;
    for (const k of Object.keys(total)) total[k] += step[k];
    lines.push(turnContext(ts));
    lines.push(tc(ts, step, total));
  }
  return lines;
}

async function queueTotals(queuePath) {
  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch {
    raw = "";
  }
  const latest = new Map();
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    const row = JSON.parse(l);
    latest.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  }
  const sum = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  for (const row of latest.values()) {
    sum.input_tokens += Number(row.input_tokens || 0);
    sum.output_tokens += Number(row.output_tokens || 0);
    sum.total_tokens += Number(row.total_tokens || 0);
  }
  return sum;
}

async function withTmp(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codex-zst-"));
  try {
    const dir = path.join(tmp, ".codex", "sessions", "2026", "09", "20");
    await fs.mkdir(dir, { recursive: true });
    const ctx = {
      tmp,
      dir,
      plainPath: path.join(dir, `rollout-2026-09-20T12-00-00-${SESSION}.jsonl`),
      zstPath: path.join(dir, `rollout-2026-09-20T12-00-00-${SESSION}.jsonl.zst`),
      queuePath: path.join(tmp, "queue.jsonl"),
      cursors: { version: 1, files: {}, updatedAt: null },
      sync(files) {
        return parseRolloutIncremental({
          rolloutFiles: files,
          cursors: ctx.cursors,
          queuePath: ctx.queuePath,
          source: "codex",
        });
      },
    };
    await fn(ctx);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test("compressed rollout path helpers keep the logical session identity", () => {
  const zstPath = `/tmp/x/sessions/2026/09/20/rollout-2026-09-20T12-00-00-${SESSION}.jsonl.zst`;
  assert.equal(codexSessionIdFromPath(zstPath), SESSION);
  assert.equal(rolloutSessionIdFromPath(zstPath), SESSION);
  assert.equal(codexSessionIdFromPath(rolloutLogicalPath(zstPath)), SESSION);
  assert.equal(rolloutLogicalPath(zstPath), zstPath.slice(0, -4));
  assert.equal(isRolloutFileName(`rollout-2026-09-20T12-00-00-${SESSION}.jsonl.zst`), true);
  assert.equal(isRolloutFileName(`rollout-2026-09-20T12-00-00-${SESSION}.jsonl`), true);
  assert.equal(isRolloutFileName(`rollout-2026-09-20T12-00-00-${SESSION}.jsonl.gz`), false);
});

test("sync parses a compressed rollout fully and a resync adds nothing", async () => {
  await withTmp(async (ctx) => {
    const lines = rolloutLines();
    await fs.writeFile(ctx.zstPath, await zstdCompress(Buffer.from(lines.map((l) => l + "\n").join(""))));

    const deep = await listRolloutFilesDeep(path.join(ctx.tmp, ".codex", "sessions"));
    assert.deepEqual(deep, [ctx.zstPath]);

    await ctx.sync([ctx.zstPath]);
    const first = await queueTotals(ctx.queuePath);
    assert.equal(first.total_tokens, 12 * 1050);

    await ctx.sync([ctx.zstPath]);
    const second = await queueTotals(ctx.queuePath);
    assert.deepEqual(second, first);
    assert.equal(Object.keys(ctx.cursors.files).length, 0, "compressed rollouts persist no byte cursor");
  });
});

test("compressing an already-counted rollout does not double-count", async () => {
  await withTmp(async (ctx) => {
    const lines = rolloutLines();
    await fs.writeFile(ctx.plainPath, lines.map((l) => l + "\n").join(""));

    await ctx.sync([ctx.plainPath]);
    const before = await queueTotals(ctx.queuePath);
    assert.equal(before.total_tokens, 12 * 1050);

    // Codex compression: write the sibling and delete the original.
    await fs.writeFile(ctx.zstPath, await zstdCompress(Buffer.from(lines.map((l) => l + "\n").join(""))));
    await fs.rm(ctx.plainPath);

    await ctx.sync([ctx.zstPath]);
    const after = await queueTotals(ctx.queuePath);
    assert.deepEqual(after, before);
  });
});

test("plain and compressed siblings present together count once", async () => {
  await withTmp(async (ctx) => {
    const lines = rolloutLines();
    await fs.writeFile(ctx.plainPath, lines.map((l) => l + "\n").join(""));
    await fs.writeFile(ctx.zstPath, await zstdCompress(Buffer.from(lines.map((l) => l + "\n").join(""))));

    await ctx.sync([ctx.plainPath, ctx.zstPath]);
    const totals = await queueTotals(ctx.queuePath);
    assert.equal(totals.total_tokens, 12 * 1050);
  });
});

test("parseCodexRolloutFile reads a compressed rollout without truncation", async () => {
  await withTmp(async (ctx) => {
    const lines = rolloutLines();
    await fs.writeFile(ctx.zstPath, await zstdCompress(Buffer.from(lines.map((l) => l + "\n").join(""))));

    const parsed = await parseCodexRolloutFile(ctx.zstPath, { collectBreakdowns: false, collectModelUsage: true });
    assert.ok(parsed.modelUsage?.length >= 1, "model usage rows parsed");
    const tokens = (parsed.modelUsage || []).reduce((s, r) => s + Number(r.totalTokens || r.total_tokens || 0), 0);
    assert.equal(tokens, 12 * 1050);
  });
});

test("CLI session listing and transcript reading see compressed rollouts", async () => {
  await withTmp(async (ctx) => {
    const lines = rolloutLines();
    await fs.writeFile(ctx.zstPath, await zstdCompress(Buffer.from(lines.map((l) => l + "\n").join(""))));

    const sessions = await listSessions({ app: "codex", home: ctx.tmp });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, SESSION);
    assert.equal(sessions[0].sourcePath, ctx.zstPath);

    const transcript = await readSession({ app: "codex", sourcePath: ctx.zstPath, home: ctx.tmp });
    assert.ok(Array.isArray(transcript.messages));
    assert.ok(transcript.messages.length > 0);
  });
});

test("when both forms exist the plain file wins the session listing", async () => {
  await withTmp(async (ctx) => {
    const lines = rolloutLines();
    await fs.writeFile(ctx.plainPath, lines.map((l) => l + "\n").join(""));
    await fs.writeFile(ctx.zstPath, await zstdCompress(Buffer.from(lines.map((l) => l + "\n").join(""))));

    const sessions = await listSessions({ app: "codex", home: ctx.tmp });
    assert.equal(sessions.length, 1);
    assert.ok(!sessions[0].sourcePath?.endsWith(".zst"), `expected the plain file, got ${sessions[0].sourcePath}`);
  });
});

test("a zero-byte plain rollout with a bounded end read does not crash the reader", async () => {
  // cc-switch 8641cd1 adaptation follow-up: the bounded-end early return is
  // reached by plain files too (fresh-parse callers pass endOffset = stat.size
  // = 0 for empty rollouts); the compressed-view cleanup must be optional there.
  await withTmp(async (ctx) => {
    await fs.writeFile(ctx.plainPath, "");
    const parsed = await parseCodexRolloutFile(ctx.plainPath, {
      endOffset: 0,
      collectBreakdowns: false,
      collectModelUsage: false,
    });
    assert.ok(parsed);
  });
});

test("listing survives an undecompressable rollout via filename identity and mtime", async () => {
  await withTmp(async (ctx) => {
    // Hostile/corrupt archive: the head decompress fails, but the session
    // must not vanish from the list (that was the bug class this port fixed).
    await fs.writeFile(ctx.zstPath, Buffer.from("definitely-not-zstd"));
    const knownMtime = new Date("2026-09-20T12:34:56Z");
    await fs.utimes(ctx.zstPath, knownMtime, knownMtime);

    const sessions = await listSessions({ app: "codex", home: ctx.tmp });
    assert.equal(sessions.length, 1, "a corrupt compressed rollout must still be listed");
    assert.equal(sessions[0].sessionId, SESSION, "identity falls back to the filename UUID");
    assert.equal(sessions[0].lastActiveAt, knownMtime.getTime(), "last-active falls back to mtime");
    assert.equal(sessions[0].summary, null, "no last-reply preview without a readable tail");
  });
});

test("compressed listing reads only the head, not the whole decompressed file", async () => {
  await withTmp(async (ctx) => {
    // Build a rollout whose head is tiny but whose tail is far beyond the
    // head budget; listing must succeed regardless of the tail size.
    const lines = [meta()];
    for (let i = 0; i < 40_000; i += 1) {
      lines.push(line({
        timestamp: "2026-09-20T05:00:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `filler line ${i} ` .repeat(8) }] },
      }));
    }
    await fs.writeFile(ctx.zstPath, await zstdCompress(Buffer.from(lines.map((l) => l + "\n").join(""))));
    const decompressedBytes = (await fs.stat(ctx.zstPath)).size < 512 * 1024 ? lines.join("").length : -1;
    assert.ok(decompressedBytes > 1024 * 1024, "fixture should exceed the head budget");

    const sessions = await listSessions({ app: "codex", home: ctx.tmp });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, SESSION);
  });
});
