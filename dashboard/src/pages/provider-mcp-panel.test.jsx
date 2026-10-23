import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderMcpPanel } from "./provider-mcp-panel";
import { mcpApi } from "../lib/provider-switch-api";

vi.mock("../lib/copy", () => ({ copy: (key, vars) => vars?.tool ? `${key}: ${vars.tool} ${vars.app}` : key }));
vi.mock("../ui/components/Toast", () => ({ showToast: vi.fn() }));
vi.mock("../lib/provider-switch-api", () => ({ mcpApi: { list: vi.fn(), check: vi.fn(), tool: vi.fn() } }));
const server = { id: "sample", name: "Sample MCP", server: { command: "node", args: ["fixture.cjs"] }, apps: { codex: true }, disabledTools: {} };
const healthy = { status: "healthy", stage: "done", revision: "r1", checkedAt: "2026-10-22T00:00:00Z", tools: [{ name: "first", description: "Fixture tool" }] };

beforeEach(() => {
  vi.clearAllMocks();
  mcpApi.list.mockResolvedValue({ servers: [server], checks: {}, toolFilterApps: ["codex", "claude", "gemini", "hermes", "opencode"] });
});
afterEach(cleanup);

it("reads cached state without starting a process and checks only after a click", async () => {
  mcpApi.check.mockResolvedValue({ check: healthy });
  render(<ProviderMcpPanel />);
  await screen.findByText("Sample MCP");
  expect(mcpApi.check).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "pswitch.mcp.check" }));
  await screen.findByText(/pswitch.mcp.health_healthy/);
  expect(mcpApi.check).toHaveBeenCalledWith("sample", expect.any(AbortSignal));
  fireEvent.click(screen.getByText("pswitch.mcp.tools"));
  expect(screen.getByText("Fixture tool")).toBeTruthy();
});

it("cancels pending checks and aborts on unmount", async () => {
  let signal;
  mcpApi.check.mockImplementation((_id, incoming) => {
    signal = incoming;
    return new Promise((_resolve, reject) => incoming.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
  });
  const view = render(<ProviderMcpPanel />);
  await screen.findByText("Sample MCP");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.mcp.check" }));
  fireEvent.click(await screen.findByRole("button", { name: "pswitch.mcp.check_cancel" }));
  await screen.findByText("pswitch.mcp.health_cancelled");
  expect(signal.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "pswitch.mcp.check" }));
  view.unmount();
  expect(signal.aborted).toBe(true);
});

it("projects a checked tool with its revision and presents unsupported apps as read-only", async () => {
  mcpApi.list.mockResolvedValue({ servers: [server], checks: { sample: healthy }, toolFilterApps: ["codex"] });
  mcpApi.tool.mockResolvedValue({ servers: [{ ...server, disabledTools: { codex: ["first"] } }], failures: [] });
  render(<ProviderMcpPanel />);
  await screen.findByText("Sample MCP");
  fireEvent.click(screen.getByText("pswitch.mcp.tools"));
  const toggle = screen.getByRole("checkbox");
  fireEvent.click(toggle);
  await waitFor(() => expect(mcpApi.tool).toHaveBeenCalledWith("sample", "codex", "first", false, "r1"));
  await waitFor(() => expect(toggle.checked).toBe(false));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "pi" } });
  expect(screen.getByText("pswitch.mcp.tool_unsupported")).toBeTruthy();
  expect(screen.getByRole("checkbox").disabled).toBe(true);
});

it("shows a stage-specific failure and keeps server metadata as text", async () => {
  mcpApi.check.mockResolvedValue({ check: { ...healthy, status: "failed", stage: "tools", reason: "timeout", tools: [] } });
  render(<ProviderMcpPanel />);
  await screen.findByText("Sample MCP");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.mcp.check" }));
  await screen.findByText(/pswitch.mcp.reason_timeout/);
  expect(screen.getByText(/pswitch.mcp.stage_tools/)).toBeTruthy();
});

it("does not apply a late cancelled result", async () => {
  let finish;
  mcpApi.check.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<ProviderMcpPanel />);
  await screen.findByText("Sample MCP");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.mcp.check" }));
  fireEvent.click(await screen.findByRole("button", { name: "pswitch.mcp.check_cancel" }));
  await act(async () => finish({ check: healthy }));
  expect(screen.queryByText("pswitch.mcp.health_healthy")).toBeNull();
});
