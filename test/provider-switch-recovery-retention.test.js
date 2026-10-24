"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pruneRecovery } = require("../src/lib/provider-switch/recovery-retention");
test("recovery retention bounds completed copies while retaining active and receipt-referenced attempts", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-retention-")); t.after(() => fs.rm(home, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => home);
  const root = path.join(home, ".aitool/provider-switch"), backups = path.join(root, "distribution-backups"), now = Date.now();
  const make = async (age, status) => {
    const target = path.join(backups, randomUUID()); await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "manifest.json"), JSON.stringify({ version: 1, createdAt: new Date(now - age).toISOString(), files: [{ status }] }));
    return target;
  };
  const referenced = await make(40 * 86400000, "failed"), pending = await make(40 * 86400000, "pending"), old = await make(40 * 86400000, "applied");
  const older = await make(3000, "applied"), recent = await make(2000, "applied"), current = await make(1000, "applied");
  await fs.writeFile(path.join(root, "distribution.json"), JSON.stringify({ owned: { file: { backup: path.join(referenced, "0.bak") } } }));
  await pruneRecovery("distribution-backups", current, { now, maxEntries: 2 });
  for (const target of [referenced, pending, recent, current]) assert.ok(await fs.stat(target));
  for (const target of [old, older]) await assert.rejects(fs.stat(target), { code: "ENOENT" });
});
