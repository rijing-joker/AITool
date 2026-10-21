import React from "react";
import { MemoryRouter } from "react-router";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, it, vi } from "vitest";
import { ProviderSwitchPage } from "./ProviderSwitchPage";
import { providerSwitchApi } from "../lib/provider-switch-api";

vi.mock("../ui/components/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("../lib/copy", () => ({ copy: (key) => key }));
const mocks = vi.hoisted(() => ({
  status: {
    apps: [{ app: "claude", current: null, providers: [] }],
    visibleApps: {},
    storagePath: "/tmp/x",
  },
}));
vi.mock("../lib/provider-switch-api", () => ({
  promptsApi: {
    list: vi.fn(async () => ({ ok: true, app: "claude", prompts: [], targetPath: "/x/CLAUDE.md" })),
    upsert: vi.fn(), enable: vi.fn(), remove: vi.fn(), import: vi.fn(),
  },
  providerSwitchApi: {
    getStatus: vi.fn(async () => mocks.status),
    getCodexClient: vi.fn(async () => ({ client: { daemon: false, others: false } })),
    restartCodexDaemon: vi.fn(),
    acknowledgeCodexClients: vi.fn(),
    listBackups: vi.fn(async () => ({ backups: [] })),
    getPresets: vi.fn(async () => ({ presets: [] })),
    getFailover: vi.fn(async () => ({ failover: { config: { enabled: false, autoSwitch: false, windowMinutes: 30, minRequests: 5, failureRatePct: 50, cooldownMinutes: 30 }, apps: {}, suggestions: [], cooldowns: [], actions: [] } })),
    updateFailover: vi.fn(),
    runFailoverEvaluation: vi.fn(),
    switchProvider: vi.fn(),
    deleteProvider: vi.fn(),
    exportEncryptedBackup: vi.fn(),
    importEncryptedBackup: vi.fn(),
    getPiPromptFile: vi.fn(),
    replacePiPromptFile: vi.fn(),
    deletePiPromptFile: vi.fn(),
  },
  piPromptFilesApi: { get: vi.fn(), replace: vi.fn(), remove: vi.fn() },
  universalProvidersApi: {
    list: vi.fn(async () => ({ ok: true, providers: [] })),
    upsert: vi.fn(), sync: vi.fn(), remove: vi.fn(),
  },
  profilesApi: {
    list: vi.fn(async () => ({ ok: true, profiles: [], currentIds: {} })),
    create: vi.fn(), update: vi.fn(), remove: vi.fn(), apply: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  providerSwitchApi.getFailover.mockReset().mockResolvedValue({
    failover: { config: { enabled: false, autoSwitch: false }, apps: {}, suggestions: [], cooldowns: [], actions: [] },
  });
  providerSwitchApi.runFailoverEvaluation.mockReset().mockResolvedValue({ actions: [] });
});

it("renders the full provider switch page and opens the prompts tab", async () => {
  render(<MemoryRouter><ProviderSwitchPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole("tab", { name: "pswitch.prompts.tab" })).toBeTruthy());
  fireEvent.click(screen.getByRole("tab", { name: "pswitch.prompts.tab" }));
  await screen.findByText("pswitch.prompts.title");
  // the pi resources section only renders on the pi app chip
  fireEvent.click(screen.getByRole("button", { name: "pswitch.tab.pi" }));
  await screen.findByText("pswitch.pi_files.title");
});

it.each(["succeeds", "fails"])("auto failover can run again after an evaluation %s", async (outcome) => {
  providerSwitchApi.getFailover.mockResolvedValue({
    failover: {
      config: { enabled: true, autoSwitch: true },
      apps: {},
      suggestions: [{ app: "claude", id: "backup", name: "Backup" }],
      cooldowns: [],
      actions: [],
    },
  });
  let finish;
  const pending = new Promise((resolve, reject) => {
    finish = () => outcome === "succeeds" ? resolve({ actions: [] }) : reject(new Error("temporary failure"));
  });
  providerSwitchApi.runFailoverEvaluation.mockReturnValueOnce(pending);
  render(<MemoryRouter><ProviderSwitchPage /></MemoryRouter>);
  await waitFor(() => expect(providerSwitchApi.runFailoverEvaluation).toHaveBeenCalledTimes(1));

  // Focus uses the same visible-polling callback as the scheduled refresh.
  const reads = providerSwitchApi.getFailover.mock.calls.length;
  fireEvent.focus(window);
  await waitFor(() => expect(providerSwitchApi.getFailover.mock.calls.length).toBeGreaterThan(reads));
  expect(providerSwitchApi.runFailoverEvaluation).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });

  fireEvent.focus(window);
  await waitFor(() => expect(providerSwitchApi.runFailoverEvaluation).toHaveBeenCalledTimes(2));
});

it("the provider search resets when the app tab changes and matches website URLs", async () => {
  providerSwitchApi.getStatus.mockResolvedValue({
    apps: [
      { app: "claude", current: null, providers: [
        { id: "p1", name: "Alpha Relay", notes: "", websiteUrl: "https://relay.example.com", settingsConfig: { env: {} } },
      ] },
      { app: "codex", current: null, providers: [
        { id: "p2", name: "Beta Relay", notes: "", websiteUrl: "https://other.example.com", settingsConfig: {} },
      ] },
    ],
    visibleApps: {},
    storagePath: "/tmp/x",
  });
  render(<MemoryRouter><ProviderSwitchPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("pswitch.section.providers")).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: "pswitch.search.toggle_aria" }));
  const input = screen.getByLabelText("pswitch.search.aria");
  fireEvent.change(input, { target: { value: "relay.example.com" } });
  expect(screen.getByText("Alpha Relay")).toBeTruthy();
  expect(screen.queryByText("Beta Relay")).toBeNull();

  // Switching the app tab closes the panel and clears the filter (cc-switch
  // behavior): the codex list renders unfiltered with the search UI gone.
  fireEvent.click(screen.getByRole("tab", { name: "pswitch.tab.codex" }));
  await waitFor(() => expect(screen.getByText("Beta Relay")).toBeTruthy());
  expect(screen.queryByLabelText("pswitch.search.aria")).toBeNull();
});

function providerStatus(current = "a") {
  return {
    apps: [{ app: "claude", current, providers: [
      { id: "a", name: "Primary", category: "custom", settingsConfig: {} },
      { id: "b", name: "Backup", category: "custom", settingsConfig: {} },
    ] }],
    visibleApps: { claude: true }, storagePath: "/tmp/providers",
  };
}

it("shows a failed switch inside its confirmation and lets the user retry", async () => {
  providerSwitchApi.getStatus.mockResolvedValue(providerStatus());
  providerSwitchApi.switchProvider.mockRejectedValueOnce(new Error("Write denied"))
    .mockResolvedValueOnce({ wrote: ["settings.json"] });
  render(<MemoryRouter><ProviderSwitchPage /></MemoryRouter>);
  await screen.findByText("Backup");
  fireEvent.click(screen.getAllByRole("button", { name: "pswitch.action.switch" }).find(button => !button.disabled));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "pswitch.action.switch" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Write denied");
  fireEvent.click(within(dialog).getByRole("button", { name: "pswitch.action.switch" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(providerSwitchApi.switchProvider).toHaveBeenCalledTimes(2);
});

it("keeps a failed failover save and its error inside the editor", async () => {
  providerSwitchApi.getStatus.mockResolvedValue(providerStatus());
  providerSwitchApi.updateFailover.mockRejectedValue(new Error("Settings unavailable"));
  render(<MemoryRouter><ProviderSwitchPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "pswitch.failover.settings" }));
  const dialog = screen.getByRole("dialog");
  const window = within(dialog).getByLabelText("pswitch.failover.window");
  fireEvent.change(window, { target: { value: "15" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "shared.action.save" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Settings unavailable");
  expect(window).toHaveValue("15");
});

it("closes a successfully imported backup and refreshes provider status", async () => {
  providerSwitchApi.getStatus.mockResolvedValue(providerStatus());
  providerSwitchApi.importEncryptedBackup.mockResolvedValue({ restored: ["providers.json"] });
  render(<MemoryRouter><ProviderSwitchPage /></MemoryRouter>);
  await screen.findByText("Backup");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.encrypted.import" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("pswitch.encrypted.passphrase"), { target: { value: "password123" } });
  fireEvent.change(within(dialog).getByLabelText("pswitch.encrypted.file"), { target: { files: [{ text: async () => "{}" }] } });
  const submit = within(dialog).getByRole("button", { name: "pswitch.encrypted.import" });
  await waitFor(() => expect(submit).toBeEnabled());
  const reads = providerSwitchApi.getStatus.mock.calls.length;
  fireEvent.click(submit);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(providerSwitchApi.getStatus.mock.calls.length).toBeGreaterThan(reads);
  expect(screen.queryByText(/showToast is not defined/)).not.toBeInTheDocument();
});

it("refreshes the current provider after an automatic failover", async () => {
  let switched = false;
  providerSwitchApi.getStatus.mockImplementation(async () => providerStatus(switched ? "b" : "a"));
  providerSwitchApi.getFailover.mockImplementation(async () => ({ failover: {
    config: { enabled: true, autoSwitch: true }, apps: {}, cooldowns: [],
    suggestions: switched ? [] : [{ app: "claude", id: "b", name: "Backup" }],
  } }));
  providerSwitchApi.runFailoverEvaluation.mockImplementation(async () => { switched = true; return { actions: [] }; });
  render(<MemoryRouter><ProviderSwitchPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("pswitch.current_badge").parentElement).toHaveTextContent("Backup"));
  expect(providerSwitchApi.runFailoverEvaluation).toHaveBeenCalledTimes(1);
});
