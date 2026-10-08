import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryRouter, Link, Outlet, RouterProvider } from "react-router-dom";
import { mcpApi, piPromptFilesApi, promptsApi } from "../lib/provider-switch-api";
import { ProviderSwitchPage } from "./ProviderSwitchPage";

vi.mock("../lib/copy", () => ({ copy: (key) => key }));
vi.mock("../ui/components/Toast", () => ({ showToast: vi.fn() }));
vi.mock("../lib/provider-switch-api", () => ({
  mcpApi: { list: vi.fn(), upsert: vi.fn(), toggle: vi.fn(), remove: vi.fn(), import: vi.fn() },
  promptsApi: { list: vi.fn(), upsert: vi.fn(), enable: vi.fn(), remove: vi.fn(), import: vi.fn() },
  piPromptFilesApi: { get: vi.fn(), replace: vi.fn(), remove: vi.fn() },
  providerSwitchApi: {
    getStatus: vi.fn(async () => ({ apps: [{ app: "claude", current: null, providers: [] }], visibleApps: {}, storagePath: "/tmp/fixture" })),
    listBackups: vi.fn(async () => ({ backups: [] })),
    getPresets: vi.fn(async () => ({ presets: [] })),
    getFailover: vi.fn(async () => ({ failover: { config: { enabled: false }, apps: {}, suggestions: [], cooldowns: [], actions: [] } })),
  },
}));

beforeEach(() => {
  const NativeRequest = globalThis.Request;
  // Node's Request and jsdom's AbortSignal come from different realms.
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input, init) {
      super(input, { ...init, signal: undefined });
    }
  });
  vi.clearAllMocks();
  mcpApi.list.mockResolvedValue({ servers: [] });
  mcpApi.upsert.mockResolvedValue({ servers: [], failures: [] });
  promptsApi.list.mockResolvedValue({ prompts: [], targetPath: "/fixture/CLAUDE.md" });
  promptsApi.upsert.mockResolvedValue({ prompts: [], targetPath: "/fixture/CLAUDE.md" });
  piPromptFilesApi.get.mockImplementation(async (kind) => ({ file: { kind, content: "Initial instructions", path: `/fixture/${kind}.md`, revision: "rev-1", exists: true } }));
  piPromptFilesApi.replace.mockResolvedValue({ ok: true });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openPanel(tab) {
  const router = createMemoryRouter([{
    element: <><nav><Link to="/elsewhere">{"Leave page"}</Link></nav><Outlet /></>,
    children: [
      { path: "/provider-switch", element: <ProviderSwitchPage /> },
      { path: "/elsewhere", element: <p>{"Other page"}</p> },
    ],
  }], { initialEntries: ["/provider-switch"] });
  render(<RouterProvider router={router} />);
  fireEvent.click(await screen.findByRole("tab", { name: `pswitch.${tab}.tab` }));
  await screen.findByText(`pswitch.${tab}.title`);
  return router;
}

async function addPrompt() {
  await openPanel("prompts");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.prompts.add" }));
  return screen.getByLabelText("pswitch.prompts.field_name");
}

it("uses an inline MCP editor, reports invalid drafts, and confirms discard", async () => {
  await openPanel("mcp");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.mcp.add" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Leave page" })).toBeVisible();
  fireEvent.change(screen.getByLabelText("pswitch.mcp.field_spec"), { target: { value: "{invalid" } });
  expect(screen.getByRole("button", { name: "pswitch.action.save" })).toBeDisabled();
  fireEvent.keyDown(screen.getByLabelText("pswitch.mcp.field_spec"), { key: "Escape" });
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "shared.unsaved.keep_editing" }));
  expect(screen.getByLabelText("pswitch.mcp.field_spec")).toHaveValue("{invalid");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "clisessions.back" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "shared.unsaved.discard" }));
  await screen.findByRole("tablist");
  expect(mcpApi.upsert).not.toHaveBeenCalled();
});

it("reverting all MCP app toggles leaves the editor clean", async () => {
  await openPanel("mcp");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.mcp.add" }));
  const claude = screen.getByRole("button", { name: "pswitch.tab.claude" });
  fireEvent.click(claude);
  fireEvent.click(claude);
  fireEvent.click(screen.getByRole("button", { name: "clisessions.back" }));
  await screen.findByRole("tablist");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("saves the MCP editor without changing the server payload contract", async () => {
  await openPanel("mcp");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.mcp.add" }));
  fireEvent.change(screen.getByLabelText(/pswitch.mcp.field_id/), { target: { value: "fixture" } });
  fireEvent.change(screen.getByLabelText("pswitch.mcp.field_spec"), { target: { value: '{"command":"fixture-server"}' } });
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.save" }));
  await waitFor(() => expect(mcpApi.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: "fixture", server: { command: "fixture-server" } })));
  await screen.findByRole("tablist");
});

it("blocks route navigation and beforeunload until a prompt draft is discarded", async () => {
  const name = await addPrompt();
  fireEvent.change(name, { target: { value: "Draft" } });
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole("link", { name: "Leave page" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "shared.unsaved.keep_editing" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(name).toHaveValue("Draft");
  fireEvent.click(screen.getByRole("link", { name: "Leave page" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "shared.unsaved.discard" }));
  await screen.findByText("Other page");
  const clean = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
});

it("keeps a failed prompt draft and locks controls and navigation during saving", async () => {
  const name = await addPrompt();
  fireEvent.change(name, { target: { value: "Retry draft" } });
  promptsApi.upsert.mockRejectedValueOnce(new Error("fixture failure"));
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.save" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "pswitch.action.save" })).toBeEnabled());
  expect(name).toHaveValue("Retry draft");
  let resolveSave;
  promptsApi.upsert.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.save" }));
  expect(name).toBeDisabled();
  expect(screen.getByRole("button", { name: "clisessions.back" })).toBeDisabled();
  fireEvent.click(screen.getByRole("link", { name: "Leave page" }));
  expect(within(await screen.findByRole("dialog")).getByRole("button", { name: "shared.unsaved.discard" })).toBeDisabled();
  await act(async () => { resolveSave({ prompts: [], targetPath: "/fixture/CLAUDE.md" }); });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "shared.unsaved.keep_editing" }));
  await screen.findByRole("tablist");
});

it("edits Pi files on a full page and retains revision-guarded drafts on conflict", async () => {
  await openPanel("prompts");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.tab.pi" }));
  fireEvent.click((await screen.findAllByRole("button", { name: "pswitch.pi_files.edit" }))[0]);
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "pswitch.tab.claude" })).not.toBeInTheDocument();
  const content = screen.getByRole("textbox", { name: "pswitch.pi_files.append_title" });
  fireEvent.change(content, { target: { value: "Updated native prompt" } });
  piPromptFilesApi.replace.mockRejectedValueOnce(new Error("revision conflict"));
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.save" }));
  await screen.findByText("revision conflict");
  expect(content).toHaveValue("Updated native prompt");
  expect(piPromptFilesApi.replace).toHaveBeenCalledWith("system_append", "Updated native prompt", "rev-1");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.save" }));
  await screen.findByRole("tablist");
  expect(screen.getByRole("button", { name: "pswitch.tab.pi" })).toHaveAttribute("aria-pressed", "true");
});
