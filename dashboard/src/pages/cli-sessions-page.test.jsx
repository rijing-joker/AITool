import React from "react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { CliSessionsPage } from "./CliSessionsPage";

function render(ui, initialEntries = ["/cli-sessions"]) {
  const router = createMemoryRouter([{ path: "*", element: ui }], {
    initialEntries,
  });
  return { ...rtlRender(<RouterProvider router={router} />), router };
}

const { readSession } = createRequire(import.meta.url)(
  "../../../src/lib/sessions.js",
);
const { previewTranscript, contentPage } = createRequire(import.meta.url)(
  "../../../src/lib/session-transcript-cache.js",
);

vi.mock("../lib/copy", () => ({
  copy: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
}));
vi.mock("../lib/host-mode", () => ({ isLocalDashboardHost: () => true }));
vi.mock("../lib/mock-data", () => ({ isMockEnabled: () => false }));

const session = {
  appId: "claude",
  sessionId: "s-1",
  title: "Fix the login bug",
  summary: "Done",
  projectDir: "/tmp/project",
  createdAt: 1_700_000_000_000,
  lastActiveAt: Date.now() - 60_000,
  sourcePath: "/home/u/.claude/projects/p/s-1.jsonl",
  resumeCommand: "claude --resume s-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openTranscript(messages, read = null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path === "/api/cli-sessions")
        return {
          json: async () => ({
            ok: true,
            apps: [{ id: "claude", available: true }],
          }),
        };
      if (path.startsWith("/api/cli-sessions/list"))
        return { json: async () => ({ ok: true, sessions: [session] }) };
      if (path.startsWith("/api/cli-sessions/read"))
        return { json: async () => read ? read(new URL(path, "http://localhost")) : ({ ok: true, messages }) };
      if (path.startsWith("/api/cli-sessions/content") && read)
        return { json: async () => read(new URL(path, "http://localhost")) };
      throw new Error(`unexpected fetch: ${path}`);
    }),
  );
  render(<CliSessionsPage />);
  fireEvent.click(await screen.findByText(session.title));
  await waitFor(() =>
    expect(screen.getByLabelText("clisessions.export")).not.toBeDisabled(),
  );
}

function expandStep(label) {
  const details = screen.getByText(label).closest("details");
  details.open = true;
  fireEvent(details, new Event("toggle"));
  return details;
}
it("loads full lazy tool arguments and patch objects only after disclosure", async () => {
  const body = "*** Begin Patch\n*** Add File: test.txt\n" + "+line\n".repeat(2000) + "+LAZYPATCHTAIL\n*** End Patch";
  const full = { revision: "v1", messages: [{ role: "user", content: "Make a file" }, { role: "assistant", content: "", toolCalls: [{ name: "apply_patch", input: body, patch: { body, files: [{ kind: "add", path: "test.txt" }], additions: 2001, deletions: 0, status: "success" } }] }] };
  const refs = [];
  await openTranscript(full.messages, url => {
    if (url.pathname.endsWith("/content")) {
      const options = Object.fromEntries(url.searchParams); refs.push(options.ref);
      return { ok: true, ...contentPage(full, options) };
    }
    return { ok: true, ...previewTranscript(full) };
  });
  expect(refs).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "clisessions.expand_processes" }));
  expandStep("apply_patch");
  await waitFor(() => expect(refs.sort()).toEqual(["1:call:0:input", "1:call:0:patch"]));
  expect((await screen.findAllByText("test.txt")).length).toBeGreaterThan(0);
  await waitFor(() => expect(screen.getByText("apply_patch").closest("summary")).toHaveTextContent("+2001"));
});

it("counts rejected lazy Codex patches before loading their bodies", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-patch-failure-"));
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  try {
    const sourcePath = path.join(home, ".codex/sessions/rejected.jsonl");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    const body = "*** Begin Patch\n*** Update File: app.js\n@@\n" + "-old\n+new\n".repeat(600) + "*** End Patch";
    const rows = [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Update the file" }] } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: body } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "patch", output: "apply_patch verification failed: Expected lines were not found" } },
    ];
    fs.writeFileSync(sourcePath, rows.map(row => JSON.stringify(row)).join("\n"));
    const full = await readSession({ app: "codex", home, sourcePath });
    const refs = [];
    await openTranscript(full.messages, async url => {
      if (url.pathname.endsWith("/content")) {
        const options = Object.fromEntries(url.searchParams); refs.push(options.ref);
        await ready;
        return { ok: true, ...contentPage(full, options) };
      }
      return { ok: true, ...previewTranscript(full) };
    });
    expect(screen.getByText('clisessions.process_failed:{"count":1}')).toBeInTheDocument();
    const details = screen.getByText("apply_patch").closest("details");
    expect(details).toHaveAttribute("open");
    expect(details).toHaveClass("bg-red-50/60");
    expect(details.querySelector("summary")).toHaveTextContent("app.js");
    expect(details.querySelector("summary")).toHaveTextContent("clisessions.status.failed");
    await waitFor(() => expect(refs.sort()).toEqual(["1:call:0:input", "1:call:0:patch"]));
    await act(async () => { release(); await ready; });
    await waitFor(() => expect(details.querySelector("summary")).toHaveTextContent("+600 −600clisessions.patch.failed"));
    expect(screen.getByText('clisessions.process_failed:{"count":1}')).toBeInTheDocument();
  } finally {
    release();
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("keeps successful groups collapsed and opens matching children without merging failures", async () => {
  await openTranscript([
    { role: "user", content: "Inspect files" },
    { role: "assistant", content: "", toolCalls: [
      { id: "a", name: "Read", input: { path: "a.js" } },
      { id: "b", name: "Grep", input: { pattern: "target" } },
      { id: "c", name: "Read", input: { path: "broken.js" } },
    ] },
    { role: "tool", content: "", toolResults: [
      { toolUseId: "a", content: "source" }, { toolUseId: "b", content: "GROUPNEEDLE" },
      { toolUseId: "c", content: "failed read", isError: true },
    ] },
    { role: "assistant", content: "Done" },
  ]);
  expect(screen.getByText("failed read")).toBeInTheDocument();
  fireEvent.click(screen.getByText("clisessions.expand_processes"));
  const group = document.querySelector("[data-session-group]");
  expect(group).not.toHaveAttribute("open");
  expect(screen.queryByText("GROUPNEEDLE")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("clisessions.find"), { target: { value: "GROUPNEEDLE" } });
  await waitFor(() => expect(group).toHaveAttribute("open"));
  expect(screen.getByText("GROUPNEEDLE")).toBeInTheDocument();
  expect(screen.getByText("failed read").closest("details").closest("[data-session-group]")).toBeNull();
});

it("fetches long message pages on disclosure and copies the full field", async () => {
  const text = "A".repeat(280000) + "COPYTAIL";
  const pages = [];
  const clipboard = { writeText: vi.fn(async () => {}) };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  const messages = [{ role: "user", content: "Review" }, { role: "assistant", content: text }];
  await openTranscript(messages, url => {
    if (url.pathname.endsWith("/content")) {
      const offset = Number(url.searchParams.get("offset"));
      pages.push(offset);
      const nextOffset = Math.min(text.length, offset + 128 * 1024);
      return { ok: true, content: text.slice(offset, nextOffset), nextOffset };
    }
    return { ok: true, preview: true, revision: "v1", messages: [messages[0],
      { ...messages[1], content: text.slice(0, 1200), contentRef: { id: "1:content", length: text.length } }] };
  });
  expect(pages).toEqual([]);
  fireEvent.click(screen.getByText("clisessions.expand_content"));
  await waitFor(() => expect(pages).toEqual([0]));
  fireEvent.click(screen.getAllByLabelText("clisessions.copy_message").at(-1));
  await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(text));
  expect(pages).toEqual([0, 128 * 1024, 256 * 1024]);
  expect(screen.getByText(/COPYTAIL$/)).toBeInTheDocument();
});

it("disables code copying until the complete message is displayed", async () => {
  const code = "const value = 1;\n".repeat(600) + "// CODETAIL";
  const text = `\`\`\`js\n${code}\n\`\`\``;
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const full = { revision: "v1", messages: [{ role: "user", content: text }] };
  const pages = [];
  await openTranscript(full.messages, url => {
    if (url.pathname.endsWith("/content")) {
      const options = Object.fromEntries(url.searchParams);
      pages.push(options.ref);
      return { ok: true, ...contentPage(full, options) };
    }
    return { ok: true, ...previewTranscript(full) };
  });
  const button = screen.getByRole("button", { name: "clisessions.copy_code" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(writeText).not.toHaveBeenCalled();
  expect(pages).toEqual([]);
  fireEvent.click(screen.getByText("clisessions.expand_content"));
  await waitFor(() => expect(screen.getByRole("button", { name: "clisessions.copy_code" })).toBeEnabled());
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "clisessions.copy_code" }));
  });
  expect(writeText).toHaveBeenCalledWith(code);
  expect(pages).toEqual(["0:content"]);
  fireEvent.click(screen.getByText("clisessions.collapse_content"));
  expect(screen.getByRole("button", { name: "clisessions.copy_code" })).toBeDisabled();
});

it("loads each result of a repeated call independently and keeps earlier and short output", async () => {
  const outputs = ["FIRST_OUTPUT\n" + "a".repeat(270000) + "\nFIRSTTAIL", "SHORT_OUTPUT",
    "SECOND_OUTPUT\n" + "b".repeat(5000) + "\nSECONDTAIL"];
  const full = { revision: "v1", messages: [
    { role: "user", content: "Review output" },
    { role: "assistant", content: "", toolCalls: [{ id: "t", name: "Bash", input: { command: "npm test" } }] },
    ...outputs.map(content => ({ role: "tool", content, toolResults: [{ toolUseId: "t", content }] })),
    { role: "assistant", content: "Done" },
  ] };
  const pages = [];
  await openTranscript(full.messages, url => {
    if (url.pathname.endsWith("/content")) {
      const options = Object.fromEntries(url.searchParams);
      pages.push([options.ref, Number(options.offset)]);
      return { ok: true, ...contentPage(full, options) };
    }
    return { ok: true, ...(url.searchParams.get("preview") === "1" ? previewTranscript(full) : full) };
  });
  fireEvent.click(screen.getByText("clisessions.expand_processes"));
  expandStep("Bash");
  await screen.findByText(/SECONDTAIL$/);
  expect(screen.getByText(/^FIRST_OUTPUT/)).toBeInTheDocument();
  expect(screen.getByText("SHORT_OUTPUT")).toBeInTheDocument();
  expect(pages).toEqual(expect.arrayContaining([["2:result:0:content", 0], ["4:result:0:content", 0]]));
  fireEvent.click(screen.getByText("clisessions.load_more"));
  await waitFor(() => expect(pages).toContainEqual(["2:result:0:content", 128 * 1024]));
  await waitFor(() => expect(screen.getByText("clisessions.load_more")).toBeEnabled());
  fireEvent.click(screen.getByText("clisessions.load_more"));
  await screen.findByText(/FIRSTTAIL$/);
  expect(screen.getByText("SHORT_OUTPUT")).toBeInTheDocument();
  expect(screen.getByText(/SECONDTAIL$/)).toBeInTheDocument();
  expect(screen.queryByText("clisessions.load_more")).not.toBeInTheDocument();
});

it("does not report partial search results and retries complete transcript loading", async () => {
  let fail = true;
  const full = [{ role: "user", content: "Review" }, { role: "assistant", content: "prefix\n".repeat(1000) + "HIDDENTAIL" }];
  await openTranscript(full, url => url.searchParams.get("preview") === "1"
    ? { ok: true, revision: "v1", preview: true, messages: [full[0], { ...full[1], content: "prefix", contentRef: { id: "1:content", length: full[1].content.length } }] }
    : fail ? { ok: false, error: "temporary read failure" } : { ok: true, revision: "v1", messages: full });
  fireEvent.change(screen.getByLabelText("clisessions.find"), { target: { value: "HIDDENTAIL" } });
  await screen.findByText("clisessions.content_failed");
  expect(screen.queryByText('clisessions.find_count:{"current":0,"count":0}')).not.toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "clisessions.content_retry" }));
  await screen.findByText('clisessions.find_count:{"current":1,"count":1}');
  expect(document.querySelector("[data-session-hit]")).toHaveTextContent("HIDDENTAIL");
});

it("exports full content instead of the initial preview", async () => {
  const full = [{ role: "assistant", content: "preview\n".repeat(1000) + "EXPORTTAIL" }];
  const createUrl = vi.fn(() => "blob:fixture");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await openTranscript(full, url => url.searchParams.get("preview") === "1"
    ? { ok: true, revision: "v1", preview: true, messages: [{ ...full[0], content: "preview", contentRef: { id: "0:content", length: full[0].content.length } }] }
    : { ok: true, revision: "v1", messages: full });
  fireEvent.click(screen.getByLabelText("clisessions.export"));
  await waitFor(() => expect(createUrl).toHaveBeenCalledOnce());
  const text = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(createUrl.mock.calls[0][0]);
  });
  expect(text).toContain(full[0].content);
});

it("counts and highlights failures parsed from native Claude tool results", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-reader-errors-"));
  try {
    const sourcePath = path.join(
      home,
      ".claude",
      "projects",
      "fixture",
      "errors.jsonl",
    );
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    const rows = [
      { role: "user", content: "Run the checks" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "failed",
            name: "Bash",
            input: { command: "npm test" },
          },
          {
            type: "tool_use",
            id: "ok",
            name: "Read",
            input: { path: "errors.log" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "failed",
            is_error: true,
            content: "Exit code 1\nChecks failed",
          },
          {
            type: "tool_result",
            tool_use_id: "ok",
            is_error: false,
            content: "Error text from a successful read",
          },
          {
            type: "tool_result",
            tool_use_id: "orphan",
            is_error: true,
            content: "Unpaired tool failed",
          },
        ],
      },
    ];
    fs.writeFileSync(
      sourcePath,
      rows.map((message) => JSON.stringify({ message })).join("\n"),
    );
    const { messages } = await readSession({ app: "claude", sourcePath, home });
    await openTranscript(messages);

    expect(
      screen.getByText('clisessions.process_failed:{"count":2}'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("clisessions.expand_processes"));
    const failed = screen.getByText("Bash").closest("details");
    expect(failed).toHaveClass("bg-red-50/60");
    expect(failed).toHaveTextContent("Checks failed");
    expect(screen.getByText("Read").closest("details")).not.toHaveClass(
      "bg-red-50/60",
    );
    expect(screen.getByText("Unpaired tool failed")).toBeInTheDocument();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("renders image-only messages with accessible previews and visible fallbacks", async () => {
  const dataUrl = "data:image/png;base64,aW1hZ2U=";
  await openTranscript([
    {
      role: "user",
      content: "",
      images: [
        { dataUrl, byteLength: 5 },
        { oversized: true, byteLength: 3000000 },
      ],
    },
  ]);
  const image = screen.getByRole("img", {
    name: 'clisessions.image.alt:{"count":1}',
  });
  expect(image).toHaveAttribute("src", dataUrl);
  expect(screen.getByText("clisessions.image.oversized")).toBeInTheDocument();
  fireEvent.error(image);
  expect(screen.getByText("clisessions.image.unavailable")).toBeInTheDocument();
});

it("shows change counts with distinct applied, failed and unconfirmed states", async () => {
  const body =
    "*** Begin Patch\n*** Update File: file.txt\n+++literal plus\n---literal minus\n*** End Patch";
  await openTranscript([
    {
      role: "assistant",
      content: "",
      toolCalls: ["success", "failed", "pending"].map((status) => ({
        callId: status,
        name: `apply_patch_${status}`,
        arguments: body,
        patch: {
          body,
          files: [{ kind: "update", path: "file.txt" }],
          additions: 1,
          deletions: 1,
          status,
          error: status === "failed",
        },
      })),
    },
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: "clisessions.expand_processes" }),
  );
  const applied = screen.getByText("apply_patch_success").closest("details");
  expandStep("apply_patch_success");
  expect(applied.querySelector("summary")).toHaveTextContent(
    "+1 −1clisessions.patch.success",
  );
  for (const status of ["failed", "pending"]) {
    expandStep(`apply_patch_${status}`);
    const details = screen
      .getByText(`apply_patch_${status}`)
      .closest("details");
    expect(details.querySelector("summary")).toHaveTextContent("+1 −1");
    expect(details.querySelector("summary")).toHaveTextContent(
      `clisessions.patch.${status}`,
    );
    expect(details.querySelector("pre")).toHaveTextContent("+++literal plus");
  }
  expect(applied.querySelector("pre").children[1]).toHaveClass(
    "text-emerald-800",
  );
  expect(applied.querySelector("pre").children[2]).toHaveClass("text-red-800");
});

it("expands truncated patches and reveals search hits beyond the preview", async () => {
  const body = [
    ...Array.from({ length: 401 }, (_, i) => `+line ${i}`),
    "+deep-needle",
  ].join("\n");
  await openTranscript([
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          name: "apply_patch",
          patch: {
            body,
            files: [],
            additions: 402,
            deletions: 0,
            status: "success",
          },
        },
      ],
    },
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: "clisessions.expand_processes" }),
  );
  expandStep("apply_patch");
  expect(screen.queryByText("+deep-needle")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", {
      name: 'clisessions.patch.show_more:{"count":2}',
    }),
  );
  expect(screen.getByText("+deep-needle")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("clisessions.find"), {
    target: { value: "deep-needle" },
  });
  await waitFor(() =>
    expect(screen.getByText("apply_patch").closest("details")).toHaveAttribute(
      "open",
    ),
  );
  expect(
    screen.getByText("deep-needle", { selector: "mark" }),
  ).toBeInTheDocument();
});

it("refreshes the list without requiring an abort signal", async () => {
  await openTranscript([{ role: "user", content: "refresh fixture" }]);
  fireEvent.click(screen.getByLabelText("clisessions.back"));
  fireEvent.click(screen.getByLabelText("clisessions.refresh"));
  await waitFor(() =>
    expect(screen.getByLabelText("clisessions.refresh")).not.toBeDisabled(),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each([
  ["success", "before"],
  ["success", "after"],
  ["failure", "before"],
  ["failure", "after"],
])(
  "ignores a stale refresh %s arriving %s the current app's list",
  async (outcome, order) => {
    let claudeReads = 0;
    let finishRefresh;
    let finishCodex;
    const codexSession = {
      ...session,
      appId: "codex",
      title: "Codex fixture",
      sourcePath: "/fixture/codex.jsonl",
    };
    const listResponse = (entry) => ({
      json: async () => ({ ok: true, sessions: [entry] }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (url === "/api/cli-sessions")
          return {
            json: async () => ({
              ok: true,
              apps: [
                { id: "claude", available: true },
                { id: "codex", available: true },
              ],
            }),
          };
        if (url.includes("app=claude")) {
          if (++claudeReads === 1) return listResponse(session);
          // Deliberately ignore cancellation so an already-delivered response or
          // late network error still exercises the page's stale-response guard.
          return new Promise((resolve, reject) => {
            finishRefresh = () =>
              outcome === "success"
                ? resolve(listResponse(session))
                : reject(new Error("stale refresh failed"));
          });
        }
        if (url.includes("app=codex"))
          return new Promise((resolve) => {
            finishCodex = () => resolve(listResponse(codexSession));
          });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(<CliSessionsPage />);
    await screen.findByText(session.title);
    fireEvent.click(screen.getByLabelText("clisessions.refresh"));
    fireEvent.click(screen.getByRole("tab", { name: "pswitch.tab.codex" }));

    if (order === "before") {
      await act(async () => {
        finishRefresh();
      });
      expect(screen.getByLabelText("clisessions.refresh")).toBeDisabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
    await act(async () => {
      finishCodex();
    });
    if (order === "after")
      await act(async () => {
        finishRefresh();
      });
    expect(
      screen.getByRole("tab", { name: "pswitch.tab.codex" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(codexSession.title)).toBeInTheDocument();
    expect(screen.queryByText(session.title)).not.toBeInTheDocument();
    expect(screen.getByLabelText("clisessions.refresh")).not.toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  },
);

it("lists sessions for the active app and opens the transcript", async () => {
  const fetchMock = vi.fn(async (url) => {
    if (String(url).startsWith("/api/cli-sessions ")) throw new Error("no");
    const path = String(url);
    if (path === "/api/cli-sessions") {
      return {
        json: async () => ({
          ok: true,
          apps: [
            { id: "claude", available: true },
            { id: "codex", available: false },
          ],
        }),
      };
    }
    if (path.startsWith("/api/cli-sessions/list")) {
      return {
        json: async () => ({ ok: true, app: "claude", sessions: [session] }),
      };
    }
    if (path.startsWith("/api/cli-sessions/read")) {
      expect(path).toContain(`path=${encodeURIComponent(session.sourcePath)}`);
      return {
        json: async () => ({
          ok: true,
          app: "claude",
          messages: [
            {
              role: "user",
              content: "Fix the login bug",
              ts: 1_700_000_000_000,
            },
            {
              role: "assistant",
              content: "[Tool: Read]\nOn it.",
              ts: 1_700_000_000_001,
            },
          ],
          usage: {
            totalTokens: 1120,
            durationMs: 10000,
            model: "claude-sonnet-5",
            estimatedCostUsd: 0.0013575,
          },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<CliSessionsPage />);
  await screen.findByText("Fix the login bug");
  fireEvent.click(screen.getByText("Fix the login bug"));
  await screen.findByText("Fix the login bug", { selector: "p" });
  expect(screen.getByText("clisessions.role.user")).toBeInTheDocument();
  expect(screen.getByText("clisessions.role.assistant")).toBeInTheDocument();
  expect(screen.getByText(/On it\./)).toBeInTheDocument();
  // Reader-header usage chips: tokens, active span and the estimated cost.
  // The token format is Intl-locale-dependent — derive the expectation.
  const expectedTokens = new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(1120);
  expect(screen.getByText("clisessions.usage.tokens")).toBeInTheDocument();
  expect(screen.getByText(expectedTokens)).toBeInTheDocument();
  expect(screen.getByText("clisessions.usage.duration")).toBeInTheDocument();
  expect(screen.getByText("10s")).toBeInTheDocument();
  expect(screen.getByText("clisessions.usage.cost")).toBeInTheDocument();
  expect(screen.getByText("$0.0014")).toBeInTheDocument();
  vi.unstubAllGlobals();
});

it("shows the empty state when the app has no sessions", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path === "/api/cli-sessions") {
        return {
          json: async () => ({
            ok: true,
            apps: [{ id: "claude", available: true }],
          }),
        };
      }
      if (path.startsWith("/api/cli-sessions/list")) {
        return {
          json: async () => ({ ok: true, app: "claude", sessions: [] }),
        };
      }
      throw new Error(`unexpected fetch: ${path}`);
    }),
  );

  render(<CliSessionsPage />);
  await screen.findByText("clisessions.empty");
  expect(screen.getByRole("status")).toHaveTextContent("clisessions.count");
  vi.unstubAllGlobals();
});

it("renders thinking rows, auto-opens search hits inside collapsed blocks, and exports markdown", async () => {
  const messages = [
    {
      role: "assistant",
      content: "Working.",
      thinking: "secret-needle in reasoning",
      ts: 1_700_000_000_000,
    },
    {
      role: "assistant",
      content: "",
      ts: 1_700_000_000_001,
      toolCalls: [
        { id: "t1", name: "Read", input: { path: "needle-file.js" } },
      ],
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path === "/api/cli-sessions")
        return {
          json: async () => ({
            ok: true,
            apps: [{ id: "claude", available: true }],
          }),
        };
      if (path.startsWith("/api/cli-sessions/list"))
        return {
          json: async () => ({ ok: true, app: "claude", sessions: [session] }),
        };
      if (path.startsWith("/api/cli-sessions/read"))
        return {
          json: async () => ({
            ok: true,
            app: "claude",
            messages,
            usage: null,
          }),
        };
      throw new Error(`unexpected fetch: ${path}`);
    }),
  );

  const urls = [];
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL(blob) {
        urls.push(blob);
        return "blob:x";
      }
      static revokeObjectURL() {}
    },
  );
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});

  render(<CliSessionsPage />);
  await screen.findByText("Fix the login bug");
  fireEvent.click(screen.getByText("Fix the login bug"));
  await waitFor(() =>
    expect(screen.getByLabelText("clisessions.export")).not.toBeDisabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "clisessions.expand_processes" }),
  );
  // Thinking row renders as a collapsed block with its label.
  const thinking = await screen.findByText("clisessions.thinking");
  expect(thinking.closest("details").open).toBe(false);

  // Searching for a term that only appears inside the collapsed blocks opens them.
  const search = screen.getByLabelText("clisessions.find");
  fireEvent.change(search, { target: { value: "needle" } });
  await waitFor(() => {
    const details = screen.getByText("clisessions.thinking").closest("details");
    expect(details.open).toBe(true);
  });
  expect(screen.getAllByText(/needle/).length).toBeGreaterThanOrEqual(2);
  // The tool call whose payload contains the hit is open too (its summary
  // "Read" sits inside the same row as the highlighted payload).
  const toolDetails = screen.getByText("Read").closest("details");
  expect(toolDetails.open).toBe(true);
  expect(toolDetails.querySelector("mark")).not.toBeNull();

  // Export produces a text/markdown blob with role sections.
  fireEvent.click(screen.getByLabelText("clisessions.export"));
  await waitFor(() => expect(urls.length).toBe(1));
  expect(urls[0].type).toBe("text/markdown;charset=utf-8");
  // jsdom Blob lacks .text() — size > 0 is the content smoke check here.
  expect(urls[0].size).toBeGreaterThan(0);
  clickSpy.mockRestore();
  vi.unstubAllGlobals();
});

it("keeps list search separate from transcript search and preserves it on return", async () => {
  await openTranscript([
    { role: "user", content: "A question" },
    { role: "assistant", content: "Only in the transcript" },
  ]);
  expect(screen.getByLabelText("clisessions.search")).not.toBeVisible();
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });
  expect(screen.getByLabelText("clisessions.find")).toHaveFocus();
  fireEvent.change(screen.getByLabelText("clisessions.find"), {
    target: { value: "Only in" },
  });
  await screen.findByText("Only in", { selector: "mark" });
  fireEvent.click(screen.getByLabelText("clisessions.back"));
  fireEvent.change(screen.getByLabelText("clisessions.search"), {
    target: { value: "login" },
  });
  await screen.findByText("login", { selector: "mark" });
  fireEvent.click(screen.getByText("login", { selector: "mark" }));
  await waitFor(() =>
    expect(screen.getByLabelText("clisessions.export")).not.toBeDisabled(),
  );
  expect(screen.getByLabelText("clisessions.find")).toHaveValue("");
  fireEvent.click(screen.getByLabelText("clisessions.back"));
  expect(screen.getByLabelText("clisessions.search")).toHaveValue("login");
});

it("renders markdown, pairs tool results, filters changes and navigates matching turns", async () => {
  await openTranscript([
    { role: "user", content: "First question" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          callId: "edit",
          name: "apply_patch",
          input: "patch",
          patch: {
            body: "+needle",
            files: [],
            additions: 1,
            deletions: 0,
            status: "success",
          },
        },
      ],
    },
    {
      role: "tool",
      content: "paired output",
      toolResults: [{ callId: "edit", output: "paired output" }],
    },
    {
      role: "assistant",
      content:
        "## Finished\n\n**Bold result**\n\n![remote](https://images.example/test.png)",
    },
    { role: "user", content: "Second question" },
    { role: "assistant", content: "The other needle." },
  ]);
  expect(screen.getByRole("heading", { name: "Finished" })).toBeInTheDocument();
  expect(screen.getByText("Bold result").tagName).toBe("STRONG");
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "remote" })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  expect(screen.queryByText("paired output")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("clisessions.expand_processes"));
  expandStep("apply_patch");
  expect(screen.getByText("apply_patch").closest("details")).toHaveTextContent(
    "paired output",
  );
  fireEvent.click(screen.getByText("clisessions.filter.changes"));
  expect(screen.queryByText("Second question")).not.toBeInTheDocument();
  expect(screen.queryByText("Bold result")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("clisessions.find"), {
    target: { value: "needle" },
  });
  await screen.findByText('clisessions.find_count:{"current":1,"count":2}');
  fireEvent.click(screen.getByRole("button", { name: "clisessions.outline" }));
  const outline = screen.getByRole("navigation", {
    name: "clisessions.outline",
  });
  expect(
    within(outline).getByRole("button", { name: "1 First question" }),
  ).toHaveAttribute("aria-current", "location");
  fireEvent.click(screen.getByLabelText("clisessions.find_next"));
  expect(
    within(outline).getByRole("button", { name: "2 Second question" }),
  ).toHaveAttribute("aria-current", "location");
  fireEvent.click(screen.getByLabelText("clisessions.find_next"));
  expect(
    within(outline).getByRole("button", { name: "1 First question" }),
  ).toHaveAttribute("aria-current", "location");
});

it("renders user code with independent copy and exposes matches hidden in Markdown syntax", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await openTranscript([
    { role: "user", content: "Check this:\n```js\nconst value = 1;\n```" },
    {
      role: "assistant",
      content: "Read [reference](https://example.test/hidden-url-target).",
    },
  ]);
  expect(
    screen.getByText("const value = 1;").closest("pre"),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "clisessions.copy_code" }),
  );
  expect(writeText).toHaveBeenCalledWith(
    "const value = 1;",
  );
  fireEvent.change(screen.getByLabelText("clisessions.find"), {
    target: { value: "hidden-url-target" },
  });
  await screen.findByText("clisessions.find_raw");
  expect(document.querySelector("mark")).toHaveTextContent("hidden-url-target");
  fireEvent.change(screen.getByLabelText("clisessions.find"), {
    target: { value: "reference" },
  });
  await waitFor(() =>
    expect(screen.queryByText("clisessions.find_raw")).not.toBeInTheDocument(),
  );
});

it("offers localized transcript recovery without showing a zero-turn count", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (url.includes("/read?"))
        throw new Error("ENOENT fixture log unavailable");
      if (url.includes("/list?"))
        return { json: async () => ({ ok: true, sessions: [session] }) };
      return {
        json: async () => ({
          ok: true,
          apps: [{ id: "claude", available: true }],
        }),
      };
    }),
  );
  render(<CliSessionsPage />);
  fireEvent.click(await screen.findByText(session.title));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("clisessions.read_failed");
  expect(
    within(alert).getByRole("button", { name: "clisessions.reload" }),
  ).toBeInTheDocument();
  expect(
    within(alert).getByRole("button", { name: "clisessions.back" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByText('clisessions.turn_count:{"count":0}'),
  ).not.toBeInTheDocument();
});

it("cancels a transcript on return and ignores it after a different session is opened", async () => {
  const other = {
    ...session,
    sessionId: "s-2",
    title: "Other session",
    sourcePath: "/fixture/s-2.jsonl",
  };
  let finishOld;
  let oldSignal;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      if (url === "/api/cli-sessions")
        return {
          json: async () => ({
            ok: true,
            apps: [{ id: "claude", available: true }],
          }),
        };
      if (url.startsWith("/api/cli-sessions/list"))
        return { json: async () => ({ ok: true, sessions: [session, other] }) };
      if (url.includes(encodeURIComponent(session.sourcePath))) {
        oldSignal = options.signal;
        return new Promise((resolve) => {
          finishOld = () =>
            resolve({
              json: async () => ({
                ok: true,
                messages: [{ role: "assistant", content: "Stale transcript" }],
              }),
            });
        });
      }
      return {
        json: async () => ({
          ok: true,
          messages: [{ role: "assistant", content: "Current transcript" }],
        }),
      };
    }),
  );
  render(<CliSessionsPage />);
  fireEvent.click(await screen.findByText(session.title));
  fireEvent.click(screen.getByLabelText("clisessions.back"));
  expect(oldSignal.aborted).toBe(true);
  fireEvent.click(screen.getByText(other.title));
  await screen.findByText("Current transcript");
  await act(async () => finishOld());
  expect(screen.queryByText("Stale transcript")).not.toBeInTheDocument();
  expect(screen.getByText("Current transcript")).toBeInTheDocument();
});

function mockSessionNavigation() {
  const fetchMock = vi.fn(async (url) => {
    if (url === "/api/cli-sessions")
      return {
        json: async () => ({
          ok: true,
          apps: [{ id: "claude", available: true }],
        }),
      };
    if (url.startsWith("/api/cli-sessions/list"))
      return { json: async () => ({ ok: true, sessions: [session] }) };
    if (url.startsWith("/api/cli-sessions/read"))
      return {
        json: async () => ({
          ok: true,
          messages: [{ role: "assistant", content: "Navigation transcript" }],
        }),
      };
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

it("returns to the filtered list with browser back and restores the reader with forward", async () => {
  mockSessionNavigation();
  const { router } = render(<CliSessionsPage />);
  await screen.findByText(session.title);
  fireEvent.change(screen.getByLabelText("clisessions.search"), {
    target: { value: "login" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Fix the login bug/ }));
  await screen.findByText("Navigation transcript");
  expect(new URLSearchParams(router.state.location.search).get("session")).toBe(
    session.sessionId,
  );
  expect(router.state.location.search).not.toContain(
    encodeURIComponent(session.sourcePath),
  );
  await act(async () => router.navigate(-1));
  expect(screen.getByLabelText("clisessions.search")).toHaveValue("login");
  expect(screen.queryByText("Navigation transcript")).not.toBeInTheDocument();
  await act(async () => router.navigate(1));
  await screen.findByText("Navigation transcript");
  fireEvent.click(screen.getByLabelText("clisessions.back"));
  expect(screen.getByLabelText("clisessions.search")).toHaveValue("login");
});

it("restores a directly opened reader and returns to its list without leaving the page", async () => {
  const fetchMock = mockSessionNavigation();
  const { router } = render(<CliSessionsPage />, [
    "/cli-sessions?app=claude&sessionApp=claude&session=s-1",
  ]);
  await screen.findByText("Navigation transcript");
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining(encodeURIComponent(session.sourcePath)),
    expect.anything(),
  );
  fireEvent.click(screen.getByLabelText("clisessions.back"));
  expect(router.state.location.pathname).toBe("/cli-sessions");
  expect(new URLSearchParams(router.state.location.search).has("session")).toBe(
    false,
  );
  expect(screen.getByText(session.title)).toBeVisible();
});

it("offers recovery for an unknown session without reading a URL-supplied file path", async () => {
  const fetchMock = mockSessionNavigation();
  const { router } = render(<CliSessionsPage />, [
    "/cli-sessions?app=claude&sessionApp=claude&session=%2Ftmp%2Fprivate.jsonl",
  ]);
  await screen.findByText("clisessions.unavailable");
  expect(
    fetchMock.mock.calls.some(([url]) =>
      url.startsWith("/api/cli-sessions/read"),
    ),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "clisessions.back" }));
  expect(new URLSearchParams(router.state.location.search).has("session")).toBe(
    false,
  );
  expect(screen.queryByText("clisessions.unavailable")).not.toBeInTheDocument();
});
