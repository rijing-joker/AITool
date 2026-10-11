const assert = require("node:assert/strict");
const { test } = require("node:test");
const { handleProxyApiRequest } = require("../src/lib/proxy/api");
const bridge = require("../src/lib/proxy/usage-bridge");
const manager = require("../src/lib/proxy/manager");

// The restart route stops the usage bridge first; a failed core restart
// (install error, startup timeout, port dispute) must still bring the
// bridge back — the same recovery contract the install flow follows.

async function postRestart() {
  const response = { status: null, body: null };
  await handleProxyApiRequest({ method: "POST" }, {
    writeHead(status) { response.status = status; },
    end(body) { response.body = JSON.parse(body); },
  }, new URL("http://localhost/api/proxy/restart"), { isAuthorizedLocalMutation: () => true });
  return response;
}

test("a failed core restart still brings the usage bridge back", async (t) => {
  const calls = [];
  t.mock.method(bridge, "stopBridge", () => calls.push("stop"));
  t.mock.method(bridge, "startBridge", () => calls.push("start"));
  t.mock.method(manager, "restart", async () => {
    calls.push("restart");
    throw new Error("Core did not become healthy within 15s");
  });
  const response = await postRestart();
  assert.equal(response.status, 500);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /did not become healthy/);
  assert.deepEqual(calls, ["stop", "restart", "start"]);
});

test("a successful restart leaves the bridge running in the response", async (t) => {
  const calls = [];
  t.mock.method(bridge, "stopBridge", () => calls.push("stop"));
  t.mock.method(bridge, "startBridge", () => calls.push("start"));
  t.mock.method(manager, "restart", async () => {
    calls.push("restart");
    return { stopped: true, running: true };
  });
  const response = await postRestart();
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.result, { stopped: true, running: true });
  assert.deepEqual(calls, ["stop", "restart", "start"]);
});
