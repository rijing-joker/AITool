const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { test } = require("node:test");
const paths = require("../src/lib/proxy/paths");

test("version probes are shared and invalidated by replacement, rewrite and removal", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-version-"));
  const previous = paths.binPath;
  paths.binPath = path.join(root, "core");
  t.after(() => { paths.binPath = previous; fs.rmSync(root, { recursive: true, force: true }); });
  let calls = 0;
  t.mock.method(cp, "execFile", (file, args, options, callback) => {
    calls++;
    const version = fs.readFileSync(file, "utf8");
    setImmediate(() => callback(null, `CLIProxyAPI Version: ${version}, Commit: test`));
  });
  delete require.cache[require.resolve("../src/lib/proxy/manager")];
  const manager = require("../src/lib/proxy/manager");
  t.after(() => { delete require.cache[require.resolve("../src/lib/proxy/manager")]; });
  fs.writeFileSync(paths.binPath, "1.0.0");
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => manager.readBinaryVersion())), Array(6).fill("1.0.0"));
  assert.equal(await manager.readBinaryVersion(), "1.0.0");
  assert.equal(calls, 1);
  fs.writeFileSync(paths.binPath + ".new", "2.0.0");
  fs.renameSync(paths.binPath + ".new", paths.binPath);
  assert.equal(await manager.readBinaryVersion(), "2.0.0");
  fs.writeFileSync(paths.binPath, "3.0.0");
  // Do not rely on the filesystem clock advancing between tiny fixture writes.
  const changedAt = new Date(Date.now() + 1000);
  fs.utimesSync(paths.binPath, changedAt, changedAt);
  assert.equal(await manager.readBinaryVersion(), "3.0.0");
  assert.equal(calls, 3);
  fs.unlinkSync(paths.binPath);
  assert.equal(await manager.readBinaryVersion(), null);
});

test("a transient failed version probe retries after its short cooldown", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-version-"));
  const previous = paths.binPath;
  paths.binPath = path.join(root, "core");
  fs.writeFileSync(paths.binPath, "binary");
  t.after(() => { paths.binPath = previous; fs.rmSync(root, { recursive: true, force: true }); });
  let calls = 0, now = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(cp, "execFile", (_file, _args, _options, callback) => {
    const stdout = ++calls === 1 ? "" : "CLIProxyAPI Version: 1.0.0";
    setImmediate(() => callback(null, stdout));
  });
  delete require.cache[require.resolve("../src/lib/proxy/manager")];
  const { readBinaryVersion } = require("../src/lib/proxy/manager");
  t.after(() => { delete require.cache[require.resolve("../src/lib/proxy/manager")]; });
  assert.equal(await readBinaryVersion(), null);
  assert.equal(await readBinaryVersion(), null);
  assert.equal(calls, 1);
  now = 1001;
  assert.equal(await readBinaryVersion(), "1.0.0");
  assert.equal(calls, 2);
  now += 5 * 60_000 + 1;
  assert.equal(await readBinaryVersion(), "1.0.0");
  assert.equal(calls, 3, "successful probes also expire on coarse timestamp filesystems");
});
