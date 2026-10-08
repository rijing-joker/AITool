"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, describe, it } = require("node:test");
const store = require("../src/lib/provider-switch/store");
const backupExport = require("../src/lib/provider-switch/backup-export");

// Encrypted backup round-trip: only stores present on disk enter the blob,
// the passphrase is never recoverable, and a restore snapshots current files.

let homeDir;
const PASS = "correct horse battery";

beforeEach(async () => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-backup-"));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  await store.createProvider("claude", { name: "a", settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: "sk-1" } } });
  // OAuth tokens must never be exported, even encrypted.
  fs.mkdirSync(path.join(homeDir, ".aitool", "provider-switch"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".aitool", "provider-switch", "codex-auth-stash.json"), '{"tokens":"secret"}');
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("provider backup export/import", () => {
  for (const name of ["mcp-servers.json", "prompts.json"]) {
    it(`round-trips a backup containing only ${name}`, async () => {
      const root = path.join(homeDir, ".aitool", "provider-switch");
      fs.unlinkSync(path.join(root, "providers.json"));
      const original = name === "mcp-servers.json"
        ? { version: 1, servers: [{ id: "fetch", server: { command: "fetch" }, apps: { codex: true } }] }
        : { version: 1, apps: { claude: [{ id: "rules", content: "be concise", enabled: false }] } };
      fs.writeFileSync(path.join(root, name), JSON.stringify(original));
      const payload = await backupExport.exportEncrypted(PASS);
      fs.unlinkSync(path.join(root, name));

      const result = await backupExport.importEncrypted(PASS, payload);
      assert.deepEqual(result.restored, [name]);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, name), "utf8")), original);
      assert.equal(fs.existsSync(path.join(root, "providers.json")), false);
      assert.equal(fs.readFileSync(path.join(root, "codex-auth-stash.json"), "utf8"), '{"tokens":"secret"}');
    });
  }

  it("round-trips stores through the encrypted blob", async () => {
    const payload = await backupExport.exportEncrypted(PASS);
    assert.equal(payload.format, backupExport.FORMAT);
    assert.ok(payload.ciphertext.length > 0);
    const raw = JSON.stringify(payload);
    assert.ok(!raw.includes("sk-1"), "plaintext secret must not leak into the blob");
    assert.ok(!raw.includes(PASS), "passphrase must not leak into the blob");

    // mutate the store, then restore
    await store.createProvider("claude", { name: "b", settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: "sk-2" } } });
    const result = await backupExport.importEncrypted(PASS, payload);
    assert.deepEqual(result.restored, ["providers.json"]);
    const restored = await store.listProviders("claude");
    assert.equal(restored.providers.length, 1);
    assert.equal(restored.providers[0].name, "a");
    // documented exclusions and permissions
    assert.ok(!raw.includes("stash"), "codex auth stash must not enter the blob");
    assert.equal(fs.statSync(path.join(homeDir, ".aitool", "provider-switch", "providers.json")).mode & 0o777, 0o600);
    // the pre-import snapshot kept the mutated state
    const importDirs = fs.readdirSync(path.join(homeDir, ".aitool", "provider-switch", "backups", "import"));
    const snapshot = fs.readFileSync(
      path.join(homeDir, ".aitool", "provider-switch", "backups", "import", importDirs[0], "providers.json"),
      "utf8",
    );
    assert.ok(snapshot.includes("sk-2"));
  });

  it("rejects a wrong passphrase and corrupt payloads", async () => {
    const payload = await backupExport.exportEncrypted(PASS);
    await assert.rejects(() => backupExport.importEncrypted("wrong passphrase", payload), /Wrong passphrase/);
    await assert.rejects(() => backupExport.importEncrypted(PASS, { format: "other" }), /Not an AiTool/);
    await assert.rejects(() => backupExport.importEncrypted(PASS, { ...payload, ciphertext: "!!!" }), /Corrupted|Wrong passphrase/);
  });

  it("refuses short passphrases and empty exports", async () => {
    await assert.rejects(() => backupExport.exportEncrypted("short"), /at least 8/);
    fs.rmSync(path.join(homeDir, ".aitool", "provider-switch"), { recursive: true, force: true });
    await assert.rejects(() => backupExport.exportEncrypted(PASS), /Nothing to back up/);
  });
});
