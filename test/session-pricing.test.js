const assert = require("node:assert/strict");
const { test } = require("node:test");
const { priceSessionUsage } = require("../src/lib/session-pricing");

test("mixed session estimates disclose missing models while preserving inclusive cache accounting", () => {
  const models = { "gpt-5.2": { provider: "openai", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } };
  const usage = { inputInclusive: true, perModel: [
    { model: "gpt-5.2", inputTokens: 300, cacheReadTokens: 140, outputTokens: 90 },
    { model: "unknown", inputTokens: 100, outputTokens: 50 },
  ] };
  priceSessionUsage(usage, models);
  assert.equal(usage.estimatedCostUsd, (160 * 1.25 + 140 * 0.125 + 90 * 10) / 1e6);
  assert.equal(usage.pricedModels, 1);
  assert.equal(usage.totalModels, 2);
  priceSessionUsage(usage, {});
  assert.equal(usage.pricedModels, 0);
});
test("fresh-input executors do not bill Gemini reasoning twice", () => {
  const models = { "gemini-test": { provider:"google",input:1,output:10,cacheRead:.1,cacheWrite:1 } };
  const usage = { inputInclusive:false,executorType:"fresh-input-output-includes-reasoning",perModel:[{model:"gemini-test",inputTokens:80,cacheReadTokens:20,outputTokens:12,reasoningTokens:8}] };
  priceSessionUsage(usage,models);
  assert.equal(usage.estimatedCostUsd,(80+2+120)/1e6);
});
