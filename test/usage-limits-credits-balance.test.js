const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getUsageLimits, resetUsageLimitsCache } = require("../src/lib/usage-limits");

const WHAM_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

function jwt(planType = "plus") {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_plan_type: planType },
  })).toString("base64url");
  return `header.${payload}.sig`;
}

function inactiveRunner() {
  return { status: 1, stdout: "" };
}

function ok(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

function whamBody(credits = null) {
  return {
    rate_limit: {
      // reset_at is epoch seconds and must lie in the future for the disk-cache
      // reader (isCodexCacheWindowUsable) to accept the window back on the
      // stale path. 2026-06-21T00:00:00Z against the fake Date.now below.
      primary_window: { used_percent: 11, limit_window_seconds: 18000, reset_at: 1_782_086_400 },
      secondary_window: { used_percent: 22, limit_window_seconds: 604800, reset_at: 1_782_691_200 },
    },
    rate_limit_reset_credits: { available_count: 0, total_earned_count: 0, credits: [] },
    credits,
  };
}

async function withCodexLimits({
  wham = whamBody(),
  whamResponder = () => ok(wham),
  resetResponder = () => ok(wham.rate_limit_reset_credits),
  tokens = { access_token: jwt(), id_token: jwt() },
} = {}) {
  resetUsageLimitsCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-credits-balance-"));
  const realDateNow = Date.now;
  try {
    Date.now = () => Date.parse("2026-06-20T00:00:00Z");
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".codex", "auth.json"), JSON.stringify({ tokens }));
    return await getUsageLimits({
      home: tmp,
      platform: "linux",
      providerTimeoutMs: 1000,
      securityRunner: inactiveRunner,
      commandRunner: inactiveRunner,
      fetchImpl(url) {
        if (url === WHAM_URL) return whamResponder(url);
        if (url === RESET_URL) return resetResponder(url);
        return new Promise(() => {});
      },
    });
  } finally {
    Date.now = realDateNow;
    resetUsageLimitsCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("Codex credits balance parses the string balance from wham/usage", async () => {
  const result = await withCodexLimits({
    wham: whamBody({ has_credits: true, unlimited: false, balance: "62500" }),
  });
  assert.equal(result.codex.error, null);
  assert.equal(result.codex.credits_balance, 62500);
});

test("Codex credits balance accepts a numeric balance too", async () => {
  const result = await withCodexLimits({
    wham: whamBody({ has_credits: true, unlimited: false, balance: 123.5 }),
  });
  assert.equal(result.codex.credits_balance, 123.5);
});

test("Codex credits balance is dropped for unlimited, non-credited, zero and malformed payloads", async () => {
  for (const credits of [
    { has_credits: true, unlimited: true, balance: "62500" },
    { has_credits: false, unlimited: false, balance: "62500" },
    { has_credits: true, unlimited: false, balance: "0" },
    { has_credits: true, unlimited: false, balance: "many" },
    { has_credits: true, unlimited: false },
    "not-an-object",
    null,
  ]) {
    const result = await withCodexLimits({ wham: whamBody(credits) });
    assert.equal(result.codex.credits_balance, null, JSON.stringify(credits));
  }
});

test("A missing credits block leaves the balance null without failing the usage read", async () => {
  const result = await withCodexLimits({ wham: whamBody() });
  assert.equal(result.codex.error, null);
  assert.equal(result.codex.credits_balance, null);
});

test("The stale disk cache keeps the credits balance from the last successful read", async () => {
  resetUsageLimitsCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-credits-balance-"));
  const realDateNow = Date.now;
  try {
    Date.now = () => Date.parse("2026-06-20T00:00:00Z");
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".codex", "auth.json"), JSON.stringify({
      tokens: { access_token: jwt(), id_token: jwt() },
    }));

    const liveBody = whamBody({ has_credits: true, unlimited: false, balance: "62500" });
    let liveSucceeded = false;
    const fetchImpl = (url) => {
      if (url === WHAM_URL) {
        if (liveSucceeded) return Promise.reject(new Error("network down"));
        liveSucceeded = true;
        return ok(liveBody);
      }
      if (url === RESET_URL) return ok(liveBody.rate_limit_reset_credits);
      return new Promise(() => {});
    };

    const live = await getUsageLimits({
      home: tmp,
      platform: "linux",
      providerTimeoutMs: 1000,
      securityRunner: inactiveRunner,
      commandRunner: inactiveRunner,
      fetchImpl,
    });
    assert.equal(live.codex.credits_balance, 62500);

    // Second poll: the live fetch fails and the stale disk cache answers.
    resetUsageLimitsCache();
    const stale = await getUsageLimits({
      home: tmp,
      platform: "linux",
      providerTimeoutMs: 1000,
      securityRunner: inactiveRunner,
      commandRunner: inactiveRunner,
      fetchImpl,
    });
    assert.equal(stale.codex.stale, true);
    assert.equal(stale.codex.credits_balance, 62500);
  } finally {
    Date.now = realDateNow;
    resetUsageLimitsCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
