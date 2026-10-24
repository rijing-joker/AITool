"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { test } = require("node:test");
const { TranscriptCache, previewTranscript, contentPage } = require("../src/lib/session-transcript-cache");
const { readSession, readSessionContent } = require("../src/lib/sessions");

test("transcript LRU refreshes reads, bounds bytes, and isolates consumer annotations", () => {
  const cache = new TranscriptCache({ maxEntries: 2, maxBytes: 100 });
  cache.set("a", "1", { content: "a" });
  cache.set("b", "1", { content: "b" });
  cache.get("a", "1").content = "modified";
  cache.set("c", "1", { content: "c" });
  assert.equal(cache.get("b", "1"), null);
  assert.equal(cache.get("a", "1").content, "a");
  assert.equal(cache.get("a", "2"), null);
  cache.set("big", "1", { content: "x".repeat(101) });
  assert.equal(cache.get("big", "1"), null);
  cache.set("d", "1", { content: "d".repeat(65) });
  assert.equal(cache.entries.size, 2);
  assert.ok(cache.bytes <= 100);
});

test("previews preserve full originals and range reads are bounded and versioned", () => {
  const content = "x".repeat(300000) + "tail";
  const session = { revision: "v1", messages: [{ role: "tool", content, toolResults: [{ content }] }] };
  const preview = previewTranscript(session);
  assert.equal(preview.messages[0].content.length, 1200);
  assert.equal(preview.messages[0].contentRef.id, "0:content");
  assert.equal(preview.messages[0].toolResults[0].contentRef.id, "0:result:0:content");
  assert.equal(session.messages[0].content, content);
  const first = contentPage(session, { revision: "v1", ref: "0:content", limit: 500000 });
  assert.equal(first.content.length, 128 * 1024);
  assert.equal(first.complete, false);
  assert.equal(contentPage(session, { revision: "v1", ref: "0:result:0:content", offset: 300000 }).content, "tail");
  for (const options of [{ revision: "v2", ref: "0:content" }, { revision: "v1", ref: "0:images" },
    { revision: "v1", ref: "0:content", offset: -1 }, { revision: "v1", ref: "0:content", offset: "NaN" }]) {
    assert.throws(() => contentPage(session, options));
  }
});
test("large tool parameters and patches are versioned lazy fields with exact complete sources", () => {
  const text = "x".repeat(300000) + "TOOLTAIL";
  const session = { revision: "v1", messages: [{ role: "assistant", content: "", toolCalls: [{ name: "apply_patch", input: text, arguments: text, args: { text }, patch: { body: text } }], toolResults: [{ structuredPatch: [{ lines: [text] }], diff: text }] }] };
  const preview = previewTranscript(session), call = preview.messages[0].toolCalls[0], result = preview.messages[0].toolResults[0];
  assert.ok(JSON.stringify(preview).length < 6000);
  assert.deepEqual(call.patch, {}); assert.equal(result.structuredPatch, undefined);
  for (const [ref, value] of [[call.inputRef, text], [call.argumentsRef, text], [call.argsRef, JSON.stringify({ text })], [call.patchRef, JSON.stringify({ body: text })], [result.structuredPatchRef, JSON.stringify([{ lines: [text] }])]]) {
    let loaded = "";
    while (loaded.length < ref.length) loaded += contentPage(session, { revision: "v1", ref: ref.id, offset: loaded.length }).content;
    assert.equal(loaded, value);
  }
  assert.equal(session.messages[0].toolCalls[0].patch.body, text);
});
test("large Codex patch previews retain metadata for outcomes without exit codes", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-patch-preview-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".codex/sessions"); await fs.mkdir(root, { recursive: true });
  const body = "*** Begin Patch\n*** Update File: app.js\n@@\n" + "-old\n+new\n".repeat(600) + "*** End Patch";
  for (const [status, output] of [["failed", "apply_patch verification failed: Expected lines were not found"], ["success", "Success. Updated the following files:\nM app.js"], ["pending", "Awaiting approval"]]) {
    const sourcePath = path.join(root, `${status}.jsonl`);
    const rows = [
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: body } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "patch", output } },
    ];
    await fs.writeFile(sourcePath, rows.map(row => JSON.stringify(row)).join("\n"));
    const options = { app: "codex", home, sourcePath };
    const full = await readSession(options), preview = await readSession({ ...options, preview: true });
    const call = preview.messages[0].toolCalls[0];
    assert.equal(preview.messages[1].toolResults[0].exitCode, undefined);
    assert.deepEqual(call.patch, { files: [{ kind: "update", path: "app.js" }], additions: 600, deletions: 600, status, error: status === "failed" });
    assert.equal(call.patch.body, undefined);
    assert.deepEqual(JSON.parse(contentPage(full, { revision: full.revision, ref: call.patchRef.id }).content), full.messages[0].toolCalls[0].patch);
    call.patch.files[0].path = "changed.js";
    assert.equal((await readSession(options)).messages[0].toolCalls[0].patch.files[0].path, "app.js");
  }
});
test("unrelated Codex edits do not invalidate a transcript but its own pages do", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-related-revision-")); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".codex/sessions"); await fs.mkdir(root, { recursive: true });
  const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
  const sourcePath = path.join(root, `rollout-2026-10-20-${a}.jsonl`), unrelated = path.join(root, `rollout-2026-10-20-${b}.jsonl`);
  const line = text => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }) + "\n";
  await fs.writeFile(sourcePath, line("x".repeat(5000))); await fs.writeFile(unrelated, line("other"));
  const options = { app: "codex", home, sourcePath };
  const first = await readSession({ ...options, preview: true });
  await fs.appendFile(unrelated, line("active"));
  assert.equal((await readSession(options)).revision, first.revision);
  await fs.writeFile(path.join(root, `rollout-2026-10-21-${b}_33333333-3333-4333-8333-333333333333.jsonl`), line("new unrelated page"));
  assert.equal((await readSession(options)).revision, first.revision);
  assert.equal((await readSessionContent({ ...options, revision: first.revision, ref: "0:content" })).total, 5000);
  await fs.writeFile(path.join(root, `rollout-2026-10-21-${a}_44444444-4444-4444-8444-444444444444.jsonl`), line("new related page"));
  assert.notEqual((await readSession(options)).revision, first.revision);
});

test("cached session contents revalidate roots, refresh on edits and retain full thinking", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-content-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const sourcePath = path.join(home, ".claude/projects/p/session.jsonl");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  const thinking = "think\n".repeat(40000) + "THINKINGTAIL";
  await fs.writeFile(sourcePath, JSON.stringify({ message: { role: "assistant", content: [{ type: "thinking", thinking }] } }));
  const options = { app: "claude", home, sourcePath };
  const preview = await readSession({ ...options, preview: true });
  assert.equal(preview.messages[0].thinking.length, 1200);
  const reference = preview.messages[0].thinkingRef;
  const page = await readSessionContent({ ...options, revision: preview.revision, ref: reference.id, offset: reference.length - 12 });
  assert.ok(page.content.includes("THINKINGTAIL"));
  const full = await readSession(options);
  assert.equal(full.messages[0].thinking, thinking);
  full.messages[0].thinking = "tampered";
  assert.equal((await readSession(options)).messages[0].thinking, thinking);
  await fs.writeFile(sourcePath, JSON.stringify({ message: { role: "user", content: "changed" } }));
  await assert.rejects(readSessionContent({ ...options, revision: preview.revision, ref: reference.id }), /changed/);
  assert.equal((await readSession(options)).messages[0].content, "changed");
  const outside = path.join(home, "outside.jsonl");
  await fs.copyFile(sourcePath, outside);
  await fs.unlink(sourcePath);
  await fs.symlink(outside, sourcePath);
  await assert.rejects(readSession(options), /outside/);
  await assert.rejects(readSessionContent({ ...options, revision: preview.revision, ref: reference.id }), /outside/);
});

test("local API keeps full reads compatible and exposes root-clamped paged previews", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-content-api-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  });
  const sourcePath = path.join(home, ".claude/projects/p/session.jsonl");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  const content = "body\n".repeat(1000) + "APITAIL";
  await fs.writeFile(sourcePath, JSON.stringify({ message: { role: "assistant", content } }));
  const handler = require("../src/lib/local-api").createLocalApiHandler({ queuePath: path.join(home, "queue.jsonl") });
  const request = async (route, params) => {
    const url = new URL(route, "http://127.0.0.1");
    url.search = new URLSearchParams(params).toString();
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = JSON.parse(body); } };
    await handler({ method: "GET", headers: {} }, res, url);
    return res;
  };
  const params = { app: "claude", path: sourcePath };
  const full = await request("/api/cli-sessions/read", params);
  assert.equal(full.body.messages[0].content, content);
  const preview = await request("/api/cli-sessions/read", { ...params, preview: "1" });
  assert.equal(preview.body.messages[0].content.length, 1200);
  assert.equal(preview.headers["Cache-Control"], "no-store");
  const range = { ...params, revision: preview.body.revision, ref: "0:content", offset: String(content.length - 7) };
  const tail = await request("/api/cli-sessions/content", range);
  assert.equal(tail.body.content, "APITAIL");
  assert.equal(tail.body.complete, true);
  const outside = await request("/api/cli-sessions/content", { ...range, path: path.join(home, "outside.jsonl") });
  assert.equal(outside.status, 400);
  assert.equal(outside.body.ok, false);
});
