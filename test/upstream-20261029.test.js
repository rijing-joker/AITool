"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { parseQoderNewIncremental } = require("../src/lib/rollout");
const { parseKimiTiers } = require("../src/lib/kimi-usage");

test("Qoder free activity, subagents, malformed dates and rewrite enrichment survive two syncs", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-upstream-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, "main.jsonl"), sub = path.join(dir, "subagents", "child.jsonl"), queuePath = path.join(dir, "queue.jsonl");
  const row = (id, usage, timestamp = "2026-10-29T03:00:00Z") => ({ type: "assistant", timestamp, sessionId: "a", message: { id, role: "assistant", model: "free", usage } });
  const write = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n")); };
  write(main, [row("free", { billable: false, credits: 0, original_credits: 1 }), row("bad", { input_tokens: 10 }, 1e20)]);
  write(sub, [row("empty", { credits: 1 }), row("tokens", { input_tokens: 120 })]);
  const cursors = {}, args = { sessionFiles: [main, sub], cursors, queuePath };
  await parseQoderNewIncremental(args);
  let rows = fs.readFileSync(queuePath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).conversation_count, 1);
  assert.equal(rows.at(-1).total_tokens, 120);
  assert.equal((await parseQoderNewIncremental(args)).bucketsQueued, 0);
  write(sub, [row("empty", { input_tokens: 30 }), row("tokens", { input_tokens: 120 })]);
  await parseQoderNewIncremental(args);
  rows = fs.readFileSync(queuePath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).total_tokens, 150);
  assert.equal(rows.at(-1).conversation_count, 1);
  assert.equal((await parseQoderNewIncremental(args)).bucketsQueued, 0);
});

test("Kimi ratios override old windows and monthly code is not a second allowance", () => {
  const tiers = parseKimiTiers({ limits: [{ detail: { limit: 100, remaining: 90 } }], usages: {
    limit_5h: { used_ratio: 0.4372, reset_time: "2026-10-30T00:00:00Z" },
    limit_7d: { used_ratio: 0 }, limit_month_total: { used_ratio: 0.7 }, limit_month_code: { used_ratio: 0.9 },
  } });
  assert.deepEqual(tiers.map(row => row.id), ["five_hour", "weekly_limit", "monthly_limit"]);
  assert.equal(tiers[0].usedPercent, 43.72);
  assert.equal(tiers[1].usedPercent, 0);
  assert.equal(tiers[2].usedPercent, 70);
  assert.deepEqual(parseKimiTiers({ usages: { limit_5h: { used_ratio: "bad" } } }), []);
});

test("Qoder 0.4 main log is found beyond the last chunk and in its bundle directory", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-qoder-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".config", "com.qoder.app.stable", "logs", "main.log");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const usage = { userType: "pro", userQuota: { used: 3, total: 10, remaining: 7, percentage: 30, unit: "credits" } };
  fs.writeFileSync(file, `[${new Date().toISOString()}] ${JSON.stringify({ qoderUsage: usage })}\n` + "noise\n".repeat(150000));
  const result = require("../src/lib/qoder-limits").readQoderLocalQuota({ home: dir, platform: "linux", env: {} });
  assert.equal(result.primary_window.used_credits, 3);
  assert.equal(result.source, "local-log");
});

test("Kimi UTC reset windows retain cross-day offsets and reject invalid dates", () => {
  const tiers = parseKimiTiers({ usages: { limit_5h: { used_ratio: 0.1, reset_time: "2026-10-30T01:30:00+08:00" }, limit_month_total: { used_ratio: 0, reset_time: "not-a-date" } } });
  assert.equal(tiers[0].resetsAt, "2026-10-29T17:30:00.000Z"); assert.equal(tiers[1].resetsAt, null);
});

test("TRAE CN discovers classic storage and does not skip unreadable preferred storage", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-trae-classic-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const api = require("../src/lib/trae-cn-config"), base = path.join(dir, "Library", "Application Support"), classic = path.join(base, "Trae CN", "User", "globalStorage", "storage.json");
  fs.mkdirSync(path.dirname(classic), { recursive: true }); fs.writeFileSync(classic, "{}");
  const options = { home: dir, env: {}, platform: "darwin" };
  assert.equal(api.resolveTraeCnStoragePath(options), classic);
  assert.equal(api.resolveTraeCnHome(options), path.join(base, "Trae CN"));
  const preferred = path.join(base, "TRAE SOLO CN", "User", "globalStorage", "storage.json"); fs.mkdirSync(preferred, { recursive: true });
  assert.equal(api.resolveTraeCnStoragePath(options), preferred);
  assert.throws(() => api.readTraeCnAuthFromStorage(options), error => error.code === "TRAE_CN_STORAGE_UNREADABLE");
});

test("Terra estimates are identical in all five optional cloud mirrors", () => {
  const curated = require("../src/lib/pricing/curated-overrides.json");
  assert.ok(JSON.stringify(curated).includes("gpt-6.1-terra"));
  const expected = '"gpt-6.1-terra": { input: 1, output: 5, cache_read: 0.05, cache_write: 1.25 }';
  for (const name of ["account-summary", "account-daily", "account-model-breakdown", "leaderboard-profile", "leaderboard-refresh"]) {
    assert.ok(fs.readFileSync(path.join(__dirname, `../dashboard/edge-patches/tokentracker-${name}.ts`), "utf8").includes(expected), name);
  }
});

test("reviewed Zen context floor applies to its specific model and preserves larger verified limits", () => {
  const { selectModels } = require("../src/lib/proxy/opencode-free/catalog");
  const ids = ["deepseek-v4.1-flash-free", "big-pickle"], live = { data: ids.map(id => ({ id })) };
  const metadata = { opencode: { npm: "@ai-sdk/openai-compatible", models: Object.fromEntries(ids.map(id => [id, { id, cost: { input: 0, output: 0 }, modalities: { output: ["text"] }, tool_call: true, limit: { context: 100000 } }])) } };
  assert.equal(selectModels(live, metadata).find(row => row.id === ids[0]).contextWindow, 258624);
  assert.equal(selectModels(live, metadata).find(row => row.id === ids[1]).contextWindow, 100000);
  metadata.opencode.models[ids[0]].limit.context = 300000;
  assert.equal(selectModels(live, metadata).find(row => row.id === ids[0]).contextWindow, 300000);
});
