"use strict";
// cc-switch coding_plan / balance, 0a41250dc03a (MIT).
const crypto = require("node:crypto");
const host = "open.volcengineapi.com";
const contentType = "application/json; charset=utf-8";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => crypto.createHmac("sha256", key).update(value).digest();
const numeric = value => value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const reset = value => { const n = numeric(value); const ms = n == null ? Date.parse(value) : n <= 0 ? NaN : n < 1e12 ? n * 1000 : n; return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
function sign({ ak, sk, region, action, now = new Date() }) {
  const query = new URLSearchParams({ Action: action, Region: region, Version: "2024-01-01" }).toString();
  const date = now.toISOString().replace(/[-:]|\.\d{3}/g, ""); const short = date.slice(0, 8); const bodyHash = hash("");
  const signed = "host;x-date;x-content-sha256;content-type";
  const headers = `host:${host}\nx-date:${date}\nx-content-sha256:${bodyHash}\ncontent-type:${contentType}\n`;
  const canonical = `POST\n/\n${query}\n${headers}\n${signed}\n${bodyHash}`;
  const scope = `${short}/${region}/ark/request`;
  const key = hmac(hmac(hmac(hmac(sk, short), region), "ark"), "request");
  const signature = hmac(key, `HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString("hex");
  return { url: `https://${host}/?${query}`, headers: { Authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signed}, Signature=${signature}`, "X-Date": date, "X-Content-Sha256": bodyHash, "content-type": contentType } };
}
async function request(url, options, fetchImpl) {
  const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
  if ([401, 403].includes(response.status)) { const error = new Error("Quota credentials were rejected"); error.code = "AUTH_EXPIRED"; throw error; }
  if (!response.ok) throw new Error(`Quota request failed (HTTP ${response.status})`);
  return response.json();
}
function parseVolc(body, action) {
  const result = body.Result || {};
  const tiers = [];
  if (action === "GetAFPUsage") {
    for (const [key, id, label] of [["AFPFiveHour", "five_hour", "5h"], ["AFPWeekly", "weekly", "Weekly"], ["AFPMonthly", "monthly", "Monthly"]]) {
      const row = result[key]; const quota = numeric(row?.Quota); const used = numeric(row?.Used);
      if (quota > 0 && used != null) tiers.push({ id, label, usedPercent: used / quota * 100, resetsAt: reset(row.ResetTime) });
    }
  } else for (const row of result.QuotaUsage || result.Usages || result.Details || []) {
    const level = String(row.Level || row.Type || row.Period || row.Label || row.Window || "").toLowerCase();
    const id = ["session", "5h", "fivehour", "five_hour", "rolling_5h"].includes(level) ? "five_hour" : ["weekly", "week", "7d"].includes(level) ? "weekly" : ["monthly", "month"].includes(level) ? "monthly" : null;
    const percent = numeric(row.Percent ?? row.UsedPercent ?? row.UsagePercent);
    if (id && percent != null) tiers.push({ id, label: level, usedPercent: percent, resetsAt: reset(row.ResetTime ?? row.ResetTimestamp) });
  }
  return tiers;
}
async function volc({ baseUrl, provider, fetchImpl = fetch }) {
  const fields = provider.meta?.quotaCredentials || {};
  if (!fields.accessKeyId || !fields.secretAccessKey) throw new Error("Configure Volcengine AccessKey ID and Secret for quota queries");
  const region = new URL(baseUrl).hostname.split(".").find(part => /^(cn|ap)-[\w-]+$/.test(part)) || "cn-beijing";
  for (const action of ["GetAFPUsage", "GetCodingPlanUsage"]) {
    const signed = sign({ ak: fields.accessKeyId, sk: fields.secretAccessKey, region, action });
    const body = await request(signed.url, { method: "POST", headers: signed.headers, body: "" }, fetchImpl);
    const error = body.ResponseMetadata?.Error || body.Error;
    if (error && /auth|signature|denied|forbidden|credential|token/i.test(error.Code || "")) { const failure = new Error("Volcengine quota credentials or permissions were rejected"); failure.code = "AUTH_EXPIRED"; throw failure; }
    if (error) continue;
    const tiers = parseVolc(body, action); if (tiers.length) return { plan: action === "GetAFPUsage" ? "Agent Plan" : "Coding Plan", tiers };
  }
  throw new Error("No Volcengine plan usage was returned");
}
function parseZhipu(body) {
  if (body.success === false) throw new Error("Zhipu quota query failed");
  const candidates = (body.data?.limits || []).filter(row => ["tokens_limit", "credit_limit"].includes(String(row.type).toLowerCase()) && numeric(row.percentage) != null);
  const selected = new Map(); const unclassified = [];
  for (const row of candidates) { const id = row.unit === 3 ? "five_hour" : row.unit === 6 ? "weekly" : null; if (id && !selected.has(id)) selected.set(id, row); else unclassified.push(row); }
  unclassified.sort((a,b) => (a.nextResetTime == null ? -Infinity : Number(a.nextResetTime)) - (b.nextResetTime == null ? -Infinity : Number(b.nextResetTime)));
  for (const row of unclassified) { if (!selected.has("five_hour")) selected.set("five_hour", row); else if (!selected.has("weekly")) selected.set("weekly", row); }
  const tiers = [...selected].map(([id,row]) => ({ id, label: id, usedPercent: Number(row.percentage), resetsAt: reset(row.nextResetTime) }));
  if (!tiers.length) throw new Error("Unrecognized Zhipu quota");
  return { plan: body.data?.level || "Coding Plan", tiers };
}
async function zhipu({ baseUrl, apiKey, fetchImpl = fetch }) {
  const cn = new URL(baseUrl).hostname.endsWith("bigmodel.cn");
  const origin = cn ? "https://open.bigmodel.cn" : "https://api.z.ai";
  const options = { headers: { Authorization: apiKey, Accept: "application/json" } };
  const body = await request(`${origin}/api/monitor/usage/quota/limit`, options, fetchImpl);
  const msg = String(body.msg || "").toLowerCase();
  if (body.success === false && msg.replace(/[\s_-]/g, "").includes("codingplan") && /不存在|没有|未开通|not exist|not found|not have|doesn't have|no coding plan|not subscribed/.test(msg)) {
    const balance = await request(`${origin}/api/biz/account/query-customer-account-report`, options, fetchImpl);
    const amount = numeric(balance.data?.availableBalance ?? balance.data?.balance);
    if (balance.success === false || amount == null) throw new Error("Unrecognized Zhipu balance");
    return { kind: "balance", balances: [{ label: cn ? "Zhipu GLM" : "Z.ai", remaining: amount, unit: cn ? "CNY" : "USD", isValid: true }] };
  }
  return parseZhipu(body);
}
module.exports = { sign, parseVolc, parseZhipu, volc, zhipu };
