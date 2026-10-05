import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { ProviderQuotaLine } from "./provider-quota-line";

// Quota line display: per-window left%, visible reset countdown, and the
// Command Code credits balance. Server-side parsing is covered by
// test/provider-switch-quota.test.js.

vi.mock("../lib/copy", () => ({ copy: (key, params) => `${key}:${JSON.stringify(params ?? {})}` }));

vi.mock("../lib/provider-switch-api", () => ({
  providerSwitchApi: { getQuota: vi.fn() },
}));

const provider = { id: "p1", quotaProvider: "command_code" };

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(cleanup);

it("renders left percent, an inline reset countdown, and credits", async () => {
  providerSwitchApi.getQuota.mockResolvedValue({
    quota: {
      ok: true,
      plan: "Pro",
      tiers: [
        { id: "five_hour", used_percent: 20, reset_at: new Date(Date.now() + 2 * 3600_000).toISOString() },
        { id: "monthly", used_percent: 55, reset_at: new Date(Date.now() + 30 * 24 * 3600_000).toISOString() },
      ],
      credits: { monthly: 100, purchased: 5.5, free: 0, spent: 42 },
    },
  });
  render(<ProviderQuotaLine app="claude" provider={provider} />);
  await waitFor(() => expect(providerSwitchApi.getQuota).toHaveBeenCalledWith("claude", "p1", { nocache: false }));
  expect((await screen.findAllByText(/pswitch\.quota\.left/)).length).toBe(2);
  expect((await screen.findAllByText(/pswitch\.quota\.reset_in/)).length).toBe(2);
  const credits = screen.getByText(/pswitch\.quota\.credits:/);
  expect(credits.textContent).toContain("105.5");
});

it("hides the countdown for tiers without a reset_at and credits when empty", async () => {
  providerSwitchApi.getQuota.mockResolvedValue({
    quota: {
      ok: true,
      tiers: [{ id: "monthly", used_percent: 0, reset_at: null }],
      credits: { monthly: 0, purchased: 0, free: 0, spent: 7 },
    },
  });
  render(<ProviderQuotaLine app="claude" provider={provider} />);
  await screen.findByText(/pswitch\.quota\.left/);
  expect(screen.queryByText(/pswitch\.quota\.reset_in/)).toBeNull();
  expect(screen.queryByText(/pswitch\.quota\.credits/)).toBeNull();
});

it("shows the error state with a retry", async () => {
  providerSwitchApi.getQuota.mockResolvedValue({ quota: { ok: false, credentialStatus: "expired", error: "x" } });
  render(<ProviderQuotaLine app="claude" provider={provider} />);
  expect(await screen.findByText(/pswitch\.quota\.expired/)).toBeTruthy();
});
