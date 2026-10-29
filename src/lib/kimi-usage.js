"use strict";

// One interpretation for official accounts, API-key plans and the Limits page.
// Monthly code usage is part of the total month, never another allowance.
function reset(value) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function oldTier(data, id, label) {
  if (!data || typeof data !== "object") return null;
  const limit = Number(data.limit), remaining = Number(data.remaining);
  if (data.limit == null || data.remaining == null || !Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0 || remaining < 0) return null;
  return { id, label, usedPercent: limit > 0 ? Math.min(100, Math.max(0, (limit - remaining) / limit * 100)) : 0, resetsAt: reset(data.resetTime) };
}
function parseKimiTiers(body) {
  const tiers = new Map();
  for (const item of Array.isArray(body?.limits) ? body.limits : []) {
    const tier = oldTier(item?.detail, "five_hour", "5h");
    if (tier) tiers.set(tier.id, tier);
  }
  const weekly = oldTier(body?.usage, "weekly_limit", "weekly");
  if (weekly) tiers.set(weekly.id, weekly);
  for (const [key, id, label] of [["limit_5h", "five_hour", "5h"], ["limit_7d", "weekly_limit", "weekly"], ["limit_month_total", "monthly_limit", "Month"]]) {
    const value = body?.usages?.[key];
    if (!value || typeof value.used_ratio !== "number" || !Number.isFinite(value.used_ratio) || value.used_ratio < 0) continue;
    tiers.set(id, { id, label, usedPercent: Math.min(100, value.used_ratio * 100), resetsAt: reset(value.reset_time) });
  }
  return [...tiers.values()];
}
module.exports = { parseKimiTiers };
