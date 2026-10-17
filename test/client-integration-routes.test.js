"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Readable } = require("node:stream");
const { handleProxyApiRequest } = require("../src/lib/proxy/api");
const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
const copilot = require("../src/lib/proxy/copilot");
const codex = require("../src/lib/provider-switch/codex-client");
const config = require("../src/lib/proxy/config");
async function invoke(handler, route, authorized, body = {}) {
  const response = {};
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = "POST";
  await handler(req, {
    writeHead(status) { response.status = status; },
    end(text) { response.body = JSON.parse(text); },
  }, new URL(`http://127.0.0.1${route}`), { isAuthorizedLocalMutation: () => authorized });
  return response;
}
test("all client mutations reject unauthorized requests before reading bodies or acting", async (t) => {
  const calls = [];
  for (const method of ["connect", "restore", "models"]) t.mock.method(copilot, method, async () => calls.push(method));
  for (const method of ["restartCodexDaemon", "acknowledgeCodexClients"]) t.mock.method(codex, method, async () => calls.push(method));
  for (const suffix of ["connect", "restore", "models"]) assert.equal((await invoke(handleProxyApiRequest, `/api/proxy/copilot/${suffix}`, false)).status, 401);
  for (const suffix of ["restart", "acknowledge"]) assert.equal((await invoke(handleProviderSwitchApiRequest, `/api/provider-switch/codex-client/${suffix}`, false)).status, 401);
  assert.deepEqual(calls, []);
});
test("authorized Copilot connect requires an existing key and routes valid requests", async (t) => {
  t.mock.method(config, "readConfig", () => ({ "api-keys": ["fixture-key"] }));
  const connect = t.mock.method(copilot, "connect", async (client, body) => ({ configured: client === "cli", model: body.model }));
  const invalid = await invoke(handleProxyApiRequest, "/api/proxy/copilot/connect", true, { client: "cli", apiKey: "other", model: "model" });
  assert.equal(invalid.status, 400); assert.equal(connect.mock.callCount(), 0);
  const valid = await invoke(handleProxyApiRequest, "/api/proxy/copilot/connect", true, { client: "cli", apiKey: "fixture-key", model: "model" });
  assert.equal(valid.status, 200); assert.equal(valid.body.configured, true);
});
test("authorized Codex restart calls only the graceful daemon operation", async (t) => {
  const restart = t.mock.method(codex, "restartCodexDaemon", async () => ({ outcome: "restarted" }));
  const response = await invoke(handleProviderSwitchApiRequest, "/api/provider-switch/codex-client/restart", true);
  assert.equal(response.status, 200); assert.equal(response.body.outcome, "restarted"); assert.equal(restart.mock.callCount(), 1);
});
