import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBudgetAlerts, sendBudgetAlerts } from "./budget-alerts";

vi.mock("./copy", () => ({ copy: (key, params) => `${key}:${JSON.stringify(params ?? {})}` }));

const nativeNotify = vi.fn(() => true);

vi.mock("./native-bridge.js", () => ({ notifyNative: (...args) => nativeNotify(...args) }));

const NOW = new Date("2026-10-05T12:00:00.000Z").getTime();

function budget({ enabled = true, daily = null, monthly = null, alert } = {}) {
  return { budgets: { enabled }, daily, monthly, alert: alert ?? { which: null, level: "none", pct: 0 } };
}

afterEach(() => {
  window.localStorage.clear();
  nativeNotify.mockClear();
});

describe("buildBudgetAlerts", () => {
  it("emits nothing when disabled or healthy", () => {
    expect(buildBudgetAlerts(budget(), { now: NOW })).toEqual([]);
    expect(buildBudgetAlerts(budget({ enabled: false }), { now: NOW })).toEqual([]);
    expect(buildBudgetAlerts(null, { now: NOW })).toEqual([]);
  });

  it("emits warning/exceeded alerts per window", () => {
    const alerts = buildBudgetAlerts(budget({
      daily: { limitUsd: 10, spentUsd: 8.5, pct: 85, level: "warning" },
      monthly: { limitUsd: 50, spentUsd: 60, pct: 100, level: "exceeded" },
      alert: { which: "monthly", level: "exceeded", pct: 100 },
    }), { now: NOW });
    expect(alerts.map((alert) => `${alert.which}:${alert.level}`).sort()).toEqual(["daily:warning", "monthly:exceeded"]);
  });

  it("drops the daily warning once the day is exceeded", () => {
    const alerts = buildBudgetAlerts(budget({
      daily: { limitUsd: 10, spentUsd: 12, pct: 100, level: "exceeded" },
      alert: { which: "daily", level: "exceeded", pct: 100 },
    }), { now: NOW });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe("exceeded");
  });
});

describe("sendBudgetAlerts", () => {
  it("notifies once per threshold crossing and dedups afterwards", () => {
    const status = budget({
      daily: { limitUsd: 10, spentUsd: 9, pct: 90, level: "warning" },
      alert: { which: "daily", level: "warning", pct: 90 },
    });
    expect(sendBudgetAlerts(status, { now: NOW })).toBe(1);
    expect(nativeNotify).toHaveBeenCalledTimes(1);
    expect(sendBudgetAlerts(status, { now: NOW + 60_000 })).toBe(1);
    expect(nativeNotify).toHaveBeenCalledTimes(1);
  });

  it("falls back to the Web Notification when the native bridge is absent", () => {
    nativeNotify.mockReturnValue(false);
    const calls = [];
    class FakeNotification {
      constructor(title, options) { calls.push({ title, options }); }
    }
    FakeNotification.permission = "granted";
    vi.stubGlobal("Notification", FakeNotification);
    const status = budget({
      monthly: { limitUsd: 50, spentUsd: 55, pct: 100, level: "exceeded" },
      alert: { which: "monthly", level: "exceeded", pct: 100 },
    });
    expect(sendBudgetAlerts(status, { now: NOW })).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.tag).toContain("budget:monthly:exceeded:");
    vi.unstubAllGlobals();
  });
});
