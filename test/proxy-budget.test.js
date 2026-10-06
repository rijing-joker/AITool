"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { normalizeBudgets, computeBudgetStatus } = require("../src/lib/proxy/budget");

const NOW = new Date("2026-10-05T14:00:00.000Z").getTime();
const HOUR = 3600_000;

function row(hoursAgo, cost, extras = {}) {
  return {
    timestamp: new Date(NOW - hoursAgo * HOUR).toISOString(),
    model: "gpt-x",
    failed: false,
    canceled: false,
    ...extras,
  };
}

const costOf = () => 1;

describe("proxy budget.normalizeBudgets", () => {
  it("defaults to disabled, zero limits and an 80% threshold", () => {
    assert.deepEqual(normalizeBudgets(undefined), {
      enabled: false, monthlyLimitUsd: 0, dailyLimitUsd: 0, alertThresholdPct: 80,
    });
  });

  it("clamps negative limits and out-of-range thresholds", () => {
    const budgets = normalizeBudgets({ enabled: "yes", monthlyLimitUsd: -5, dailyLimitUsd: 3, alertThresholdPct: 400 });
    assert.equal(budgets.enabled, false);
    assert.equal(budgets.monthlyLimitUsd, 0);
    assert.equal(budgets.dailyLimitUsd, 3);
    assert.equal(budgets.alertThresholdPct, 100);
  });
});

describe("proxy budget.computeBudgetStatus", () => {
  const rows = [
    row(0.2), // last hour + today + month
    row(2), // today + month
    row(3, 1, { failed: true }), // failures carry no cost
    row(24 * 3), // earlier this month only
    row(24 * 40), // last month — outside every window
    row(1, 1, { canceled: true }), // canceled rows carry no cost
  ];

  it("sums today, month and the burn-rate window, skipping failures", () => {
    const status = computeBudgetStatus({
      budgets: { enabled: true, dailyLimitUsd: 10, monthlyLimitUsd: 100, alertThresholdPct: 80 },
      rows,
      costOf,
      now: NOW,
    });
    assert.equal(status.todayUsd, 2);
    assert.equal(status.monthUsd, 3);
    assert.equal(status.burn.lastHourUsd, 1);
    assert.equal(status.daily.level, "ok");
    assert.equal(status.monthly.level, "ok");
    assert.deepEqual(status.alert, { which: null, level: "none", pct: 0 });
  });

  it("flags warning at the threshold and exceeded past the limit", () => {
    const base = { rows: [row(0.5), row(0.6), row(0.7)], costOf, now: NOW };
    const warning = computeBudgetStatus({
      ...base,
      budgets: { enabled: true, dailyLimitUsd: 4, alertThresholdPct: 70 },
    });
    assert.equal(warning.daily.level, "warning");
    assert.equal(warning.alert.level, "warning");
    assert.equal(warning.alert.which, "daily");

    const exceeded = computeBudgetStatus({
      ...base,
      budgets: { enabled: true, dailyLimitUsd: 2, alertThresholdPct: 70 },
    });
    assert.equal(exceeded.daily.level, "exceeded");
    assert.equal(exceeded.alert.which, "daily");
  });

  it("prefers the most severe window and reports no windows without limits", () => {
    const none = computeBudgetStatus({ budgets: { enabled: true }, rows: [row(0.1)], costOf, now: NOW });
    assert.equal(none.daily, null);
    assert.equal(none.monthly, null);
    assert.equal(none.alert.level, "none");

    const both = computeBudgetStatus({
      budgets: { enabled: true, dailyLimitUsd: 100, monthlyLimitUsd: 1, alertThresholdPct: 10 },
      rows: [row(0.1)],
      costOf,
      now: NOW,
    });
    assert.equal(both.daily.level, "ok");
    assert.equal(both.monthly.level, "exceeded");
    assert.equal(both.alert.which, "monthly");
  });

  it("skips rows whose cost is unknown (pricing missing)", () => {
    const status = computeBudgetStatus({
      budgets: { enabled: true, dailyLimitUsd: 10 },
      rows: [row(0.1)],
      costOf: () => null,
      now: NOW,
    });
    assert.equal(status.todayUsd, 0);
    assert.equal(status.daily.spentUsd, 0);
  });

  it("projects spend from the burn rate", () => {
    const status = computeBudgetStatus({
      budgets: { enabled: true },
      rows: [row(0.2), row(0.4)],
      costOf,
      now: NOW,
    });
    // 2 USD in the last hour; the day elapsed in the machine's local timezone
    const dayStart = new Date(NOW);
    dayStart.setHours(0, 0, 0, 0);
    const elapsedHours = (NOW - dayStart.getTime()) / HOUR;
    assert.equal(status.burn.lastHourUsd, 2);
    assert.ok(Math.abs(status.burn.projectedTodayUsd - (2 / elapsedHours) * 24) < 0.01);
  });
});
