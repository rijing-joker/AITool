const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createUsageRecordStore } = require("../src/lib/proxy/usage-records");

function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-records-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "records-2026-10-02.jsonl"), store: createUsageRecordStore(options) };
}
const record = (id, timestamp = "2026-10-02T12:00:00Z") => ({ id, timestamp, model: "模型", tokens: { totalTokens: 10 } });
const line = (id, timestamp) => JSON.stringify(record(id, timestamp)) + "\n";

test("shares cold reads, reuses unchanged snapshots and only streams the appended tail", async (t) => {
  const { dir, file, store } = fixture(t);
  fs.writeFileSync(file, line("first"));
  const open = fsp.open.bind(fsp);
  const starts = [];
  t.mock.method(fsp, "open", async (...args) => {
    const handle = await open(...args);
    const createReadStream = handle.createReadStream.bind(handle);
    handle.createReadStream = (options) => { starts.push(options.start); return createReadStream(options); };
    return handle;
  });
  const [a, b] = await Promise.all([store.readRecords(dir), store.readRecords(dir)]);
  assert.equal(a, b);
  assert.equal(await store.readRecords(dir), a);
  assert.deepEqual(starts, [0]);
  const offset = fs.statSync(file).size;
  fs.appendFileSync(file, line("second", "2026-10-02T13:00:00Z"));
  const next = await store.readRecords(dir);
  assert.deepEqual(next.map((r) => r.id), ["second", "first"]);
  assert.deepEqual(a.map((r) => r.id), ["first"], "published snapshots remain immutable");
  assert.deepEqual(starts, [0, offset]);
});

test("handles partial UTF-8/JSON writes and a valid EOF without duplicating records", async (t) => {
  const { dir, file, store } = fixture(t);
  const bytes = Buffer.from(line("one"));
  const split = bytes.indexOf(Buffer.from("模型")) + 1;
  fs.writeFileSync(file, bytes.subarray(0, split));
  assert.deepEqual(await store.readRecords(dir), []);
  fs.appendFileSync(file, bytes.subarray(split, bytes.length - 1));
  assert.deepEqual((await store.readRecords(dir)).map((r) => r.id), ["one"]);
  fs.appendFileSync(file, "\n" + line("two"));
  assert.deepEqual((await store.readRecords(dir)).map((r) => r.id), ["one", "two"]);
});

test("invalidates truncation, same-size rewrites, atomic replacement and deleted files", async (t) => {
  const { dir, file, store } = fixture(t);
  fs.writeFileSync(file, line("one") + line("two"));
  assert.equal((await store.readRecords(dir)).length, 2);
  fs.writeFileSync(file, line("new"));
  assert.deepEqual((await store.readRecords(dir)).map((r) => r.id), ["new"]);
  fs.writeFileSync(file, line("alt"));
  const changedAt = new Date(Date.now() + 1000);
  fs.utimesSync(file, changedAt, changedAt);
  assert.deepEqual((await store.readRecords(dir)).map((r) => r.id), ["alt"]);
  fs.writeFileSync(file + ".tmp", line("replacement"));
  fs.renameSync(file + ".tmp", file);
  assert.deepEqual((await store.readRecords(dir)).map((r) => r.id), ["replacement"]);
  fs.unlinkSync(file);
  assert.deepEqual(await store.readRecords(dir), []);
});

test("rebuilds after an in-place rewrite grows past the previous length", async (t) => {
  const { dir, file, store } = fixture(t);
  fs.writeFileSync(file, line("old"));
  await store.readRecords(dir);
  fs.writeFileSync(file, line("new") + line("extra"));
  assert.deepEqual((await store.readRecords(dir)).map((r) => r.id), ["new", "extra"]);
});

test("keeps zero-token requests and backdated events, skips controls and malformed rows", async (t) => {
  const { dir, file, store } = fixture(t, { maxFiles: 2 });
  fs.writeFileSync(path.join(dir, "records-2026-09-30.jsonl"), line("excluded"));
  fs.writeFileSync(path.join(dir, "records-2026-10-01.jsonl"), line("yesterday", "2026-10-01T12:00:00Z"));
  fs.writeFileSync(file, line("late", "2026-09-01T12:00:00Z") + 'broken\n{"support_refresh":true}\n{"failed":true,"tokens":{"totalTokens":0}}\n');
  const rows = await store.readRecords(dir);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.id), ["yesterday", "late"]);
  assert.equal(rows[2].failed, true);
});

test("cache size limits release oversized snapshots without truncating results", async (t) => {
  for (const options of [{ maxCachedRecords: 1 }, { maxCachedBytes: 1 }]) {
    const { dir, file, store } = fixture(t, options);
    fs.writeFileSync(file, line("one") + line("two"));
    const first = await store.readRecords(dir);
    const second = await store.readRecords(dir);
    assert.deepEqual(second, first);
    assert.notEqual(second, first);
    assert.equal(second.length, 2);
  }
});

test("releases cached history after the requests page has been idle", async (t) => {
  const { dir, file, store } = fixture(t, { idleTtlMs: 10 });
  fs.writeFileSync(file, line("one"));
  const first = await store.readRecords(dir);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await store.readRecords(dir);
  assert.deepEqual(second, first);
  assert.notEqual(second, first);
});

test("concurrent reads of different directories never share another directory's records", async (t) => {
  const { store } = fixture(t);
  const fixtures = [fixture(t), fixture(t), fixture(t)];
  fixtures.forEach(({ file }, index) => fs.writeFileSync(file, line(String(index))));
  const results = await Promise.all(fixtures.map(({ dir }) => store.readRecords(dir)));
  assert.deepEqual(results.map((rows) => rows[0].id), ["0", "1", "2"]);
});

test("time-window reads include older files without changing concurrent recent reads", async (t) => {
  const { dir, store } = fixture(t);
  for (let day = 1; day <= 30; day += 1) {
    const date = `2026-10-${String(day).padStart(2, "0")}`;
    fs.writeFileSync(path.join(dir, `records-${date}.jsonl`), line(date, `${date}T12:00:00Z`));
  }
  // Local midnight in UTC+8 falls in the previous UTC receipt file.
  const since = Date.parse("2026-10-02T00:00:00+08:00");
  const [recent, month, week] = await Promise.all([
    store.readRecords(dir),
    store.readRecords(dir, { since }),
    store.readRecords(dir, { since: Date.parse("2026-10-24T00:00:00Z") }),
  ]);
  assert.equal(recent.length, 14);
  assert.equal(month.length, 30);
  assert.equal(month.at(-1).id, "2026-10-01");
  assert.equal(week.length, 7);
  assert.equal(week.at(-1).id, "2026-10-24");
  assert.equal((await store.readRecords(dir)).length, 14);
});
