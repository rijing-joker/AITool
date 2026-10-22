"use strict";

// CLIProxyAPI /credentials/refresh can return private tokens on single
// refresh. Keep only an explicit acknowledgement and safe result fields.
function sanitize(payload) {
  if (!payload || payload.ok !== true) throw new Error("Invalid credential refresh response");
  if (!Array.isArray(payload.results)) return { ok: true };
  return { ok: true, results: payload.results.map(row => {
    if (!row || typeof row.id !== "string" || !row.id.trim() || typeof row.success !== "boolean") {
      throw new Error("Invalid credential refresh result");
    }
    // The raw error may echo an upstream response containing private data.
    return { id: row.id, success: row.success, ...(!row.success ? { error: "Credential refresh failed" } : {}) };
  }) };
}
function sanitizeQuota(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid plugin quota response");
  const pick = (row, fields) => Object.fromEntries(fields.filter(key => typeof row?.[key] === "string" || (typeof row?.[key] === "number" && Number.isFinite(row[key]))).map(key => [key,row[key]]));
  if (payload.groups !== undefined && !Array.isArray(payload.groups)) throw new Error("Invalid plugin quota response");
  return {
    groups: (payload.groups || []).slice(0,100).map(group => ({ ...pick(group,["displayName","display_name"]), buckets:(Array.isArray(group?.buckets)?group.buckets:[]).slice(0,100).map(bucket=>pick(bucket,["bucketId","bucket_id","window","description","remainingFraction","remaining_fraction","resetTime","reset_time"])) })),
    summary: (Array.isArray(payload.summary)?payload.summary:[]).slice(0,100).map(row=>pick(row,["label","key","value","format","currency","unit"])),
    ...(payload.subscription ? {subscription:pick(payload.subscription,["plan","tierName","tier_name"])} : {}),
    ...pick(payload,["serverTimeOffsetMs","server_time_offset_ms"]),
  };
}
module.exports = { sanitize, sanitizeQuota };
