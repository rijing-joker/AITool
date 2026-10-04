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
    ["assistant", "[Tool: shell]"],
    ["tool", "ok"],
    ["assistant", "done"],
  ]);
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
    ["assistant", "hello\n[Tool: read_file]"],
  ]);
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
