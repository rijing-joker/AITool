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

for (const windows of ["active", "absent", "expired"]) {
  test(`The stale disk cache keeps the credits balance with ${windows} windows`, () => checkCachedBalance(windows));
}

async function checkCachedBalance(windows) {
  resetUsageLimitsCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-credits-balance-"));
  const realDateNow = Date.now;
  try {
    let now = Date.parse("2026-06-20T00:00:00Z");
    Date.now = () => now;
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".codex", "auth.json"), JSON.stringify({
      tokens: { access_token: jwt(), id_token: jwt() },
    }));

    const liveBody = whamBody({ has_credits: true, unlimited: false, balance: "62500" });
    if (windows === "absent") liveBody.rate_limit = {};
    if (windows === "expired") {
      for (const window of Object.values(liveBody.rate_limit)) window.reset_at = now / 1000 + 60;
    }
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
    now += 120_000;
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
    assert.equal(stale.codex.cached_at, live.codex.cached_at);
    if (windows !== "active") {
      assert.equal(stale.codex.primary_window, null);
      assert.equal(stale.codex.secondary_window, null);
    }

    // A balance alone must still obey the cache's seven-day age limit.
    now += 7 * 24 * 60 * 60 * 1000;
    resetUsageLimitsCache();
    const expired = await getUsageLimits({
      home: tmp, platform: "linux", providerTimeoutMs: 1000,
      securityRunner: inactiveRunner, commandRunner: inactiveRunner, fetchImpl,
    });
    assert.equal(expired.codex.error, "network down");
    assert.equal(expired.codex.credits_balance, undefined);
  } finally {
    Date.now = realDateNow;
    resetUsageLimitsCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("A successful empty balance read replaces the previously cached balance", async (t) => {
  resetUsageLimitsCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-credits-spent-"));
  t.after(() => {
    resetUsageLimitsCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".codex", "auth.json"), JSON.stringify({
    tokens: { access_token: jwt(), id_token: jwt() },
  }));
  const body = whamBody({ has_credits: true, unlimited: false, balance: "100" });
  // Keep the initial window usable without depending on the test date.
  for (const window of Object.values(body.rate_limit)) window.reset_at = Date.now() / 1000 + 3600;
  let failed = false;
  let status = 200;
  async function poll() {
    resetUsageLimitsCache();
    return getUsageLimits({
      home: tmp, platform: "linux", providerTimeoutMs: 1000,
      securityRunner: inactiveRunner, commandRunner: inactiveRunner,
      fetchImpl(url) {
        if (url === WHAM_URL) {
          if (failed) return Promise.reject(new Error("network down"));
          return status === 200 ? ok(body) : Promise.resolve({ ok: false, status, json: async () => ({}) });
        }
        if (url === RESET_URL) return ok(body.rate_limit_reset_credits);
        return new Promise(() => {});
      },
    });
  }
  assert.equal((await poll()).codex.credits_balance, 100);
  // A neutral no-data response is not evidence that the balance was spent.
  status = 401;
  assert.equal((await poll()).codex.credits_balance, null);
  failed = true;
  assert.equal((await poll()).codex.credits_balance, 100);
  failed = false;
  status = 200;
  body.credits = { has_credits: false, unlimited: false, balance: "0" };
  body.rate_limit = {};
  assert.equal((await poll()).codex.credits_balance, null);
  failed = true;
  const result = await poll();
  assert.equal(result.codex.error, "network down");
  assert.equal(result.codex.credits_balance, undefined);
});
