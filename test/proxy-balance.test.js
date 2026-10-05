"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { checkBalance } = require("../src/lib/proxy/balance");

function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const route = routes.find(([pattern]) => String(url).startsWith(pattern));
    if (!route) throw new Error(`unexpected url ${url}`);
    const [, respond] = route;
    return respond();
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

describe("proxy balance.checkBalance", () => {
  it("reads subscription + usage and computes the remaining balance", async () => {
    const fetchImpl = stubFetch([
      ["https://relay.example.com/dashboard/billing/subscription?", () => Promise.reject(new Error("no"))],
      ["https://relay.example.com/dashboard/billing/subscription", () =>
        Promise.resolve(jsonResponse({ hard_limit_usd: 50, system_hard_limit_usd: 100 }))],
      ["https://relay.example.com/dashboard/billing/usage?", () =>
        Promise.resolve(jsonResponse({ total_usage: 1234 }))],
    ]);
    const result = await checkBalance({ baseUrl: "https://relay.example.com/v1", apiKey: "sk-x", fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.totalUsd, 50);
    assert.equal(result.usedUsd, 12.34);
    assert.ok(Math.abs(result.remainingUsd - 37.66) < 1e-9);
    assert.ok(result.endpoint.startsWith("https://relay.example.com/dashboard/billing/subscription"));
    // the non-/v1 root is tried first, the /v1 root second
    assert.equal(fetchImpl.calls.filter((url) => url.includes("subscription")).length, 1);
  });

  it("falls back to system_hard_limit_usd and tolerates a failing usage call", async () => {
    const fetchImpl = stubFetch([
      ["https://api.example.com/dashboard/billing/subscription", () =>
        Promise.resolve(jsonResponse({ system_hard_limit_usd: 20 }))],
      ["https://api.example.com/dashboard/billing/usage?", () => Promise.reject(new Error("boom"))],
    ]);
    const result = await checkBalance({ baseUrl: "https://api.example.com", apiKey: "sk-x", fetchImpl });
    assert.deepEqual(result, {
      ok: true,
      totalUsd: 20,
      endpoint: "https://api.example.com/dashboard/billing/subscription",
    });
  });

  it("reports failure when no root answers with a subscription payload", async () => {
    const fetchImpl = stubFetch([
      ["https://api.example.com/dashboard/billing/subscription", () =>
        Promise.resolve(jsonResponse({ error: { message: "not found" } }, 404))],
      ["https://api.example.com/v1/dashboard/billing/subscription", () =>
        Promise.resolve(jsonResponse({ error: { message: "not found" } }, 404))],
    ]);
    const result = await checkBalance({ baseUrl: "https://api.example.com", apiKey: "sk-x", fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 404/);
  });

  it("rejects missing keys and non-HTTP protocols", async () => {
    const fetchImpl = stubFetch([]);
    assert.equal((await checkBalance({ baseUrl: "https://x.example.com", apiKey: " ", fetchImpl })).error,
      "missing-direct-key");
    assert.match((await checkBalance({ baseUrl: "ftp://x.example.com", apiKey: "k", fetchImpl })).error,
      /only HTTP or HTTPS/);
    assert.match((await checkBalance({ baseUrl: "not a url", apiKey: "k", fetchImpl })).error,
      /Invalid balance check URL/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("treats a subscription without any limit field as unsupported", async () => {
    const fetchImpl = stubFetch([
      ["https://api.example.com/dashboard/billing/subscription", () =>
        Promise.resolve(jsonResponse({ object: "billing_subscription" }))],
      ["https://api.example.com/v1/dashboard/billing/subscription", () =>
        Promise.resolve(jsonResponse({ object: "billing_subscription" }))],
    ]);
    const result = await checkBalance({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.error, /hard_limit_usd/);
  });
});
