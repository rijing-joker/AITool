import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copy, setCopyLocale } from "../../../lib/copy";
import { EN_LOCALE, JA_LOCALE } from "../../../lib/locale";
import { UsageLimitsPanel } from "./UsageLimitsPanel.jsx";
import { buildCreditsBalanceLine } from "./usage-limits-credits-balance.js";

const CODEX_WINDOWS = {
  primary_window: { used_percent: 12, reset_at: 1_800_000_000, limit_window_seconds: 18000 },
  secondary_window: { used_percent: 30, reset_at: 1_800_604_800, limit_window_seconds: 604800 },
};

function usageLimitsPanelElement(codex) {
  return createElement(UsageLimitsPanel, {
    codex: { configured: true, error: null, ...CODEX_WINDOWS, ...codex },
    order: ["codex"],
  });
}

let getContextSpy;

beforeEach(() => {
  getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (text) => ({ width: String(text).length * 6 }),
  });
});

afterEach(() => {
  getContextSpy?.mockRestore();
  setCopyLocale(EN_LOCALE);
});

describe("buildCreditsBalanceLine", () => {
  it("formats the balance as credits plus whole dollars at the $0.04 rate", () => {
    const line = buildCreditsBalanceLine(62500);
    expect(line).toMatchObject({ count: "62,500", usd: "$2500" });
    expect(line.text).toBe(copy("limits.codex_credits_balance.line", { count: "62,500", usd: "$2500" }));
  });

  it("renders sub-dollar balances as <$1", () => {
    // 10 credits × $0.04 = $0.40 → rounds below the $1 floor.
    expect(buildCreditsBalanceLine(10)).toMatchObject({ usd: "<$1" });
    // 25 credits × $0.04 = $1.00 → exactly one dollar.
    expect(buildCreditsBalanceLine(25)).toMatchObject({ usd: "$1" });
  });

  it("returns null for null, malformed, zero and negative balances", () => {
    expect(buildCreditsBalanceLine(null)).toBeNull();
    expect(buildCreditsBalanceLine(undefined)).toBeNull();
    expect(buildCreditsBalanceLine("62500")).toBeNull();
    expect(buildCreditsBalanceLine(0)).toBeNull();
    expect(buildCreditsBalanceLine(-5)).toBeNull();
    expect(buildCreditsBalanceLine(Number.NaN)).toBeNull();
  });
});

describe("UsageLimitsPanel Codex credits balance", () => {
  it("renders the balance line inside the Codex group after the windows", () => {
    render(usageLimitsPanelElement({ credits_balance: 62500 }));

    const codexGroup = within(screen.getByText("Codex").closest("[role='button']"));
    expect(
      codexGroup.getByText(copy("limits.codex_credits_balance.line", { count: "62,500", usd: "$2500" })),
    ).toBeInTheDocument();
  });

  it("localizes the line for Japanese users", () => {
    setCopyLocale(JA_LOCALE);
    render(usageLimitsPanelElement({ credits_balance: 62500 }));

    const codexGroup = within(screen.getByText("Codex").closest("[role='button']"));
    expect(codexGroup.queryByText(/Codex Credits balance/)).not.toBeInTheDocument();
    expect(codexGroup.getByText(copy("limits.codex_credits_balance.line", { count: "62,500", usd: "$2500" }))).toBeInTheDocument();
  });

  it("renders nothing for a missing or zero balance", () => {
    const { rerender } = render(usageLimitsPanelElement({}));
    const codexGroup = within(screen.getByText("Codex").closest("[role='button']"));
    expect(codexGroup.queryByText(/Codex Credits/)).not.toBeInTheDocument();

    rerender(usageLimitsPanelElement({ credits_balance: 0 }));
    expect(screen.queryByText(/Codex Credits/)).not.toBeInTheDocument();
  });

  it("still renders the balance when the reset bank is absent and windows exist", () => {
    render(usageLimitsPanelElement({ credits_balance: 100, reset_credits: null }));

    const codexGroup = within(screen.getByText("Codex").closest("[role='button']"));
    expect(codexGroup.queryByText(copy("limits.codex_reset_bank.title"))).not.toBeInTheDocument();
    expect(codexGroup.getByText(copy("limits.codex_credits_balance.line", { count: "100", usd: "$4" }))).toBeInTheDocument();
  });
});
