const assert = require("node:assert/strict");
const { test } = require("node:test");
const { probe } = require("../src/lib/proxy/provider-health");

// Proxied probes must fetch through undici (whose per-request dispatcher the
// ProxyAgent path depends on), never through the global fetch — the global
// fetch rejects npm-undici dispatchers on current runtimes.

test("proxied probes fetch through undici, not the global fetch", async (t) => {
  let globalFetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => {
    globalFetchCalled = true;
    throw new Error("global fetch must not carry a dispatcher");
  });
  // Nothing listens on the discard port, so the probe fails inside the
  // proxy path; the failure must never be routed via the global fetch.
  await assert.rejects(
    probe({ url: "https://example.test", protocol: "openai-chat", data: "{}", timeoutMs: 2_000, proxyUrl: "http://127.0.0.1:9" }),
    /Health check request failed/,
  );
  assert.equal(globalFetchCalled, false);
});
