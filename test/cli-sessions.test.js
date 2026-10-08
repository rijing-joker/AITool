"use strict";

// Tests for the CLI session history reader (cc-switch session_manager port):
// per-app scanning of claude/codex/gemini session logs, transcript reading,
// and the path clamp that keeps /api/cli-sessions/read inside the app roots.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, beforeEach, afterEach } = require("node:test");

const sessions = require("../src/lib/sessions");

let tmpHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-sessions-home-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeClaudeSession(home, id, lines) {
  const projectDir = path.join(home, ".claude", "projects", "-tmp-project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), lines.join("\n") + "\n");
  return path.join(projectDir, `${id}.jsonl`);
}

test("claude sessions: scan derives title, project, timestamps and resume command", async () => {
  const filePath = writeClaudeSession(tmpHome, "session-abc", [
    JSON.stringify({ type: "file-history-snapshot", messageId: "m1", snapshot: {} }),
    JSON.stringify({ sessionId: "session-abc", cwd: "/tmp/project", timestamp: "2026-10-01T10:00:00Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" }, timestamp: "2026-10-01T10:00:01Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "How do I deploy?" }, timestamp: "2026-10-01T10:00:02Z" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Here is how..." }, timestamp: "2026-10-01T10:01:00Z" }),
  ]);

  const list = await sessions.listSessions({ app: "claude", home: tmpHome });
  assert.equal(list.length, 1);
  const meta = list[0];
  assert.equal(meta.appId, "claude");
  assert.equal(meta.sessionId, "session-abc");
  assert.equal(meta.title, "How do I deploy?", "slash commands are skipped for the title");
  assert.equal(meta.projectDir, "/tmp/project");
  assert.equal(meta.createdAt, Date.parse("2026-10-01T10:00:00Z"));
  assert.equal(meta.lastActiveAt, Date.parse("2026-10-01T10:01:00Z"));
  assert.equal(meta.resumeCommand, "claude --resume session-abc");
  assert.equal(meta.sourcePath, filePath);

  // The tail summary supplies the list preview.
  assert.equal(meta.summary, "Here is how...");
});

test("claude custom title wins and agent files are excluded", async () => {
  writeClaudeSession(tmpHome, "session-title", [
    JSON.stringify({ sessionId: "session-title", cwd: "/tmp/p", timestamp: "2026-10-01T10:00:00Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "first" }, timestamp: "2026-10-01T10:00:01Z" }),
    JSON.stringify({ type: "custom-title", customTitle: "fix-login-bug", sessionId: "session-title" }),
  ]);
  writeClaudeSession(tmpHome, "agent-side", [
    JSON.stringify({ sessionId: "agent-side", type: "user", isSidechain: true }),
  ]);

  const list = await sessions.listSessions({ app: "claude", home: tmpHome });
  assert.deepEqual(list.map((meta) => meta.sessionId), ["session-title"]);
  assert.equal(list[0].title, "fix-login-bug");
});

test("claude transcripts: tool_use renders as [Tool:], tool_result rows reclassify", async () => {
  const filePath = writeClaudeSession(tmpHome, "session-tools", [
    JSON.stringify({ sessionId: "session-tools", cwd: "/tmp/p" }),
    JSON.stringify({ message: { role: "assistant", content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ] }, timestamp: "2026-10-01T10:00:00Z" }),
    JSON.stringify({ message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: "file contents" },
    ] }, timestamp: "2026-10-01T10:00:01Z" }),
    JSON.stringify({ message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: "result" },
      { type: "text", text: "Please continue" },
    ] }, timestamp: "2026-10-01T10:00:02Z" }),
    JSON.stringify({ isMeta: true, message: { role: "user", content: "meta noise" } }),
  ]);

  const { messages } = await sessions.readSession({ app: "claude", sourcePath: filePath, home: tmpHome });
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, "assistant");
  assert.ok(messages[0].content.includes("Let me check."));
  assert.ok(messages[0].content.includes("[Tool: Read]"));
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].content, "file contents");
  assert.equal(messages[2].role, "user", "mixed tool_result + text stays user");
  assert.ok(messages[2].content.includes("Please continue"));
});

test("codex sessions: session_meta + response_item payloads scan and read", async () => {
  const root = path.join(tmpHome, ".codex", "sessions", "2026", "10", "01");
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, "rollout-2026-10-01T10-00-00-abc.jsonl");
  fs.writeFileSync(filePath, [
    JSON.stringify({ timestamp: "2026-10-01T10:00:00Z", type: "session_meta", payload: { id: "codex-1", cwd: "/tmp/cx" } }),
    JSON.stringify({ timestamp: "2026-10-01T10:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "text", text: "fix the parser" }] } }),
    JSON.stringify({ timestamp: "2026-10-01T10:00:02Z", type: "response_item", payload: { type: "function_call", name: "shell" } }),
    JSON.stringify({ timestamp: "2026-10-01T10:00:03Z", type: "response_item", payload: { type: "function_call_output", output: "ok" } }),
    JSON.stringify({ timestamp: "2026-10-01T10:00:04Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "done" }] } }),
    JSON.stringify({ timestamp: "2026-10-01T10:00:05Z", type: "turn_context", payload: { cwd: "/tmp/cx" } }),
  ].join("\n") + "\n");

  const list = await sessions.listSessions({ app: "codex", home: tmpHome });
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, "codex-1");
  assert.equal(list[0].title, "fix the parser");
  assert.equal(list[0].summary, "done");
  assert.equal(list[0].resumeCommand, "codex resume codex-1");

  const { messages } = await sessions.readSession({ app: "codex", sourcePath: filePath, home: tmpHome });
  assert.deepEqual(messages.map((msg) => [msg.role, msg.content]), [
    ["user", "fix the parser"],
    ["assistant", ""],
    ["tool", "ok"],
    ["assistant", "done"],
  ]);
  assert.deepEqual(messages[1].toolCalls, [{ callId: null, name: "shell", arguments: null }]);
  assert.deepEqual(messages[2].toolResults, [{ callId: null, output: "ok" }]);
});

test("gemini sessions: tmp/<project>/chats scans .json and maps toolCalls", async () => {
  const chats = path.join(tmpHome, ".gemini", "tmp", "hash1", "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(path.dirname(chats), ".project_root"), "/tmp/gem");
  const filePath = path.join(chats, "session-2026-10-01.json");
  fs.writeFileSync(filePath, JSON.stringify({
    sessionId: "gem-1",
    startTime: "2026-10-01T10:00:00Z",
    lastUpdated: "2026-10-01T10:05:00Z",
    messages: [
      { type: "user", content: "hi gemini", timestamp: "2026-10-01T10:00:00Z" },
      { type: "info", content: "skipped" },
      { type: "gemini", content: [{ text: "hello" }], toolCalls: [{ name: "read_file" }], timestamp: "2026-10-01T10:01:00Z" },
    ],
  }));

  const list = await sessions.listSessions({ app: "gemini", home: tmpHome });
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, "gem-1");
  assert.equal(list[0].title, "hi gemini");
  assert.equal(list[0].projectDir, "/tmp/gem");
  assert.equal(list[0].resumeCommand, "gemini --resume gem-1");

  const { messages } = await sessions.readSession({ app: "gemini", sourcePath: filePath, home: tmpHome });
  assert.deepEqual(messages.map((msg) => [msg.role, msg.content]), [
    ["user", "hi gemini"],
    ["assistant", "hello"],
  ]);
  assert.deepEqual(messages[1].toolCalls, [{ name: "read_file", args: null }]);
});

test("sessions sort newest first and app availability is reported", async () => {
  const project = path.join(tmpHome, ".claude", "projects", "-p");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "old.jsonl"), JSON.stringify({ sessionId: "old", timestamp: "2026-09-01T10:00:00Z" }) + "\n");
  fs.writeFileSync(path.join(project, "new.jsonl"), JSON.stringify({ sessionId: "new", timestamp: "2026-10-01T10:00:00Z" }) + "\n");

  const list = await sessions.listSessions({ app: "claude", home: tmpHome });
  assert.deepEqual(list.map((meta) => meta.sessionId), ["new", "old"]);

  const apps = sessions.listSessionApps({ home: tmpHome });
  assert.deepEqual(apps, [
    { id: "claude", available: true },
    { id: "codex", available: false },
    { id: "gemini", available: false },
  ]);
  assert.deepEqual(sessions.listSessionApps({ home: null, env: {} }), [
    { id: "claude", available: false },
    { id: "codex", available: false },
    { id: "gemini", available: false },
  ]);
});

test("thinking blocks: claude thinking items, codex reasoning items, gemini thought parts", async () => {
  // claude — thinking items join the row's thinking field, not the content.
  const claudePath = writeClaudeSession(tmpHome, "thinking-claude", [
    JSON.stringify({ sessionId: "thinking-claude", cwd: "/tmp/project", timestamp: "2026-10-01T10:00:00Z" }),
    JSON.stringify({ message: { role: "assistant", content: [
      { type: "thinking", thinking: "I should check the parser first." },
      { type: "text", text: "On it." },
    ] }, timestamp: "2026-10-01T10:00:01Z" }),
  ]);
  const claude = await sessions.readSession({ app: "claude", sourcePath: claudePath, home: tmpHome });
  assert.equal(claude.messages.length, 1);
  assert.equal(claude.messages[0].content, "On it.");
  assert.equal(claude.messages[0].thinking, "I should check the parser first.");

  // codex — reasoning response items become standalone thinking rows.
  const codexRoot = path.join(tmpHome, ".codex", "sessions", "2026", "10", "01");
  fs.mkdirSync(codexRoot, { recursive: true });
  const codexPath = path.join(codexRoot, "rollout-2026-10-01T10-00-00-think.jsonl");
  fs.writeFileSync(codexPath, [
    JSON.stringify({ timestamp: "2026-10-01T10:00:00Z", type: "session_meta", payload: { id: "codex-think", cwd: "/tmp/cx" } }),
    JSON.stringify({ timestamp: "2026-10-01T10:00:01Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Plan: patch the lexer." }] } }),
    JSON.stringify({ timestamp: "2026-10-01T10:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "done" }] } }),
  ].join("\n") + "\n");
  const codex = await sessions.readSession({ app: "codex", sourcePath: codexPath, home: tmpHome });
  assert.deepEqual(codex.messages.map((msg) => [msg.role, msg.content, msg.thinking ?? null]), [
    ["assistant", "", "Plan: patch the lexer."],
    ["assistant", "done", null],
  ]);

  // gemini — thought:true parts split out of the content array.
  const geminiRoot = path.join(tmpHome, ".gemini", "tmp", "proj", "chats");
  fs.mkdirSync(geminiRoot, { recursive: true });
  const geminiPath = path.join(geminiRoot, "chat-think.jsonl");
  fs.writeFileSync(geminiPath, [
    JSON.stringify({ sessionId: "gemini-think", startTime: "2026-10-01T10:00:00Z", lastUpdated: "2026-10-01T10:01:00Z" }),
    JSON.stringify({ id: "g1", type: "gemini", content: [
      { text: "Let me think.", thought: true },
      { text: "Here is the answer." },
    ], timestamp: "2026-10-01T10:00:30Z" }),
  ].join("\n") + "\n");
  const gemini = await sessions.readSession({ app: "gemini", sourcePath: geminiPath, home: tmpHome });
  assert.equal(gemini.messages.length, 1);
  assert.equal(gemini.messages[0].content, "Here is the answer.");
  assert.equal(gemini.messages[0].thinking, "Let me think.");
});

test("readSession refuses paths outside the app roots and unsupported apps", async () => {
  await assert.rejects(
    () => sessions.readSession({ app: "claude", sourcePath: path.join(tmpHome, ".claude", "settings.json"), home: tmpHome }),
    /outside this app's session roots|Not a session transcript/,
  );
  await assert.rejects(
    () => sessions.readSession({ app: "claude", sourcePath: path.join(tmpHome, ".ssh", "id_rsa"), home: tmpHome }),
    /outside this app's session roots/,
  );
  await assert.rejects(
    () => sessions.readSession({ app: "opencode", sourcePath: "/tmp/x.jsonl", home: tmpHome }),
    /Unsupported app/,
  );
  await assert.rejects(
    () => sessions.readSession({ app: "claude", sourcePath: "", home: tmpHome }),
    /required/,
  );
  // Traversal through a symlink-ish relative path stays clamped.
  const outside = path.join(tmpHome, "secrets.jsonl");
  fs.writeFileSync(outside, "{}\n");
  await assert.rejects(
    () => sessions.readSession({ app: "claude", sourcePath: outside, home: tmpHome }),
    /outside this app's session roots/,
  );
});

test("session usage: claude dedupes retries, codex takes the last cumulative count, gemini sums", async () => {
  // Claude: two writes of the same assistant message id keep the larger
  // output; usage fields are independent of input (fresh-input semantics).
  const claudePath = writeClaudeSession(tmpHome, "session-usage", [
    JSON.stringify({ sessionId: "session-usage", cwd: "/tmp/p", timestamp: "2026-10-01T10:00:00Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "go" }, timestamp: "2026-10-01T10:00:01Z" }),
    JSON.stringify({ type: "assistant", timestamp: "2026-10-01T10:00:02Z", message: { id: "msg_1", role: "assistant", model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 }, content: [{ type: "text", text: "partial" }] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-10-01T10:00:03Z", message: { id: "msg_1", role: "assistant", model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 60, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 }, content: [{ type: "text", text: "final" }] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-10-01T10:00:10Z", message: { id: "msg_2", role: "assistant", model: "claude-sonnet-5", usage: { input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "more" }] } }),
  ]);
  const claude = await sessions.readSession({ app: "claude", sourcePath: claudePath, home: tmpHome });
  assert.deepEqual(
    { inputTokens: claude.usage.inputTokens, outputTokens: claude.usage.outputTokens, cacheReadTokens: claude.usage.cacheReadTokens, cacheCreationTokens: claude.usage.cacheCreationTokens, totalTokens: claude.usage.totalTokens, durationMs: claude.usage.durationMs, model: claude.usage.model, inputInclusive: claude.usage.inputInclusive },
    { inputTokens: 120, outputTokens: 90, cacheReadTokens: 900, cacheCreationTokens: 10, totalTokens: 1120, durationMs: 10000, model: "claude-sonnet-5", inputInclusive: false },
  );

  // Codex: token_count events carry cumulative totals; the last one wins and
  // the model comes from turn_context. Input includes cached tokens.
  const codexRoot = path.join(tmpHome, ".codex", "sessions", "2026", "10", "01");
  fs.mkdirSync(codexRoot, { recursive: true });
  const codexPath = path.join(codexRoot, "rollout-usage.jsonl");
  fs.writeFileSync(codexPath, [
    JSON.stringify({ timestamp: "2026-10-01T11:00:00Z", type: "session_meta", payload: { id: "codex-usage", cwd: "/tmp/c" } }),
    JSON.stringify({ timestamp: "2026-10-01T11:00:01Z", type: "turn_context", payload: { model: "gpt-5.2" } }),
    JSON.stringify({ timestamp: "2026-10-01T11:00:02Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 150 } } } }),
    JSON.stringify({ timestamp: "2026-10-01T11:00:20Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 140, output_tokens: 90, reasoning_output_tokens: 40, total_tokens: 390 } } } }),
  ].join("\n") + "\n");
  const codex = await sessions.readSession({ app: "codex", sourcePath: codexPath, home: tmpHome });
  assert.deepEqual(
    { inputTokens: codex.usage.inputTokens, cacheReadTokens: codex.usage.cacheReadTokens, outputTokens: codex.usage.outputTokens, reasoningTokens: codex.usage.reasoningTokens, totalTokens: codex.usage.totalTokens, model: codex.usage.model, inputInclusive: codex.usage.inputInclusive, durationMs: codex.usage.durationMs },
    { inputTokens: 300, cacheReadTokens: 140, outputTokens: 90, reasoningTokens: 40, totalTokens: 390, model: "gpt-5.2", inputInclusive: true, durationMs: 20000 },
  );

  // Gemini: per-message tokens are summed; input includes cached tokens.
  const chats = path.join(tmpHome, ".gemini", "tmp", "hashU", "chats");
  fs.mkdirSync(chats, { recursive: true });
  const geminiPath = path.join(chats, "session-usage.json");
  fs.writeFileSync(geminiPath, JSON.stringify({
    sessionId: "gem-usage",
    startTime: "2026-10-01T12:00:00Z",
    lastUpdated: "2026-10-01T12:01:00Z",
    messages: [
      { type: "user", content: "yo", timestamp: "2026-10-01T12:00:00Z" },
      { type: "gemini", content: "sup", model: "gemini-3-pro", timestamp: "2026-10-01T12:00:30Z", tokens: { input: 500, output: 100, thoughts: 30, cached: 200 } },
      { type: "gemini", content: "again", model: "gemini-3-pro", timestamp: "2026-10-01T12:00:50Z", tokens: { input: 100, output: 20, thoughts: 0, cached: 0 } },
    ],
  }));
  const gemini = await sessions.readSession({ app: "gemini", sourcePath: geminiPath, home: tmpHome });
  assert.deepEqual(
    { inputTokens: gemini.usage.inputTokens, cacheReadTokens: gemini.usage.cacheReadTokens, outputTokens: gemini.usage.outputTokens, reasoningTokens: gemini.usage.reasoningTokens, totalTokens: gemini.usage.totalTokens, model: gemini.usage.model, durationMs: gemini.usage.durationMs },
    { inputTokens: 600, cacheReadTokens: 200, outputTokens: 120, reasoningTokens: 30, totalTokens: 750, model: "gemini-3-pro", durationMs: 60000 },
  );
});

test("sessions without usage data return null usage", async () => {
  const filePath = writeClaudeSession(tmpHome, "session-nousage", [
    JSON.stringify({ sessionId: "session-nousage", cwd: "/tmp/p", timestamp: "2026-10-01T10:00:00Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "plain question" }, timestamp: "2026-10-01T10:00:01Z" }),
  ]);
  const { usage } = await sessions.readSession({ app: "claude", sourcePath: filePath, home: tmpHome });
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.model, null);
  assert.equal(usage.durationMs, 1000);
});

test("claude session usage keeps a per-model breakdown for mixed-model sessions", async () => {
  const filePath = writeClaudeSession(tmpHome, "session-mixed", [
    JSON.stringify({ sessionId: "session-mixed", cwd: "/tmp/p", timestamp: "2026-10-01T10:00:00Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "go" }, timestamp: "2026-10-01T10:00:01Z" }),
    JSON.stringify({ type: "assistant", timestamp: "2026-10-01T10:00:02Z", message: { id: "m1", role: "assistant", model: "claude-opus-4-6", usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: "text", text: "main" }] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-10-01T10:00:03Z", message: { id: "m2", role: "assistant", model: "claude-haiku-4-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "side" }] } }),
  ]);
  const { usage } = await sessions.readSession({ app: "claude", sourcePath: filePath, home: tmpHome });
  assert.deepEqual(usage.perModel, [
    { model: "claude-opus-4-6", inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { model: "claude-haiku-4-5", inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
  assert.equal(usage.model, "claude-opus-4-6");
});

test("a retried claude row with a stop_reason beats a larger streaming snapshot without one", async () => {
  const filePath = writeClaudeSession(tmpHome, "session-stopreason", [
    JSON.stringify({ sessionId: "session-stopreason", cwd: "/tmp/p" }),
    JSON.stringify({ type: "assistant", timestamp: "2026-10-01T10:00:02Z", message: { id: "m1", role: "assistant", model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 90 }, content: [{ type: "text", text: "partial" }] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-10-01T10:00:03Z", message: { id: "m1", role: "assistant", model: "claude-sonnet-5", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 40 }, content: [{ type: "text", text: "final" }] } }),
  ]);
  const { usage } = await sessions.readSession({ app: "claude", sourcePath: filePath, home: tmpHome });
  assert.equal(usage.outputTokens, 40);
  // Id-less assistant usage rows are skipped, matching the upstream importer.
  const noIdPath = writeClaudeSession(tmpHome, "session-noid", [
    JSON.stringify({ sessionId: "session-noid", cwd: "/tmp/p" }),
    JSON.stringify({ type: "assistant", timestamp: "2026-10-01T10:00:04Z", message: { role: "assistant", model: "claude-sonnet-5", usage: { input_tokens: 999, output_tokens: 999 }, content: [{ type: "text", text: "synthetic" }] } }),
  ]);
  const noId = await sessions.readSession({ app: "claude", sourcePath: noIdPath, home: tmpHome });
  assert.equal(noId.usage.totalTokens, 0);
  assert.deepEqual(noId.usage.perModel, []);
});

test("gemini JSONL chats: replay upserts, $set, rewindTo, and stale .json dedupe", async () => {
  const chats = path.join(tmpHome, ".gemini", "tmp", "hash2", "chats");
  fs.mkdirSync(chats, { recursive: true });
  const filePath = path.join(chats, "session-2026-10-02.jsonl");
  const lines = [
    JSON.stringify({ sessionId: "gem-2", startTime: "2026-10-02T09:00:00Z", lastUpdated: "2026-10-02T09:01:00Z" }),
    JSON.stringify({ id: "m1", type: "user", content: "<session_context>injected</session_context>", timestamp: "2026-10-02T09:00:00Z" }),
    JSON.stringify({ id: "m2", type: "user", content: "/help", timestamp: "2026-10-02T09:00:01Z" }),
    JSON.stringify({ id: "m3", type: "user", content: "real prompt", timestamp: "2026-10-02T09:00:02Z" }),
    JSON.stringify({ id: "m4", type: "gemini", content: "draft", tokens: { input: 10, output: 5, thoughts: 0, cached: 2 }, model: "gemini-x", timestamp: "2026-10-02T09:00:30Z" }),
    JSON.stringify({ id: "m4", type: "gemini", content: "final answer", tokens: { input: 12, output: 9, thoughts: 3, cached: 2 }, model: "gemini-x", timestamp: "2026-10-02T09:00:40Z" }),
    JSON.stringify({ $set: { lastUpdated: "2026-10-02T09:05:00Z" } }),
  ].join("\n") + "\n";
  fs.writeFileSync(filePath, lines);
  // stale pre-migration .json with the same stem must not double-list
  fs.writeFileSync(path.join(chats, "session-2026-10-02.json"), JSON.stringify({ sessionId: "gem-2", messages: [] }));

  const list = await sessions.listSessions({ app: "gemini", home: tmpHome });
  const entry = list.find((session) => session.sessionId === "gem-2");
  assert.ok(entry, "jsonl session is listed");
  assert.equal(entry.title, "real prompt", "injected context and slash commands are skipped for the title");
  assert.equal(entry.lastActiveAt, Date.parse("2026-10-02T09:05:00Z"), "$set merges metadata");

  const { messages, usage } = await sessions.readSession({ app: "gemini", sourcePath: filePath, home: tmpHome });
  assert.equal(messages.filter((msg) => msg.role === "assistant").length, 1, "same-id upsert overwrites in place");
  const assistant = messages.find((msg) => msg.role === "assistant");
  assert.equal(assistant.content, "final answer");
  assert.deepEqual(assistant.usage, { inputTokens: 12, outputTokens: 9, reasoningTokens: 3, cacheReadTokens: 2 });
  assert.equal(usage.inputTokens, 12, "tokens counted once after the upsert");
  assert.equal(usage.model, "gemini-x");
});

test("gemini JSONL rewindTo truncates the message list", async () => {
  const chats = path.join(tmpHome, ".gemini", "tmp", "hash3", "chats");
  fs.mkdirSync(chats, { recursive: true });
  const filePath = path.join(chats, "session-r.jsonl");
  fs.writeFileSync(filePath, [
    JSON.stringify({ sessionId: "gem-r", startTime: "2026-10-02T10:00:00Z" }),
    JSON.stringify({ id: "a", type: "user", content: "first" }),
    JSON.stringify({ id: "b", type: "gemini", content: "reply" }),
    JSON.stringify({ id: "c", type: "user", content: "second" }),
    JSON.stringify({ $rewindTo: "a" }),
  ].join("\n") + "\n");
  const { messages } = await sessions.readSession({ app: "gemini", sourcePath: filePath, home: tmpHome });
  assert.deepEqual(messages.map((msg) => msg.content), ["first"]);
});

test("claude transcripts carry structured tool calls/results and per-message usage", async () => {
  const root = path.join(tmpHome, ".claude", "projects", "-p-structured");
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, "s-structured.jsonl");
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: "user", message: { role: "user", content: "list files" }, timestamp: "2026-10-03T10:00:00Z" }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1", role: "assistant", model: "claude-x",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
        ],
        usage: { input_tokens: 10, output_tokens: 4 },
      },
      timestamp: "2026-10-03T10:00:05Z",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1", role: "assistant", model: "claude-x",
        content: [{ type: "text", text: "checking" }],
        usage: { input_tokens: 10, output_tokens: 6 },
      },
      timestamp: "2026-10-03T10:00:06Z",
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file.txt" }] },
      timestamp: "2026-10-03T10:00:07Z",
    }),
  ].join("\n") + "\n");

  const { messages, usage } = await sessions.readSession({ app: "claude", sourcePath: filePath, home: tmpHome });
  const assistant = messages.find((msg) => msg.role === "assistant");
  assert.deepEqual(assistant.toolCalls, [{ id: "tu_1", name: "Bash", input: { command: "ls" } }]);
  // flattened text keeps the inline [Tool:] marker for plain-text rendering
  assert.equal(assistant.content, "checking\n[Tool: Bash]");
  // retry rule picks the stop-reason-less row with the larger output… here
  // the later row (6) wins; it must ride on the visible message row too.
  assert.deepEqual(assistant.usage, { inputTokens: 10, outputTokens: 6, cacheReadTokens: 0, cacheCreationTokens: 0 });
  assert.equal(assistant.model, "claude-x");
  const tool = messages.find((msg) => msg.role === "tool");
  assert.deepEqual(tool.toolResults, [{ toolUseId: "tu_1", content: "file.txt" }]);
  assert.equal(usage.outputTokens, 6);
});

test("claude image extraction: data URLs, per-image cap and session budget", async () => {
  const small = Buffer.from("tiny-image").toString("base64");
  const filePath = writeClaudeSession(tmpHome, "session-img2", [
    JSON.stringify({ sessionId: "session-img2", cwd: "/tmp/p", timestamp: "2026-10-01T10:00:00Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "text", text: "screenshot attached" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: small } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(2 * 1024 * 1024 + 4) } },
    ] }, timestamp: "2026-10-01T10:00:01Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("second").toString("base64") } },
    ] }, timestamp: "2026-10-01T10:00:02Z" }),
  ]);

  const session = await sessions.readSession({ app: "claude", sourcePath: filePath, home: tmpHome });
  const withImages = session.messages.filter((row) => row.images);
  assert.equal(withImages.length, 2);
  const [first, second] = withImages;
  assert.equal(first.images.length, 2);
  assert.equal(first.images[0].dataUrl, `data:image/png;base64,${small}`);
  assert.equal(first.images[1].oversized, true, "over the per-image cap");
  assert.equal(second.images[0].dataUrl, `data:image/jpeg;base64,${Buffer.from("second").toString("base64")}`);
  assert.equal(session.messages.find((row) => row.content === "screenshot attached").content, "screenshot attached");
});

test("codex apply_patch: counts stop at End Patch, Add-file minus lines are content, failure outputs mark errors", async () => {
  const projectDir = path.join(tmpHome, ".codex", "sessions", "2026", "10", "01");
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, "rollout-patch.jsonl");
  const patch = [
    "*** Begin Patch",
    "*** Add File: new.txt",
    "+added line 1",
    "-not a deletion inside Add hunks",
    "*** Update File: old.txt",
    "+kept",
    "-dropped",
    "*** Delete File: gone.txt",
    "*** End Patch",
    "+counting must stop here",
  ].join("\n");
  const lines = [
    JSON.stringify({ timestamp: "2026-10-01T10:00:00Z", type: "session_meta", payload: { id: "patch", cwd: "/tmp/p" } }),
    JSON.stringify({ timestamp: "2026-10-01T10:00:01Z", type: "response_item", payload: { type: "function_call", call_id: "c1", name: "apply_patch", arguments: patch } }),
    JSON.stringify({ timestamp: "2026-10-01T10:00:02Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "apply_patch verification failed" } }),
    JSON.stringify({ timestamp: "2026-10-01T10:00:03Z", type: "response_item", payload: { type: "function_call", call_id: "c2", name: "apply_patch", arguments: patch } }),
    JSON.stringify({ timestamp: "2026-10-01T10:00:04Z", type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: "success. Updated the following files:" } }),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n");

  const session = await sessions.readSession({ app: "codex", sourcePath: filePath, home: tmpHome });
  const callRows = session.messages.filter((row) => row.toolCalls?.some((call) => call.patch));
  assert.equal(callRows.length, 2);
  const [failed, ok] = callRows.map((row) => row.toolCalls[0].patch);
  assert.deepEqual(failed.files.map((f) => f.path), ["new.txt", "old.txt", "gone.txt"]);
  assert.equal(failed.additions, 2, "Add-hunk `-` line skipped, Update hunk +1, Add hunk +1");
  assert.equal(failed.deletions, 1, "only the Update-hunk deletion counts");
  assert.equal(failed.error, true);
  assert.equal(ok.error, false);
  assert.equal(failed.status, "failed");
  assert.equal(ok.status, "success");
});

test("claude image budget is shared and unsafe or invalid attachments are ignored", async () => {
  const image = (data, media_type = "image/png") => ({ type: "image", source: { type: "base64", data, media_type } });
  const large = "A".repeat(2 * 1024 * 1024);
  const sourcePath = writeClaudeSession(tmpHome, "image-budget", [
    ...Array.from({ length: 5 }, () => JSON.stringify({ type: "user", message: { role: "user", content: [image(large)] } })),
    JSON.stringify({ type: "user", message: { role: "user", content: [
      image(""), image("not base64!!"), image("AAAA", "image/svg+xml"), image("AAAA", "text/html"),
      { type: "image", source: { type: "url", url: "https://example.com/private.png" } },
    ] } }),
  ]);
  const { messages } = await sessions.readSession({ app: "claude", sourcePath, home: tmpHome });
  assert.equal(messages.length, 5);
  assert.equal(messages.filter((row) => row.images[0].dataUrl).length, 4);
  assert.equal(messages[4].images[0].oversized, true);
  assert.equal(messages[0].images[0].byteLength, 1572864);
});

test("codex custom calls and JSON patches retain pending, failed and successful outcomes", async () => {
  const dir = path.join(tmpHome, ".codex", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = path.join(dir, "custom-patches.jsonl");
  const patch = "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n+++literal\n---literal\n*** End Patch\n+ignored";
  const calls = [
    { type: "custom_tool_call", name: "apply_patch", call_id: "pending", input: patch },
    { type: "function_call", name: "apply_patch", call_id: "json", arguments: JSON.stringify({ patch }) },
    { type: "custom_tool_call", name: "apply_patch", call_id: "rejected", input: patch },
    { type: "custom_tool_call", name: "apply_patch", call_id: "exit", input: patch },
    { type: "custom_tool_call_output", call_id: "rejected", output: "patch rejected by user" },
    { type: "function_call_output", call_id: "json", output: [{ type: "input_text", text: "Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM old.txt" }] },
    { type: "custom_tool_call_output", call_id: "exit", output: "Exit code: 1\nOutput:\nInvalid patch" },
  ];
  fs.writeFileSync(sourcePath, calls.map((payload) => JSON.stringify({ type: "response_item", payload })).join("\n"));
  const { messages } = await sessions.readSession({ app: "codex", sourcePath, home: tmpHome });
  const patches = Object.fromEntries(messages.flatMap((row) => (row.toolCalls || []).map((call) => [call.callId, call.patch])));
  assert.equal(patches.pending.status, "pending");
  assert.equal(patches.json.status, "success");
  assert.equal(patches.rejected.status, "failed");
  assert.equal(patches.exit.status, "failed");
  assert.equal(patches.json.additions, 1);
  assert.equal(patches.json.deletions, 1);
  assert.equal(patches.json.files[0].moveTo, "new.txt");
  assert.ok(patches.json.body.endsWith("*** End Patch"));
});
