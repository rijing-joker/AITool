import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { exportSessionMarkdown } from "../lib/session-export";
import { mergeProcessSteps, toolStatus } from "./cli-session-tools";
import {
  buildSessionTurns,
  filterSessions,
  groupSessions,
  turnText,
} from "./cli-sessions-model";

const { fold } = createRequire(import.meta.url)("../../../src/lib/session-sources.js");

it("keeps Antigravity execution events visible in turns, search text and Markdown", () => {
  const { messages } = fold("agy", [
    { type: "USER_INPUT", content: "Read file" },
    { type: "TOOL_RESPONSE", content: "Read failed: permission denied" },
    { type: "UNKNOWN_STEP", details: { error: "unfamiliar failure" } },
    { type: "PLANNER_RESPONSE", status: "DONE", content: "Could not read file" },
  ]);
  const turns = buildSessionTurns(messages);
  expect(turns).toHaveLength(1);
  expect(turns[0].steps.map(step => step.message.content)).toEqual([
    "Read failed: permission denied",
    messages[2].content,
  ]);
  expect(turnText(turns[0])).toContain("permission denied");
  expect(turnText(turns[0])).toContain("unfamiliar failure");
  const markdown = exportSessionMarkdown({ title: "Antigravity" }, messages, String, String);
  expect(markdown).toContain("permission denied");
  expect(markdown).toContain("UNKNOWN_STEP");
});

it("keeps uncertain Hermes tool results separate from successful execution groups", () => {
  const { messages } = fold("hermes", [
    { role: "user", content: "Read files" },
    { role: "assistant", tool_calls: [
      { id: "a", function: { name: "read", arguments: "{}" } },
      { id: "b", function: { name: "read", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "a", content: "source", status: "completed" },
    { role: "tool", tool_call_id: "b", content: "Permission denied" },
  ]);
  const [turn] = buildSessionTurns(messages);
  expect(toolStatus(turn.steps[0])).toBe("success");
  expect(toolStatus(turn.steps[1])).not.toBe("success");
  expect(mergeProcessSteps(turn.steps)).toHaveLength(2);
  expect(turnText(turn)).toContain("Permission denied");
});

it("groups Windows drive and UNC variants while preserving POSIX case", () => {
  const sessions = [
    "D:\\Project",
    "d:/project/",
    "\\\\Server\\Share\\Repo",
    "//server/share/repo/",
    "/Project",
    "/project",
  ].map((projectDir) => ({ projectDir }));
  expect(
    groupSessions(sessions, "project").map((group) => group.sessions.length),
  ).toEqual([2, 2, 1, 1]);
  expect(sessions[0].projectDir).toBe("D:\\Project");
});

it("pairs delayed tool results across questions without losing orphan output or mutating messages", () => {
  const messages = [
    { role: "user", content: "First question" },
    {
      role: "assistant",
      content: "[Tool: Read]\nChecking the source.",
      toolCalls: [{ id: "read-1", name: "Read", input: { path: "file.js" } }],
    },
    { role: "user", content: "Also fix the tests" },
    {
      role: "tool",
      content: "source",
      toolResults: [{ toolUseId: "read-1", content: "source", isError: true }],
    },
    {
      role: "tool",
      content: "orphan",
      toolResults: [{ callId: "missing", output: "orphan" }],
    },
    { role: "assistant", content: "Done." },
  ];
  const before = structuredClone(messages);
  const turns = buildSessionTurns(messages);
  expect(turns).toHaveLength(2);
  expect(turns[0].steps.find((step) => step.call)).toMatchObject({
    output: "source",
    failed: true,
  });
  expect(turns[0].steps[0].message.content).toBe("Checking the source.");
  expect(turns[1].steps[0]).toMatchObject({ kind: "result", output: "orphan" });
  expect(turns[1].final.content).toBe("Done.");
  expect(messages).toEqual(before);
});

it("retains image-only questions, standalone thinking, and unstructured tool markers", () => {
  const turns = buildSessionTurns([
    { role: "assistant", thinking: "Inspect first", content: "" },
    {
      role: "user",
      content: "",
      images: [{ dataUrl: "data:image/png;base64,YQ==" }],
    },
    { role: "assistant", content: "[Tool: literal text]" },
  ]);
  expect(turns[0].steps[0].kind).toBe("thinking");
  expect(turns[1].question.images).toHaveLength(1);
  expect(turns[1].final.content).toBe("[Tool: literal text]");
  expect(turnText(turns[0])).toContain("Inspect first");
});

it("hides injected context and pairs mixed Claude and embedded Gemini results", () => {
  const messages = [
    { role: "user", content: "# AGENTS.md instructions", injected: true },
    { role: "user", content: "Fix it" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "edit", name: "Edit" }],
    },
    {
      role: "user",
      content: "Continue",
      toolResults: [{ toolUseId: "edit", content: "denied", isError: true }],
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "shell", name: "run_shell_command" }],
      toolResults: [
        { callId: "shell", output: "done", status: "success", exitCode: 0 },
      ],
    },
  ];
  const before = structuredClone(messages);
  const turns = buildSessionTurns(messages);
  expect(turns).toHaveLength(2);
  expect(turns[0].steps[0]).toMatchObject({
    output: "denied",
    status: "failed",
    failed: true,
  });
  expect(turns[1].steps[0]).toMatchObject({
    output: "done",
    status: "success",
    exitCode: 0,
  });
  expect(messages).toEqual(before);
});

it("sorts and searches session metadata before grouping by full project path or local calendar day", () => {
  const now = new Date(2026, 9, 9, 10);
  const entries = [
    {
      appId: "codex",
      sessionId: "id-old",
      sourcePath: "a",
      title: "Older",
      projectDir: "/one/app",
      lastActiveAt: new Date(2026, 9, 7, 12).getTime(),
    },
    {
      appId: "claude",
      sessionId: "id-new",
      sourcePath: "b",
      title: "Newest",
      projectDir: "/two/app",
      lastActiveAt: now.getTime(),
    },
    {
      appId: "gemini",
      sessionId: "id-mid",
      sourcePath: "c",
      title: "Yesterday",
      projectDir: "/one/app",
      lastActiveAt: new Date(2026, 9, 8, 12).getTime(),
    },
  ];
  const sorted = filterSessions(entries, "");
  expect(groupSessions(sorted, "project").map((group) => group.key)).toEqual([
    "/two/app",
    "/one/app",
  ]);
  expect(groupSessions(sorted, "time", now).map((group) => group.key)).toEqual([
    "today",
    "yesterday",
    "week",
  ]);
  expect(filterSessions(entries, "ID-MID")).toEqual([entries[2]]);
  expect(entries[0].title).toBe("Older");
});
