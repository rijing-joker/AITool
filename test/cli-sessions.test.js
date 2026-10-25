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

test("Windows USERPROFILE supports session discovery and reading without HOME", async () => {
  const sourcePath = writeClaudeSession(tmpHome, "windows", [
    JSON.stringify({ sessionId: "windows", type: "user", message: { role: "user", content: "hello" } }),
  ]);
  const env = { USERPROFILE: tmpHome };
  assert.equal(sessions.listSessionApps({ env }).find((app) => app.id === "claude").available, true);
  assert.equal((await sessions.listSessions({ app: "claude", env }))[0].sourcePath, sourcePath);
  assert.equal((await sessions.readSession({ app: "claude", sourcePath, env })).messages[0].content, "hello");
  assert.deepEqual(await sessions.listSessions({ app: "claude", env: {} }), []);
  assert.deepEqual(await sessions.listSessions({ app: "claude", env: { ...env, HOME: path.join(tmpHome, "empty") } }), []);
  assert.equal((await sessions.listSessions({ app: "claude", home: tmpHome, env: { HOME: "/missing", USERPROFILE: "/missing" } })).length, 1);
});

test("Codex separates injected context from real and IDE-wrapped questions and titles", async () => {
  const dir = path.join(tmpHome, ".codex", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = path.join(dir, "injected.jsonl");
  const rows = [
    { type: "session_meta", payload: { id: "injected", cwd: "/project" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "# AGENTS.md instructions for /project\nFollow repository conventions." },
      { type: "input_text", text: "<environment_context>cwd: /project</environment_context>" },
      { type: "input_text", text: "Fix the session reader." },
    ] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "<user_instructions><user_prompt>Also add keyboard navigation.</user_prompt></user_instructions>" },
    ] } },
  ];
  fs.writeFileSync(sourcePath, rows.map(row => JSON.stringify(row)).join("\n"));
  assert.equal((await sessions.listSessions({ app: "codex", home: tmpHome }))[0].title, "Fix the session reader.");
  const { messages } = await sessions.readSession({ app: "codex", sourcePath, home: tmpHome });
  assert.deepEqual(messages.filter(row => !row.injected).map(row => row.content), ["Fix the session reader.", "Also add keyboard navigation."]);
  assert.equal(messages.filter(row => row.injected).length, 2);
});

test("Codex shell results unpack explicit exit codes without guessing from error words", async () => {
  const dir = path.join(tmpHome, ".codex", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = path.join(dir, "shell.jsonl");
  const outputs = [
    JSON.stringify({ output: "1 failed", metadata: { exit_code: 1, duration_seconds: 0.25 } }),
    "Chunk ID: fixture\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nTests for error handling passed",
    "An error word without execution metadata",
  ];
  fs.writeFileSync(sourcePath, outputs.map((output, index) => JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: String(index), output } })).join("\n"));
  const { messages } = await sessions.readSession({ app: "codex", sourcePath, home: tmpHome });
  assert.deepEqual(messages[0].toolResults[0], { callId: "0", output: "1 failed", status: "failed", exitCode: 1, durationMs: 250 });
  assert.equal(messages[1].toolResults[0].output, "Tests for error handling passed");
  assert.equal(messages[1].toolResults[0].status, "success");
  assert.equal(messages[2].toolResults[0].status, undefined);
  assert.equal(messages[0].content, outputs[0], "raw envelope remains in the transcript");
});

test("Claude mixed user rows separate tool results from the actual question", async () => {
  const sourcePath = writeClaudeSession(tmpHome, "mixed", [JSON.stringify({
    type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "edit", content: "Permission denied", is_error: true },
      { type: "text", text: "Please continue." },
    ] },
  })]);
  const { messages } = await sessions.readSession({ app: "claude", sourcePath, home: tmpHome });
  assert.equal(messages[0].content, "Please continue.");
  assert.deepEqual(messages[0].toolResults, [{ toolUseId: "edit", content: "Permission denied", isError: true }]);
});

test("Gemini preserves tool ids, statuses, native diffs, outputs and model", async () => {
  const dir = path.join(tmpHome, ".gemini", "tmp", "project", "chats");
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = path.join(dir, "session-tools.json");
  fs.writeFileSync(sourcePath, JSON.stringify({ sessionId: "tools", messages: [{ id: "m1", type: "gemini", model: "gemini-2.5-pro", content: "", toolCalls: [
    { id: "edit", name: "replace", args: { file_path: "file.js" }, status: "success", resultDisplay: { filePath: "file.js", fileDiff: "--- file.js\n+++ file.js\n@@ -1 +1 @@\n-old\n+new" } },
    { id: "shell", name: "run_shell_command", args: { command: "npm test" }, status: "error", result: [{ functionResponse: { response: { error: "Tests failed" } } }] },
    { id: "wait", name: "read_file", status: "awaiting_approval" },
    { id: "stop", name: "read_file", status: "cancelled" },
  ] }] }));
  const { messages } = await sessions.readSession({ app: "gemini", sourcePath, home: tmpHome });
  assert.equal(messages[0].model, "gemini-2.5-pro");
  assert.equal(messages[0].toolCalls[0].id, "edit");
  assert.deepEqual(messages[0].toolResults.map(result => result.status), ["success", "failed", "pending", "interrupted"]);
  assert.equal(messages[0].toolResults[1].output, "Tests failed");
  assert.match(messages[0].toolResults[0].diff, /@@ -1 \+1 @@/);
});

test("session metadata refreshes on file changes and uses root-clamped Codex native titles", async () => {
  const dir = path.join(tmpHome, ".codex", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = path.join(dir, "metadata.jsonl");
  const write = (text) => fs.writeFileSync(sourcePath, [
    JSON.stringify({ type: "session_meta", payload: { id: "metadata", cwd: "/project" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: text } }),
  ].join("\n"));
  write("First title");
  const list = () => sessions.listSessions({ app: "codex", home: tmpHome });
  assert.equal((await list())[0].title, "First title");
  write("Changed title with a new length");
  assert.equal((await list())[0].title, "Changed title with a new length");
  const indexPath = path.join(tmpHome, ".codex", "session_index.jsonl");
  fs.writeFileSync(indexPath, JSON.stringify({ id: "metadata", thread_name: "Named by Codex" }));
  assert.equal((await list())[0].title, "Named by Codex");
  fs.writeFileSync(indexPath, JSON.stringify({ id: "metadata", thread_name: "Renamed in Codex" }));
  assert.equal((await list())[0].title, "Renamed in Codex");
  fs.unlinkSync(indexPath);
  const outside = path.join(tmpHome, "outside-title.jsonl");
  fs.writeFileSync(outside, JSON.stringify({ id: "metadata", thread_name: "Outside root" }));
  fs.symlinkSync(outside, indexPath);
  assert.equal((await list())[0].title, "Changed title with a new length");
});

test("head/tail metadata reads preserve long UTF-8 JSON lines and the final reply", async () => {
  const sourcePath = writeClaudeSession(tmpHome, "long-lines", [
    JSON.stringify({ sessionId: "long-lines", cwd: "/project" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "中文问题" } }),
    ...Array.from({ length: 100 }, (_, index) => JSON.stringify({ timestamp: "2026-10-01T10:00:00Z", message: { role: "assistant", content: `中${index}`.repeat(40000) } })),
    JSON.stringify({ timestamp: "2026-10-01T10:02:00Z", message: { role: "assistant", content: "最终答复" } }),
  ]);
  const [row] = await sessions.listSessions({ app: "claude", home: tmpHome });
  assert.equal(row.sourcePath, sourcePath);
  assert.equal(row.title, "中文问题");
  assert.equal(row.summary, "最终答复");
  assert.equal(row.lastActiveAt, Date.parse("2026-10-01T10:02:00Z"));
});

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

test("claude sessions group by the last /cd relocated cwd, not cwd drift (cc-switch ea8bc2c)", async () => {
  // The relocated record sits more than 30 lines before EOF (outside the
  // tail window used for titles) but inside the 64 KiB metadata zone Claude
  // Code itself uses. Ordinary records' drifting cwd must not move the
  // session; only the last relocated record does.
  const filler = [];
  for (let i = 0; i < 200; i += 1) {
    filler.push(JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: `step ${i}` },
      cwd: `/tmp/project-a/drifting-sub-${i}`,
      timestamp: "2026-10-01T10:30:00Z",
    }));
  }
  writeClaudeSession(tmpHome, "session-cd", [
    JSON.stringify({ sessionId: "session-cd", cwd: "/tmp/project-a", timestamp: "2026-10-01T10:00:00Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "start" }, timestamp: "2026-10-01T10:00:01Z" }),
    JSON.stringify({ type: "relocated", relocatedCwd: "/tmp/project-b", sessionId: "session-cd" }),
    ...filler,
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "after move" }, timestamp: "2026-10-01T11:00:00Z" }),
  ]);

  const list = await sessions.listSessions({ app: "claude", home: tmpHome });
  const meta = list.find((row) => row.sessionId === "session-cd");
  assert.ok(meta, "the /cd session is listed");
  assert.equal(meta.projectDir, "/tmp/project-b", "the last relocated cwd wins over the starting cwd");
  assert.equal(meta.title, "start");
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

test("claude tool results retain explicit error flags without inferring failures from output", async () => {
  const flags = [true, false, undefined, "true"];
  const sourcePath = writeClaudeSession(tmpHome, "tool-errors", flags.map((is_error, index) =>
    JSON.stringify({ message: { role: "user", content: [{
      type: "tool_result", tool_use_id: `tool-${index}`, is_error,
      content: index === 0 ? "" : "An error message quoted by a successful tool",
    }] } }),
  ));

  const { messages } = await sessions.readSession({ app: "claude", sourcePath, home: tmpHome });
  assert.equal(messages.length, flags.length, "empty failed results are retained");
  assert.deepEqual(messages.map((message) => message.role), flags.map(() => "tool"));
  assert.deepEqual(messages.map((message) => message.toolResults[0]), flags.map((flag, index) => ({
    toolUseId: `tool-${index}`,
    content: index === 0 ? "" : "An error message quoted by a successful tool",
    ...(typeof flag === "boolean" ? { isError: flag } : {}),
  })));
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

test("codex transcripts: custom tools preserve raw input, call ids and results", async () => {
  const root = path.join(tmpHome, ".codex", "sessions");
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, "rollout-custom-tools.jsonl");
  const input = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
  const output = "Success. Updated the following files:\nA hello.txt";
  fs.writeFileSync(filePath, [
    { type: "custom_tool_call", call_id: "patch-1", name: "apply_patch", input },
    { type: "custom_tool_call_output", call_id: "patch-1", output },
    { type: "function_call", call_id: "shell-1", name: "exec_command", arguments: '{"cmd":"cat hello.txt"}' },
    { type: "function_call_output", call_id: "shell-1", output: "hello" },
  ].map((payload) => JSON.stringify({ type: "response_item", timestamp: "2026-10-01T10:00:00Z", payload })).join("\n") + "\n");

  const { messages, usage } = await sessions.readSession({ app: "codex", sourcePath: filePath, home: tmpHome });
  assert.equal(usage, null);
  assert.deepEqual(messages.map((row) => [row.role, row.content]), [
    ["assistant", ""], ["tool", output], ["assistant", ""], ["tool", "hello"],
  ]);
  assert.deepEqual(messages[0].toolCalls, [{
    callId: "patch-1", name: "apply_patch", input,
    patch: {
      body: input, files: [{ kind: "add", path: "hello.txt" }],
      additions: 1, deletions: 0, status: "success", error: false,
    },
  }]);
  assert.equal(messages[0].ts, Date.parse("2026-10-01T10:00:00Z"));
  assert.deepEqual(messages[1].toolResults, [{ callId: "patch-1", output }]);
  assert.deepEqual(messages[2].toolCalls, [{ callId: "shell-1", name: "exec_command", arguments: '{"cmd":"cat hello.txt"}' }]);
  assert.deepEqual(messages[3].toolResults, [{ callId: "shell-1", output: "hello" }]);
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

  const apps = sessions.listSessionApps({ home: tmpHome }).filter(row => ["claude", "codex", "gemini"].includes(row.id));
  assert.deepEqual(apps, [
    { id: "claude", available: true },
    { id: "codex", available: false },
    { id: "gemini", available: false },
  ]);
  assert.deepEqual(sessions.listSessionApps({ home: null, env: {} }).filter(row => ["claude", "codex", "gemini"].includes(row.id)), [
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
    () => sessions.readSession({ app: "unsupported", sourcePath: "/tmp/x.jsonl", home: tmpHome }),
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

for (const [app, rootParts, extension] of [
  ["claude", [".claude", "projects"], ".jsonl"],
  ["codex", [".codex", "sessions"], ".jsonl"],
  ["codex", [".codex", "archived_sessions"], ".jsonl"],
  ["gemini", [".gemini", "tmp"], ".json"],
]) {
  test(`readSession rejects file and directory symlinks escaping ${rootParts.join("/")}`, async () => {
    const root = path.join(tmpHome, ...rootParts);
    fs.mkdirSync(root, { recursive: true });
    const outsideDir = `${root}-outside`;
    fs.mkdirSync(outsideDir);
    const outside = path.join(outsideDir, `session${extension}`);
    fs.writeFileSync(outside, "{}");
    const fileLink = path.join(root, `linked${extension}`);
    const dirLink = path.join(root, "linked-dir");
    fs.symlinkSync(outside, fileLink, "file");
    fs.symlinkSync(outsideDir, dirLink, "junction");
    for (const sourcePath of [fileLink, path.join(dirLink, `session${extension}`)]) {
      await assert.rejects(() => sessions.readSession({ app, sourcePath, home: tmpHome }), /outside this app's session roots/);
    }
  });
}

test("readSession accepts symlinks inside the root and a relocated session root", async () => {
  const source = writeClaudeSession(tmpHome, "original", [
    JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
  ]);
  const link = path.join(path.dirname(source), "alias.jsonl");
  fs.symlinkSync(source, link, "file");
  assert.equal((await sessions.readSession({ app: "claude", sourcePath: link, home: tmpHome })).messages[0].content, "hello");

  const root = path.join(tmpHome, ".claude", "projects");
  const moved = path.join(tmpHome, "relocated-projects");
  fs.renameSync(root, moved);
  fs.symlinkSync(moved, root, "junction");
  assert.equal((await sessions.readSession({ app: "claude", sourcePath: source, home: tmpHome })).messages[0].content, "hello");
});

test("Gemini listing ignores a chats directory linked outside its session root", async () => {
  const project = path.join(tmpHome, ".gemini", "tmp", "project");
  fs.mkdirSync(project, { recursive: true });
  const outside = path.join(tmpHome, "external-chats");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "session.json"), JSON.stringify({ sessionId: "external", messages: [{ type: "user", content: "outside" }] }));
  fs.symlinkSync(outside, path.join(project, "chats"), "junction");
  assert.deepEqual(await sessions.listSessions({ app: "gemini", home: tmpHome }), []);
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
  // Rows are pre-folded to the queue contract: fresh input = raw 300 − 140
  // cached reads (inputInclusive false — the writes, when a rollout reports
  // any, ride in cacheCreationTokens outside input).
  assert.deepEqual(
    { inputTokens: codex.usage.inputTokens, cacheReadTokens: codex.usage.cacheReadTokens, outputTokens: codex.usage.outputTokens, reasoningTokens: codex.usage.reasoningTokens, totalTokens: codex.usage.totalTokens, model: codex.usage.model, inputInclusive: codex.usage.inputInclusive, durationMs: codex.usage.durationMs },
    { inputTokens: 160, cacheReadTokens: 140, outputTokens: 90, reasoningTokens: 40, totalTokens: 390, model: "gpt-5.2", inputInclusive: false, durationMs: 20000 },
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

test("codex attributes cumulative deltas to each model without billing duplicate snapshots", async () => {
  const root = path.join(tmpHome, ".codex", "sessions");
  fs.mkdirSync(root, { recursive: true });
  const sourcePath = path.join(root, "mixed.jsonl");
  const first = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 150 };
  const second = { input_tokens: 300, cached_input_tokens: 140, output_tokens: 90, reasoning_output_tokens: 40, total_tokens: 390 };
  const count = (total) => ({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total } } });
  fs.writeFileSync(sourcePath, [
    { type: "turn_context", payload: { model: "gpt-a" } }, count(first),
    { type: "turn_context", payload: { model: "gpt-b" } }, count(first), count(second),
    { type: "turn_context", payload: { model: "gpt-a" } }, count(second),
  ].map(JSON.stringify).join("\n") + "\n");
  const { usage } = await sessions.readSession({ app: "codex", sourcePath, home: tmpHome });
  assert.equal(usage.totalTokens, 390);
  assert.deepEqual(usage.perModel, [
    { model: "gpt-b", inputTokens: 100, cacheReadTokens: 100, outputTokens: 40, reasoningTokens: 20, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
    { model: "gpt-a", inputTokens: 60, cacheReadTokens: 40, outputTokens: 50, reasoningTokens: 20, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
  ]);
  const { estimateCostUsd } = require("../src/lib/proxy/pricing");
  const prices = { "gpt-a": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, "gpt-b": { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 0 } };
  const cost = usage.perModel.reduce((sum, entry) => sum + estimateCostUsd(prices, entry.model, entry, { inputInclusive: usage.inputInclusive }), 0);
  assert.ok(Math.abs(cost - (60 + 50 * 2 + 40 * 0.1 + 100 * 3 + 40 * 6 + 100 * 0.3) / 1e6) < 1e-12);
});

test("codex resets and cache-read aliases keep session totals aligned with the model breakdown", async () => {
  const root = path.join(tmpHome, ".codex", "sessions");
  fs.mkdirSync(root, { recursive: true });
  const sourcePath = path.join(root, "reset.jsonl");
  const first = { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 50 };
  const reset = { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 10 };
  fs.writeFileSync(sourcePath, [
    { type: "turn_context", payload: { model: "gpt-a" } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: first, last_token_usage: first } } },
    { type: "turn_context", payload: { model: "gpt-b" } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: reset, last_token_usage: reset } } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: reset, last_token_usage: reset } } },
  ].map(JSON.stringify).join("\n") + "\n");
  const { usage } = await sessions.readSession({ app: "codex", sourcePath, home: tmpHome });
  assert.equal(usage.totalTokens, 180);
  assert.equal(usage.cacheReadTokens, 45);
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens"]) {
    assert.equal(usage[field], usage.perModel.reduce((sum, entry) => sum + entry[field], 0));
  }
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
    { model: "claude-opus-4-6", inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
    { model: "claude-haiku-4-5", inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
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
  assert.deepEqual(tool.toolResults, [{ toolUseId: "tu_1", content: "file.txt", durationMs: 2000 }]);
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

test("codex patch outcomes unwrap native JSON results without replacing the transcript output", async () => {
  const dir = path.join(tmpHome, ".codex", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = path.join(dir, "wrapped-patches.jsonl");
  const input = "*** Begin Patch\n*** Add File: fixture.txt\n+hello\n*** End Patch";
  const cases = [
    { id: "applied", output: "Success. Updated the following files:\nA fixture.txt", exitCode: 0, expected: "success" },
    { id: "exit-only", output: "", exitCode: 0, expected: "success" },
    { id: "failed-exit", output: "Invalid patch", exitCode: 1, expected: "failed" },
    { id: "conflicting-success", output: "Success.", exitCode: 1, expected: "failed" },
    { id: "failed-text", output: "apply_patch verification failed", exitCode: 0, expected: "failed" },
    { id: "text-only", output: "Success.", expected: "success" },
    { id: "unknown", output: "No result available", expected: "pending" },
    { id: "null-exit", output: "", exitCode: null, expected: "pending" },
    { id: "invalid-exit", output: "", exitCode: false, expected: "pending" },
  ];
  const results = cases.map(({ output, exitCode }) => JSON.stringify({ output, metadata: { exit_code: exitCode, duration_seconds: 0.1 } }));
  const rows = cases.flatMap(({ id }, index) => [
    { type: "custom_tool_call", name: "apply_patch", call_id: id, input },
    { type: "custom_tool_call_output", call_id: id, output: results[index] },
  ]);
  fs.writeFileSync(sourcePath, rows.map((payload) => JSON.stringify({ type: "response_item", payload })).join("\n"));

  const { messages } = await sessions.readSession({ app: "codex", sourcePath, home: tmpHome });
  cases.forEach(({ id, expected }, index) => {
    const patch = messages[index * 2].toolCalls[0].patch;
    assert.equal(patch.status, expected, id);
    assert.equal(patch.error, expected === "failed", id);
    assert.equal(messages[index * 2 + 1].content, results[index]);
    const result = messages[index * 2 + 1].toolResults[0];
    assert.equal(result.callId, id);
    assert.equal(result.output, cases[index].output);
    assert.equal(result.durationMs, 100);
  });
});

test("codex associates delayed patch results by call id across ordinary tool history", async () => {
  const dir = path.join(tmpHome, ".codex", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = path.join(dir, "interleaved-patches.jsonl");
  const input = "*** Begin Patch\n*** Add File: fixture.txt\n+hello\n*** End Patch";
  const rows = ["first", "second", "pending", null].map((call_id) => ({
    type: "custom_tool_call", name: "apply_patch", call_id, input,
  }));
  for (let i = 0; i < 1000; i += 1) {
    rows.push(
      { type: "function_call", name: "exec_command", call_id: `shell-${i}`, arguments: '{"cmd":"pwd"}' },
      { type: "function_call_output", call_id: `shell-${i}`, output: "Success." },
    );
  }
  rows.push(
    { type: "custom_tool_call_output", call_id: "unknown", output: "Success." },
    { type: "custom_tool_call_output", call_id: null, output: "Success." },
    { type: "custom_tool_call_output", call_id: "second", output: "patch rejected by user" },
    { type: "custom_tool_call_output", call_id: "first", output: "Success." },
  );
  fs.writeFileSync(sourcePath, rows.map((payload) => JSON.stringify({ type: "response_item", payload })).join("\n"));

  const { messages } = await sessions.readSession({ app: "codex", sourcePath, home: tmpHome });
  assert.equal(messages.length, rows.length);
  assert.deepEqual(messages.slice(0, 4).map((row) => row.toolCalls[0].patch.status), ["success", "failed", "pending", "pending"]);
  assert.equal(messages.filter((row) => row.toolCalls?.[0].patch).length, 4);
});

test("Claude 1h cache-write split flows into per-model usage for pricing", async () => {
  const filePath = writeClaudeSession(tmpHome, "session-1h-cache", [
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-10-03T10:00:00Z" }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1", role: "assistant", model: "claude-sonnet-5",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 100, output_tokens: 50,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
        },
      },
      timestamp: "2026-10-03T10:00:05Z",
    }),
  ]);

  const { usage } = await sessions.readSession({ app: "claude", sourcePath: filePath, home: tmpHome });
  assert.equal(usage.cacheCreationTokens, 1000);
  assert.equal(usage.cacheCreation1hTokens, 600);
  assert.equal(usage.perModel[0].cacheCreation1hTokens, 600);
  // The 1h share must not inflate the total: it is a subset of cache writes.
  assert.equal(usage.totalTokens, 100 + 50 + 900 + 1000);
});

test("Codex session usage imports cache writes and falls through stub-zero cache reads", async () => {
  // token_count info carries cumulative totals; newer Codex versions report
  // cache writes as cache_write_input_tokens (cc-switch 4bbdbcd) and some
  // relays stub cache fields to 0 with the real count elsewhere
  // (cc-switch 5667b28).
  const codexRoot = path.join(tmpHome, ".codex", "sessions", "2026", "10", "02");
  fs.mkdirSync(codexRoot, { recursive: true });
  const codexPath = path.join(codexRoot, "rollout-cache-write.jsonl");
  fs.writeFileSync(codexPath, [
    JSON.stringify({ timestamp: "2026-10-02T11:00:00Z", type: "session_meta", payload: { id: "codex-cw", cwd: "/tmp/c" } }),
    JSON.stringify({ timestamp: "2026-10-02T11:00:01Z", type: "turn_context", payload: { model: "gpt-5.6" } }),
    JSON.stringify({
      timestamp: "2026-10-02T11:00:02Z", type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: {
        input_tokens: 1000, cached_input_tokens: 0, cache_read_input_tokens: 400,
        cache_write_input_tokens: 300, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1350,
      } } },
    }),
  ].join("\n") + "\n");

  const { usage } = await sessions.readSession({ app: "codex", sourcePath: codexPath, home: tmpHome });
  // Rows are pre-folded to the queue contract: fresh input = raw 1000 − 400
  // reads; the writes ride in cacheCreationTokens, outside input.
  assert.deepEqual(
    { inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens, outputTokens: usage.outputTokens, cacheCreationTokens: usage.cacheCreationTokens, model: usage.model, inputInclusive: usage.inputInclusive },
    { inputTokens: 600, cacheReadTokens: 400, outputTokens: 50, cacheCreationTokens: 300, model: "gpt-5.6", inputInclusive: false },
  );
  assert.equal(usage.perModel[0].cacheCreationTokens, 300);
  // The reader-header cost must bill the full fresh input at the input rate
  // and the writes at the write rate — the inclusive branch (mirror of the
  // Go core's subset accounting) would zero those 300 fresh-input tokens.
  const pricing = require("../src/lib/proxy/pricing");
  const cost = pricing.estimateCostUsd(
    { "gpt-5.6": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } },
    "gpt-5.6",
    usage.perModel[0],
    { inputInclusive: usage.inputInclusive },
  );
  assert.equal(cost, (600 * 1 + 50 * 2 + 400 * 0.1 + 300 * 1.25) / 1e6);
});

test("claude sessions: a /cd record landing exactly on the 64 KiB window boundary still counts", async () => {
  // The tail window must only drop its first line when the seek landed
  // mid-line. With the seek aligned on a newline, the window's first record
  // is complete — and it may be the last relocated record.
  const header = JSON.stringify({ sessionId: "session-cd-edge", cwd: "/tmp/project-a", timestamp: "2026-10-01T10:00:00Z" }) + "\n";
  const relocated = JSON.stringify({ type: "relocated", relocatedCwd: "/tmp/project-b", sessionId: "session-cd-edge" }) + "\n";
  const padBase = JSON.stringify({ type: "user", message: { role: "user", content: "" }, timestamp: "2026-10-01T10:00:05Z" }) + "\n";
  const padNeeded = 64 * 1024 - relocated.length - padBase.length;
  assert.ok(padNeeded >= 0, "padding fits");
  const padLine = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(padNeeded) }, timestamp: "2026-10-01T10:00:05Z" }) + "\n";
  const content = header + relocated + padLine;
  assert.equal(content.length - header.length, 64 * 1024, "the relocated record starts exactly at the window boundary");
  const projectDir = path.join(tmpHome, ".claude", "projects", "-tmp-project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "session-cd-edge.jsonl"), content);

  const list = await sessions.listSessions({ app: "claude", home: tmpHome });
  const meta = list.find((row) => row.sessionId === "session-cd-edge");
  assert.ok(meta, "the boundary session is listed");
  assert.equal(meta.projectDir, "/tmp/project-b", "the boundary-aligned relocated record is not dropped as a partial line");
});
