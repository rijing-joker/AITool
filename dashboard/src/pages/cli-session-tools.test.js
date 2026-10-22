import { expect, it } from "vitest";
import {
  diffRows,
  toolDiff,
  toolStatus,
  toolTarget,
  mcpTool,
  toolCategory,
  toolFacts,
  mergeProcessSteps,
  shortPath,
} from "./cli-session-tools";

it("summarizes native Claude, Codex and Gemini tool arguments", () => {
  expect(
    toolTarget({
      name: "Read",
      input: {
        file_path: "dashboard/src/pages/file.jsx",
        offset: 300,
        limit: 90,
      },
    }),
  ).toBe("…/src/pages/file.jsx:300–389");
  expect(
    toolTarget({ name: "exec_command", arguments: '{"cmd":"npm test"}' }),
  ).toBe("npm test");
  expect(
    toolTarget({ name: "run_shell_command", args: { command: "git diff" } }),
  ).toBe("git diff");
});

it("summarizes MCP, web and agent calls and makes paths relative only at directory boundaries", () => {
  expect(mcpTool({ name: "mcp__docs-server__search" })).toEqual({ server: "docs-server", name: "search" });
  expect(toolCategory({ name: "mcp__docs__read_file" })).toBe("mcp");
  expect(toolCategory({ name: "WebSearch" })).toBe("web");
  expect(toolTarget({ name: "web.run", input: { search_query: [{ q: "reader patterns" }] } })).toBe("reader patterns");
  expect(toolTarget({ name: "spawn_agent", input: { message: "Review\n layout", model: "model-a" } })).toBe("Review layout");
  expect(toolFacts({ name: "Task", input: { subagent_type: "Explore", model: "model-a", prompt: "work" } })).toEqual([
    { key: "subagent_type", value: "Explore" }, { key: "model", value: "model-a" },
  ]);
  expect(shortPath("file:///home/me/project/src/file.js", "/home/me/project")).toBe("src/file.js");
  expect(shortPath("/home/me/project-old/file.js", "/home/me/project")).toBe("~/project-old/file.js");
});

it("merges consecutive successes without consuming or mutating raw steps", () => {
  const step = (key, name, status = "success") => ({ key, kind: "tool", status, call: { name } });
  const steps = [step("a", "Read"), step("b", "Grep"), step("c", "Read", "failed"),
    step("d", "Read"), step("e", "Grep", "pending"), step("f", "Read", "interrupted"),
    step("g", "mcp__docs__search"), step("h", "mcp__docs__fetch"), step("i", "mcp__other__fetch")];
  const before = JSON.stringify(steps);
  const rows = mergeProcessSteps(steps);
  expect(rows.map(row => row.key)).toEqual(["a-group", "c", "d", "e", "f", "g-group", "i"]);
  expect(rows[0].children).toEqual(steps.slice(0, 2));
  expect(rows[5]).toMatchObject({ category: "mcp", server: "docs" });
  expect(JSON.stringify(steps)).toBe(before);
  expect(mergeProcessSteps([step("x", "Read"), { key: "msg", kind: "message" }, step("y", "Read")])).toHaveLength(3);
});

it("builds proposed replacement diffs with context and no invented file offsets", () => {
  const step = {
    call: {
      name: "Edit",
      input: {
        file_path: "file.js",
        old_string: "first\nold\nlast",
        new_string: "first\nnew\nlast",
      },
    },
  };
  const diff = toolDiff(step);
  expect(diff.estimated).toBe(true);
  expect(diff.rows.map((row) => row.kind)).toEqual([
    "header",
    "header",
    "hunk",
    "context",
    "remove",
    "add",
    "context",
  ]);
  expect(diff.rows.every((row) => row.old == null && row.new == null)).toBe(
    true,
  );
  expect(toolStatus(step)).toBe("pending");
});

it("prefers actual result diffs and assigns unified hunk line numbers", () => {
  const step = {
    call: {
      name: "Edit",
      input: {
        file_path: "file.js",
        old_string: "bad",
        new_string: "proposed",
      },
    },
    status: "success",
    result: {
      diff: "--- file.js\n+++ file.js\n@@ -12,2 +12,2 @@\n context\n-old\n+actual",
    },
  };
  const diff = toolDiff(step);
  expect(diff.estimated).toBe(false);
  expect(diff.body).toContain("+actual");
  expect(diff.rows.slice(3).map(({ old, new: next }) => [old, next])).toEqual([
    [12, 12],
    [13, null],
    [null, 13],
  ]);
});

it("retains apply_patch literal signs and stops at End Patch", () => {
  const rows = diffRows(
    "*** Begin Patch\n*** Add File: x\n+-literal minus\n*** End Patch\n+ignored",
  );
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({
    kind: "add",
    new: 1,
    text: "+-literal minus",
  });
  expect(diffRows("*** Begin Patch\n*** Update File: x\n+++ literal\n--- literal\n*** End Patch").slice(1).map(row => row.kind)).toEqual(["add", "remove"]);
  expect(diffRows("--- a\n+++ b").map((row) => row.kind)).toEqual([
    "header",
    "header",
  ]);
});

it("keeps literal header prefixes inside hunks and recognizes the next file header", () => {
  const rows = diffRows([
    "--- a/first.md", "+++ b/first.md", "@@ -12,2 +15,2 @@",
    "--- removed separator", "+++ added separator", " context",
    "--- a/second.md", "+++ b/second.md", "@@ -0,0 +1 @@", "+new",
    "\\ No newline at end of file",
  ].join("\n"));
  expect(rows.slice(3, 6)).toEqual([
    { text: "--- removed separator", kind: "remove", old: 12, new: null },
    { text: "+++ added separator", kind: "add", old: null, new: 15 },
    { text: " context", kind: "context", old: 13, new: 16 },
  ]);
  expect(rows.slice(6, 8).map(row => row.kind)).toEqual(["header", "header"]);
  expect(rows[9]).toMatchObject({ kind: "add", old: null, new: 1 });
  expect(rows.filter(row => row.kind === "add")).toHaveLength(2);
  expect(rows.filter(row => row.kind === "remove")).toHaveLength(1);
  const proposed = toolDiff({ call: { name: "Edit", input: {
    old_string: "-- removed separator", new_string: "++ added separator",
  } } });
  expect(proposed.rows.slice(3).map(row => row.kind)).toEqual(["remove", "add"]);
});
