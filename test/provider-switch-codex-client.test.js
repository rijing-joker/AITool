"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { withHome } = require("./helpers/with-home");
const client = require("../src/lib/provider-switch/codex-client");
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-codex-client-"));
  const restore = withHome(home);
  t.after(async () => { restore(); await fs.rm(home, { recursive: true, force: true }); });
  const root = path.join(home, ".codex");
  await fs.mkdir(path.join(root, "app-server-daemon"), { recursive: true });
  await fs.writeFile(path.join(root, "app-server-daemon", "daemon.pid"), '{"pid":123}');
  await fs.writeFile(path.join(root, "config.toml"), 'model_catalog_json = "models.json"\n');
  await fs.writeFile(path.join(root, "models.json"), '{"models":["first"]}');
  const runner = async (cmd) => ({ status: 0, stdout: cmd === "ps" ? '123 02:00 /opt/bin/codex app-server --managed-daemon\n234 02:00 /opt/bin/codex app-server\n999 02:00 /opt/bin/codex app-server daemon restart' : '{"status":"restarted"}', stderr: "" });
  return { home, root, runner };
}
test("catalog and login changes identify stale clients without retaining tokens", async (t) => {
  const x = await fixture(t);
  const options = { platform: "linux", commandRunner: x.runner, nowMs: 1800000000000 };
  assert.equal((await client.getCodexClientStatus(options)).daemon, false);
  await fs.writeFile(path.join(x.root, "models.json"), '{"models":["second"]}');
  const stale = await client.getCodexClientStatus({ ...options, nowMs: options.nowMs + 10000 });
  assert.equal(stale.daemon, true); assert.equal(stale.others, true); assert.equal(stale.catalog, true);
  await fs.writeFile(path.join(x.root, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-secret", account_id: "workspace" } }));
  assert.equal((await client.getCodexClientStatus({ ...options, nowMs: options.nowMs + 20000 })).auth, true);
  const history = await fs.readFile(path.join(x.home, ".aitool/provider-switch/codex-client-history.json"), "utf8");
  assert.doesNotMatch(history, /fixture-secret|workspace|second/);
  const refreshed = await client.getCodexClientStatus({ ...options, nowMs: options.nowMs + 30000, commandRunner: async () => ({ status: 0, stdout: '123 00:01 /opt/bin/codex app-server --managed-daemon' }) });
  assert.equal(refreshed.daemon, false);
});
test("restart uses Codex's grace period, correct home and one shared command", async (t) => {
  const x = await fixture(t);
  await fs.writeFile(path.join(x.root, "app-server-daemon/settings.json"), '{"shutdownGraceSeconds":300}');
  let calls = 0, finish;
  const options = { platform: "linux", executable: "/opt/bin/codex", commandRunner: async (cmd, args, opts) => {
    if (cmd === "ps") return x.runner(cmd);
    calls++; assert.deepEqual(args, ["app-server", "daemon", "restart"]);
    assert.equal(opts.env.CODEX_HOME, x.root); assert.equal(opts.timeout, 375000);
    return new Promise((resolve) => { finish = () => resolve({ status: 0, stdout: '{"status":"restarted"}' }); });
  } };
  const first = client.restartCodexDaemon(options), second = client.restartCodexDaemon(options);
  assert.equal(first, second);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  finish(); assert.equal((await first).outcome, "restarted"); assert.equal(calls, 1);
});
test("missing or recycled daemon PID never launches a daemon", async (t) => {
  const x = await fixture(t);
  let restartCalls = 0;
  const result = await client.restartCodexDaemon({ platform: "linux", executable: "/opt/bin/codex", commandRunner: async (cmd) => {
    if (cmd === "ps") return { status: 0, stdout: '123 01:00 /usr/bin/other app-server --managed-daemon\n456 01:00 /opt/bin/codex app-server --managed-daemon' };
    restartCalls++; return { status: 0 };
  } });
  assert.equal(result.outcome, "notRunning"); assert.equal(restartCalls, 0);
});
test("Windows verifies the recorded process creation time and acknowledges unknown clients", async (t) => {
  const x = await fixture(t);
  await fs.writeFile(path.join(x.root, "app-server-daemon/daemon.pid"), '{"pid":123,"processStartTime":"133600000000000000"}');
  const options = { platform: "win32", commandRunner: async () => ({ status: 0, stdout: '133600000000000001' }) };
  assert.equal((await client.getCodexClientStatus(options)).daemonRunning, false);
  await fs.writeFile(path.join(x.root, "models.json"), '{"models":["third"]}');
  assert.equal((await client.getCodexClientStatus(options)).others, true);
  await client.acknowledgeCodexClients();
  assert.equal((await client.getCodexClientStatus(options)).others, false);
});
test("refreshing OAuth tokens for the same workspace does not stale clients", async (t) => {
  const x = await fixture(t);
  const auth = (token) => JSON.stringify({ tokens: { access_token: token, refresh_token: token, account_id: "same-workspace" } });
  await fs.writeFile(path.join(x.root, "auth.json"), auth("old-secret"));
  const options = { platform: "linux", commandRunner: x.runner, nowMs: 1800000000000 };
  await client.getCodexClientStatus(options);
  await fs.writeFile(path.join(x.root, "auth.json"), auth("new-secret"));
  const result = await client.getCodexClientStatus({ ...options, nowMs: options.nowMs + 10000 });
  assert.equal(result.auth, false); assert.equal(result.daemon, false);
});
test("failed restart masks CLI diagnostics and releases the pending operation", async (t) => {
  const x = await fixture(t);
  const options = { platform: "linux", executable: "/opt/bin/codex", commandRunner: async (cmd) => cmd === "ps" ? x.runner(cmd) : { status: 1, stderr: "fixture-secret" } };
  await assert.rejects(client.restartCodexDaemon(options), { message: "Codex daemon restart failed." });
  assert.equal((await client.restartCodexDaemon({ ...options, commandRunner: x.runner })).outcome, "restarted");
});
