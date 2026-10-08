import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CliSessionsPage } from "./CliSessionsPage";

vi.mock("../lib/copy", () => ({ copy: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) }));
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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openTranscript(messages) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = String(url);
    if (path === "/api/cli-sessions") return { json: async () => ({ ok: true, apps: [{ id: "claude", available: true }] }) };
    if (path.startsWith("/api/cli-sessions/list")) return { json: async () => ({ ok: true, sessions: [session] }) };
    if (path.startsWith("/api/cli-sessions/read")) return { json: async () => ({ ok: true, messages }) };
    throw new Error(`unexpected fetch: ${path}`);
  }));
  render(<CliSessionsPage />);
  fireEvent.click(await screen.findByText(session.title));
  await screen.findByLabelText("clisessions.export");
}

it("renders image-only messages with accessible previews and visible fallbacks", async () => {
  const dataUrl = "data:image/png;base64,aW1hZ2U=";
  await openTranscript([{ role: "user", content: "", images: [
    { dataUrl, byteLength: 5 },
    { oversized: true, byteLength: 3000000 },
  ] }]);
  const image = screen.getByRole("img", { name: 'clisessions.image.alt:{"count":1}' });
  expect(image).toHaveAttribute("src", dataUrl);
  expect(screen.getByText("clisessions.image.oversized")).toBeInTheDocument();
  fireEvent.error(image);
  expect(screen.getByText("clisessions.image.unavailable")).toBeInTheDocument();
});

it("only shows applied patch counts and preserves failed and unconfirmed diffs", async () => {
  const body = "*** Begin Patch\n*** Update File: file.txt\n+++literal plus\n---literal minus\n*** End Patch";
  await openTranscript([{
    role: "assistant", content: "", toolCalls: ["success", "failed", "pending"].map((status) => ({
      callId: status, name: `apply_patch_${status}`, arguments: body,
      patch: { body, files: [{ kind: "update", path: "file.txt" }], additions: 1, deletions: 1, status, error: status === "failed" },
    })),
  }]);
  const applied = screen.getByText("apply_patch_success").closest("details");
  expect(applied.querySelector("summary")).toHaveTextContent("+1−1clisessions.patch.success");
  for (const status of ["failed", "pending"]) {
    const details = screen.getByText(`apply_patch_${status}`).closest("details");
    expect(details.querySelector("summary")).not.toHaveTextContent("+1");
    expect(details.querySelector("summary")).toHaveTextContent(`clisessions.patch.${status}`);
    expect(details.querySelector("pre")).toHaveTextContent("+++literal plus");
  }
  expect(applied.querySelector("pre").children[2]).toHaveClass("text-emerald-700");
  expect(applied.querySelector("pre").children[3]).toHaveClass("text-red-700");
});

it("expands truncated patches and reveals search hits beyond the preview", async () => {
  const body = [...Array.from({ length: 401 }, (_, i) => `+line ${i}`), "+deep-needle"].join("\n");
  await openTranscript([{ role: "assistant", content: "", toolCalls: [{
    name: "apply_patch", patch: { body, files: [], additions: 402, deletions: 0, status: "success" },
  }] }]);
  expect(screen.queryByText("+deep-needle")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: 'clisessions.patch.show_more:{"count":2}' }));
  expect(screen.getByText("+deep-needle")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("clisessions.search"), { target: { value: "deep-needle" } });
  await waitFor(() => expect(screen.getByText("apply_patch").closest("details")).toHaveAttribute("open"));
  expect(screen.getByText("deep-needle", { selector: "mark" })).toBeInTheDocument();
});

it("refreshes the list without requiring an abort signal", async () => {
  await openTranscript([{ role: "user", content: "refresh fixture" }]);
  fireEvent.click(screen.getByLabelText("clisessions.refresh"));
  await waitFor(() => expect(screen.getByLabelText("clisessions.refresh")).not.toBeDisabled());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("lists sessions for the active app and opens the transcript", async () => {
  const fetchMock = vi.fn(async (url) => {
    if (String(url).startsWith("/api/cli-sessions ")) throw new Error("no");
    const path = String(url);
    if (path === "/api/cli-sessions") {
      return { json: async () => ({ ok: true, apps: [
        { id: "claude", available: true },
        { id: "codex", available: false },
      ] }) };
    }
    if (path.startsWith("/api/cli-sessions/list")) {
      return { json: async () => ({ ok: true, app: "claude", sessions: [session] }) };
    }
    if (path.startsWith("/api/cli-sessions/read")) {
      expect(path).toContain(`path=${encodeURIComponent(session.sourcePath)}`);
      return { json: async () => ({ ok: true, app: "claude", messages: [
        { role: "user", content: "Fix the login bug", ts: 1_700_000_000_000 },
        { role: "assistant", content: "[Tool: Read]\nOn it.", ts: 1_700_000_000_001 },
      ], usage: { totalTokens: 1120, durationMs: 10000, model: "claude-sonnet-5", estimatedCostUsd: 0.0013575 } }) };
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
  const expectedTokens = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(1120);
  expect(screen.getByText("clisessions.usage.tokens")).toBeInTheDocument();
  expect(screen.getByText(expectedTokens)).toBeInTheDocument();
  expect(screen.getByText("clisessions.usage.duration")).toBeInTheDocument();
  expect(screen.getByText("10s")).toBeInTheDocument();
  expect(screen.getByText("clisessions.usage.cost")).toBeInTheDocument();
  expect(screen.getByText("$0.0014")).toBeInTheDocument();
  vi.unstubAllGlobals();
});

it("shows the empty state when the app has no sessions", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = String(url);
    if (path === "/api/cli-sessions") {
      return { json: async () => ({ ok: true, apps: [{ id: "claude", available: true }] }) };
    }
    if (path.startsWith("/api/cli-sessions/list")) {
      return { json: async () => ({ ok: true, app: "claude", sessions: [] }) };
    }
    throw new Error(`unexpected fetch: ${path}`);
  }));

  render(<CliSessionsPage />);
  await screen.findByText("clisessions.empty");
  expect(screen.getByRole("status")).toHaveTextContent("clisessions.count");
  vi.unstubAllGlobals();
});

it("renders thinking rows, auto-opens search hits inside collapsed blocks, and exports markdown", async () => {
  const messages = [
    { role: "assistant", content: "Working.", thinking: "secret-needle in reasoning", ts: 1_700_000_000_000 },
    { role: "assistant", content: "", ts: 1_700_000_000_001, toolCalls: [{ id: "t1", name: "Read", input: { path: "needle-file.js" } }] },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = String(url);
    if (path === "/api/cli-sessions") return { json: async () => ({ ok: true, apps: [{ id: "claude", available: true }] }) };
    if (path.startsWith("/api/cli-sessions/list")) return { json: async () => ({ ok: true, app: "claude", sessions: [session] }) };
    if (path.startsWith("/api/cli-sessions/read")) return { json: async () => ({ ok: true, app: "claude", messages, usage: null }) };
    throw new Error(`unexpected fetch: ${path}`);
  }));

  const urls = [];
  vi.stubGlobal("URL", { ...URL, createObjectURL: (blob) => { urls.push(blob); return "blob:x"; }, revokeObjectURL: () => {} });
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  render(<CliSessionsPage />);
  await screen.findByText("Fix the login bug");
  fireEvent.click(screen.getByText("Fix the login bug"));
  // Thinking row renders as a collapsed block with its label.
  const thinking = await screen.findByText("clisessions.thinking");
  expect(thinking.closest("details").open).toBe(false);

  // Searching for a term that only appears inside the collapsed blocks opens them.
  const search = screen.getByLabelText("clisessions.search");
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
