const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Readable } = require("node:stream");
const config = require("../src/lib/proxy/config");
const { handleProxyApiRequest } = require("../src/lib/proxy/api");

test("privacy preference requires an authorized boolean write and preserves other settings", async (t) => {
  let settings = { managementKey: "private-management-key", autoStart: false };
  t.mock.method(config, "readSettings", () => ({ ...settings }));
  const write = t.mock.method(config, "writeSettings", (next) => { settings = next; });
  const request = async (method, body, authorized = false) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    let status, payload;
    await handleProxyApiRequest(req, {
      writeHead(code) { status = code; },
      end(text) { payload = JSON.parse(text); },
    }, new URL("http://localhost/api/proxy/privacy"), { isAuthorizedLocalMutation: () => authorized });
    return { status, payload };
  };
  assert.deepEqual(await request("GET"), { status: 200, payload: { ok: true, enabled: null } });
  assert.equal((await request("PUT", { enabled: true })).status, 401);
  assert.equal((await request("PUT", { enabled: "true" }, true)).status, 400);
  assert.equal(write.mock.callCount(), 0);
  assert.deepEqual(await request("PUT", { enabled: true }, true), { status: 200, payload: { ok: true, enabled: true } });
  assert.deepEqual(await request("GET"), { status: 200, payload: { ok: true, enabled: true } });
  assert.equal((await request("PUT", { enabled: false }, true)).payload.enabled, false);
  assert.deepEqual(settings, { managementKey: "private-management-key", autoStart: false, privacyMode: false });
});
