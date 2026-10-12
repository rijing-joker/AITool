const assert = require("node:assert/strict");
const { test } = require("node:test");
const http = require("node:http");
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

for (const proxyUrl of ["direct", "none"]) {
  test(`explicit ${proxyUrl} routing bypasses the global proxy`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("must use a direct dispatcher"); });
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const result = await probe({
      url: `http://127.0.0.1:${server.address().port}`, protocol: "openai-chat", data: "{}", proxyUrl,
    });
    assert.ok(result.firstTokenLatencyMs > 0);
  });
}
