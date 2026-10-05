import { notifyNative } from "./native-bridge.js";
import { copy } from "./copy";

// Budget threshold alerts for the proxy surface, mirroring limit-alerts.js:
// one notification per threshold crossing per day/month, native shell first
// with a Web Notification fallback, dedup state in localStorage.

const STORAGE_KEY = "tt.budgetAlerts.v1";

function readCycles() {
  try { return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
}

function writeCycles(value) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* restricted webview */ }
}

function dayKey(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthKey(now) {
  return dayKey(now).slice(0, 7);
}

export function buildBudgetAlerts(budget, { now = Date.now() } = {}) {
  if (!budget?.budgets?.enabled || !budget.alert || budget.alert.level === "none") return [];
  const alerts = [];
  const add = (which, window) => {
    if (!window || (window.level !== "warning" && window.level !== "exceeded")) return;
    alerts.push({
      id: `budget:${which}:${window.level}:${which === "daily" ? dayKey(now) : monthKey(now)}`,
      which,
      level: window.level,
      pct: window.pct,
      spentUsd: window.spentUsd,
      limitUsd: window.limitUsd,
    });
  };
  add("daily", budget.daily);
  add("monthly", budget.monthly);
  // When a window is exceeded, the earlier warning for the same period is
  // redundant — keep only the most severe per window.
  return alerts.filter((alert) =>
    !(alert.level === "warning" && alerts.some((other) => other.which === alert.which && other.level === "exceeded")));
}

export function sendBudgetAlerts(budget, { now = Date.now() } = {}) {
  const cycles = readCycles();
  const alerts = buildBudgetAlerts(budget, { now });
  for (const alert of alerts) {
    if (cycles[alert.id]) continue;
    const title = copy(`budget.alert.${alert.which}_title`, { pct: alert.pct });
    const body = copy(`budget.alert.${alert.which}_body`, {
      spent: alert.spentUsd.toFixed(2),
      limit: alert.limitUsd.toFixed(2),
    });
    let delivered = notifyNative({ title, body, id: alert.id });
    if (!delivered && typeof Notification !== "undefined" && Notification.permission === "granted") {
      // Some WebViews throw from the constructor even when permission is granted.
      try {
        new Notification(title, { body, tag: alert.id });
        delivered = true;
      } catch {}
    }
    if (delivered) cycles[alert.id] = now;
  }
  const cutoff = now - 35 * 86400_000;
  writeCycles(Object.fromEntries(Object.entries(cycles).filter(([, timestamp]) => Number(timestamp) >= cutoff).slice(-100)));
  return alerts.length;
}
