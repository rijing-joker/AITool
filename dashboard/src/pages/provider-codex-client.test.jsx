import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, it, expect, vi } from "vitest";
import { ProviderCodexClient } from "./provider-codex-client";
import { providerSwitchApi } from "../lib/provider-switch-api";

vi.mock("../lib/copy", () => ({ copy: (key) => key }));
vi.mock("../lib/provider-switch-api", () => ({ providerSwitchApi: {
  getCodexClient: vi.fn(), restartCodexDaemon: vi.fn(), acknowledgeCodexClients: vi.fn(),
} }));
const stale = { daemonRunning: true, daemon: true, others: true, auth: true, catalog: false, revision: "first" };
beforeEach(() => {
  vi.clearAllMocks();
  providerSwitchApi.getCodexClient.mockResolvedValue({ client: stale });
  providerSwitchApi.restartCodexDaemon.mockResolvedValue({ outcome: "restarted" });
  providerSwitchApi.acknowledgeCodexClients.mockResolvedValue({ ok: true });
});
it("requires confirmation and refreshes client status after a graceful restart", async () => {
  render(<ProviderCodexClient />);
  fireEvent.click(await screen.findByRole("button", { name: "pswitch.codex_client.restart" }));
  expect(providerSwitchApi.restartCodexDaemon).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog");
  providerSwitchApi.getCodexClient.mockResolvedValue({ client: { ...stale, daemon: false, others: false } });
  fireEvent.click(within(dialog).getByRole("button", { name: "pswitch.codex_client.restart" }));
  await screen.findByText("pswitch.codex_client.restarted");
  expect(providerSwitchApi.restartCodexDaemon).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("pswitch.codex_client.auth")).toBeNull();
});
it("dismisses the current notice and shows a later catalog change", async () => {
  const page = render(<ProviderCodexClient revision={1} />);
  fireEvent.click(await screen.findByRole("button", { name: "pswitch.codex_client.dismiss" }));
  await waitFor(() => expect(screen.queryByText("pswitch.codex_client.auth")).toBeNull());
  expect(providerSwitchApi.acknowledgeCodexClients).toHaveBeenCalledTimes(1);
  providerSwitchApi.getCodexClient.mockResolvedValue({ client: { ...stale, auth: false, catalog: true, revision: "second" } });
  page.rerender(<ProviderCodexClient revision={2} />);
  await screen.findByText("pswitch.codex_client.catalog");
});
it("shows a reopen notice without offering restart for unverified clients", async () => {
  providerSwitchApi.getCodexClient.mockResolvedValue({ client: { ...stale, daemonRunning: false, daemon: false, unverified: true } });
  render(<ProviderCodexClient />);
  await screen.findByText("pswitch.codex_client.unverified");
  expect(screen.queryByRole("button", { name: "pswitch.codex_client.restart" })).toBeNull();
});
