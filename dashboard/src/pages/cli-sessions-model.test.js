import { expect, it } from "vitest";
import {
  buildSessionTurns,
  filterSessions,
  groupSessions,
  turnText,
} from "./cli-sessions-model";

it("groups Windows drive and UNC variants while preserving POSIX case", () => {
  const sessions = ["D:\\Project", "d:/project/", "\\\\Server\\Share\\Repo", "//server/share/repo/", "/Project", "/project"]
    .map(projectDir => ({ projectDir }));
  expect(groupSessions(sessions, "project").map(group => group.sessions.length)).toEqual([2, 2, 1, 1]);
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
