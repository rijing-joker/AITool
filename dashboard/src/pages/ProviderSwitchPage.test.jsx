import React from "react";
import { MemoryRouter } from "react-router";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
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
