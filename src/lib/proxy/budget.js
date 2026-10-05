// Budget + burn-rate monitoring over the proxy's request records. Pure
// computation: the caller supplies rows (normalized usage records), a
// costOf(row) callback (models.dev pricing estimation) and the budgets
// config persisted in settings.json. Failure/canceled requests carry no
// cost and are excluded, matching the Requests tab's cost column.

const DEFAULTS = { enabled: false, monthlyLimitUsd: 0, dailyLimitUsd: 0, alertThresholdPct: 80 };

function normalizeBudgets(value) {
  const source = value && typeof value === "object" ? value : {};
  const number = (input, fallback = 0) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    enabled: source.enabled === true,
    monthlyLimitUsd: number(source.monthlyLimitUsd),
    dailyLimitUsd: number(source.dailyLimitUsd),
    alertThresholdPct: Math.min(100, Math.max(1, number(source.alertThresholdPct, DEFAULTS.alertThresholdPct))),
  };
}

const round = (value) => Math.round(value * 10000) / 10000;

function dayStartMs(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function monthStartMs(now) {
  const date = new Date(now);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function daysInMonth(now) {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function windowStatus(limitUsd, spentUsd, thresholdPct) {
  if (!(limitUsd > 0)) return null;
  const pct = Math.min(100, Math.round((spentUsd / limitUsd) * 100));
  const level = spentUsd >= limitUsd ? "exceeded" : pct >= thresholdPct ? "warning" : "ok";
  return { limitUsd, spentUsd, pct, level };
}

// Computes spend windows, burn rate and the alert level. `costOf` returns
// USD for a successful row or null when pricing is unavailable; rows with
// unknown cost are skipped (never guessed).
function computeBudgetStatus({ budgets, rows, costOf, now = Date.now() }) {
  const config = normalizeBudgets(budgets);
  const dayStart = dayStartMs(now);
  const monthStart = monthStartMs(now);
  const hourAgo = now - 3600_000;
  let todayUsd = 0;
  let monthUsd = 0;
  let lastHourUsd = 0;
  for (const row of rows || []) {
    if (!row || row.failed || row.canceled) continue;
    const ts = Date.parse(row.timestamp || "");
    if (!Number.isFinite(ts) || ts < monthStart) continue;
    const cost = costOf ? costOf(row) : null;
    if (cost == null) continue;
    monthUsd += cost;
    if (ts >= dayStart) todayUsd += cost;
    if (ts >= hourAgo) lastHourUsd += cost;
  }

  const daily = windowStatus(config.dailyLimitUsd, todayUsd, config.alertThresholdPct);
  const monthly = windowStatus(config.monthlyLimitUsd, monthUsd, config.alertThresholdPct);
  const candidates = [
    daily && { which: "daily", level: daily.level, pct: daily.pct },
    monthly && { which: "monthly", level: monthly.level, pct: monthly.pct },
  ].filter(Boolean).filter((entry) => entry.level === "warning" || entry.level === "exceeded");
  const rank = { exceeded: 2, warning: 1, ok: 0 };
  const alert = candidates.sort((a, b) => rank[b.level] - rank[a.level])[0]
    || { which: null, level: "none", pct: 0 };

  const elapsedDayHours = Math.max(1 / 60, (now - dayStart) / 3600_000);
  const elapsedMonthDays = Math.max(1 / 24, (now - monthStart) / 86400_000);
  return {
    budgets: config,
    todayUsd: round(todayUsd),
    monthUsd: round(monthUsd),
    daily,
    monthly,
    burn: {
      lastHourUsd: round(lastHourUsd),
      projectedTodayUsd: round((todayUsd / elapsedDayHours) * 24),
      projectedMonthUsd: round((monthUsd / elapsedMonthDays) * daysInMonth(now)),
    },
    alert,
  };
}

module.exports = { normalizeBudgets, computeBudgetStatus, DEFAULTS };
