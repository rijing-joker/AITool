import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, it, expect, vi } from "vitest";
import { CopilotClients } from "./copilot-clients";
import { proxyApi } from "../lib/proxy-api";
vi.mock("../lib/copy", () => ({ copy: (key) => key }));
vi.mock("../lib/proxy-api", () => ({ proxyApi: {
  copilotStatus: vi.fn(), copilotModels: vi.fn(), connectCopilot: vi.fn(), restoreCopilot: vi.fn(),
} }));
beforeEach(() => {
  vi.clearAllMocks();
  proxyApi.copilotStatus.mockResolvedValue({ clients: [{ client: "cli", canRestore: true, configured: true, model: "current" }, { client: "vscode" }] });
  proxyApi.copilotModels.mockResolvedValue({ models: ["model-1"] });
  proxyApi.connectCopilot.mockResolvedValue({ ok: true });
  proxyApi.restoreCopilot.mockResolvedValue({ ok: true });
});
it("connects the selected client with a key and model and confirms restoration", async () => {
  render(<CopilotClients keys={["fixture-key"]} remarks={{ "fixture-key": "Local CLI" }} />);
  fireEvent.change(screen.getByRole("combobox", { name: "proxy.copilot.model" }), { target: { value: "model-1" } });
  fireEvent.click(screen.getByRole("button", { name: "proxy.copilot.connect" }));
  await waitFor(() => expect(proxyApi.connectCopilot).toHaveBeenCalledWith("cli", "fixture-key", "model-1"));
  await screen.findByText("proxy.copilot.cli_ready");
  fireEvent.click(screen.getByRole("button", { name: "proxy.copilot.restore" }));
  expect(proxyApi.restoreCopilot).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "proxy.copilot.restore" }));
  await screen.findByText("proxy.copilot.restored");
});
it("reports native setup problems with localized guidance", async () => {
  proxyApi.connectCopilot.mockRejectedValue(new Error("COPILOT_SETUP_UNSUPPORTED"));
  render(<CopilotClients keys={["fixture-key"]} remarks={{}} />);
  fireEvent.change(screen.getByRole("combobox", { name: "proxy.copilot.client" }), { target: { value: "vscode" } });
  fireEvent.change(screen.getByRole("combobox", { name: "proxy.copilot.model" }), { target: { value: "model" } });
  fireEvent.click(screen.getByRole("button", { name: "proxy.copilot.connect" }));
  await screen.findByRole("alert");
  expect(screen.getByText("proxy.copilot.error.unsupported")).toBeTruthy();
});
