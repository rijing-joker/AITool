import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderSwitchSection } from "./ProviderSwitchSection.jsx";

const statusMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/provider-switch-api", () => ({
  providerSwitchApi: {
    getStatus: statusMock,
    updateVisibleApps: updateMock,
  },
}));

vi.mock("../../lib/copy", () => ({
  copy: (key) => LABELS[key] || key,
}));

const LABELS = {
  "settings.pswitch.visibility.title": "Visible agent tabs",
  "settings.pswitch.visibility.description": "Toggle which agents offer provider presets",
  "settings.pswitch.open.title": "Provider presets",
  "settings.pswitch.open.hint": "Add, switch or import provider presets",
  "settings.pswitch.open.action": "Open provider configs",
  "pswitch.error.load": "Failed to load provider switch status",
  "pswitch.tab.claude": "Claude Code",
  "pswitch.tab.codex": "Codex CLI",
  "pswitch.tab.gemini": "Gemini CLI",
  "pswitch.tab.opencode": "OpenCode",
  "pswitch.tab.openclaw": "OpenClaw",
  "pswitch.tab.mcode": "MiniMax Code",
  "pswitch.tab.hermes": "Hermes",
  "pswitch.tab.pi": "Pi",
  "pswitch.tab.grokbuild": "Grok Build",
};

const ALL_VISIBLE = {
  claude: true,
  codex: true,
  gemini: true,
  opencode: true,
  openclaw: true,
  mcode: true,
  hermes: true,
  pi: true,
  grokbuild: true,
};

function renderSection() {
  return render(
    <MemoryRouter>
      <ProviderSwitchSection />
    </MemoryRouter>,
  );
}

describe("ProviderSwitchSection", () => {
  beforeEach(() => {
    statusMock.mockReset();
    updateMock.mockReset();
    updateMock.mockImplementation((visibleApps) => Promise.resolve({ ok: true, visibleApps }));
  });

  it("renders every agent tab from the status visible-apps map", async () => {
    statusMock.mockResolvedValue({ visibleApps: { ...ALL_VISIBLE, opencode: false } });
    renderSection();
    await waitFor(() => expect(screen.getByRole("button", { name: "OpenCode" })).toHaveAttribute("aria-pressed", "false"));
    expect(screen.getByRole("button", { name: "Claude Code" })).toHaveAttribute("aria-pressed", "true");
  });

  it("persists a toggle through the settings endpoint", async () => {
    statusMock.mockResolvedValue({ visibleApps: { ...ALL_VISIBLE } });
    renderSection();
    await waitFor(() => expect(screen.getByRole("button", { name: "OpenCode" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({ ...ALL_VISIBLE, opencode: false }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "OpenCode" })).toHaveAttribute("aria-pressed", "false"));
  });

  it("keeps the last visible tab disabled", async () => {
    statusMock.mockResolvedValue({
      visibleApps: { ...ALL_VISIBLE, claude: false, codex: false, gemini: false, openclaw: false, mcode: false, hermes: false, pi: false, grokbuild: false },
    });
    renderSection();
    const lastTab = await screen.findByRole("button", { name: "OpenCode" });
    expect(lastTab).toBeDisabled();
    const hiddenTab = screen.getByRole("button", { name: "Claude Code" });
    expect(hiddenTab).toBeEnabled();
  });

  it("surfaces load errors", async () => {
    statusMock.mockRejectedValue(new Error("offline"));
    renderSection();
    await screen.findByText(/offline/);
  });
});
