import { describe, expect, it } from "vitest";
import { exportSessionMarkdown, toolCallPayloadText } from "./session-export.js";

// The three readers in src/lib/sessions.js each name the tool payload after
// their own log format. Regression: the export used to resolve only
// `input`/`args`, so every codex call (which carries a JSON *string* under
// `arguments`) exported as an empty code fence.
describe("toolCallPayloadText", () => {
  it("reads claude's `input` object", () => {
    expect(toolCallPayloadText({ name: "Read", input: { file_path: "/a.js" } }))
      .toBe('{\n  "file_path": "/a.js"\n}');
  });

  it("reads gemini's `args` object", () => {
    expect(toolCallPayloadText({ name: "read_file", args: { path: "/a.js" } }))
      .toBe('{\n  "path": "/a.js"\n}');
  });

  it("parses codex's `arguments` JSON string", () => {
    expect(toolCallPayloadText({ name: "shell", arguments: '{"command":"ls -la"}' }))
      .toBe('{\n  "command": "ls -la"\n}');
  });

  it("falls back to the raw string when codex's arguments is not valid JSON", () => {
    expect(toolCallPayloadText({ name: "shell", arguments: "not json" })).toBe("not json");
  });

  it("is empty for a call with no payload", () => {
    expect(toolCallPayloadText({ name: "shell", arguments: null })).toBe("");
    expect(toolCallPayloadText({ name: "shell" })).toBe("");
    expect(toolCallPayloadText(null)).toBe("");
  });

  it("prefers `input` when a shape somehow carries both", () => {
    expect(toolCallPayloadText({ name: "x", input: { a: 1 }, args: { b: 2 } })).toBe('{\n  "a": 1\n}');
  });
});

describe("exportSessionMarkdown", () => {
  const identity = (value) => value;

  it("renders a codex tool call's arguments instead of an empty fence", () => {
    const markdown = exportSessionMarkdown(
      { title: "T" },
      [{ role: "assistant", content: "", ts: 0, toolCalls: [{ callId: "c1", name: "shell", arguments: '{"command":"ls"}' }] }],
      () => "ts",
      identity,
    );
    expect(markdown).toContain("**Tool: shell**");
    expect(markdown).toContain('"command": "ls"');
  });

  it("keeps thinking, content and tool calls in one section", () => {
    const markdown = exportSessionMarkdown(
      { title: "T" },
      [{
        role: "assistant",
        content: "hello",
        thinking: "pondering",
        ts: 1,
        toolCalls: [{ name: "Read", input: { file_path: "/a.js" } }],
      }],
      () => "ts",
      identity,
    );
    expect(markdown).toContain("## Assistant");
    expect(markdown).toContain("pondering");
    expect(markdown).toContain("hello");
    expect(markdown).toContain("/a.js");
  });

  it("exports Codex custom tool input and its result without losing patch text", () => {
    const input = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
    const output = "Success. Updated the following files:\nA hello.txt";
    const markdown = exportSessionMarkdown({ title: "T" }, [
      { role: "assistant", content: "", toolCalls: [{ callId: "p1", name: "apply_patch", input }] },
      { role: "tool", content: output, toolResults: [{ callId: "p1", output }] },
    ], () => "ts", identity);
    expect(markdown).toContain("**Tool: apply_patch**");
    expect(markdown).toContain(input);
    expect(markdown).toContain(output);
  });
});
