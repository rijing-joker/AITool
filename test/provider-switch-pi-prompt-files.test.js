"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, describe, it } = require("node:test");
const piFiles = require("../src/lib/provider-switch/pi-prompt-files");

// pi native prompt resources: CAS semantics over ~/.pi/agent files, mirroring
// cc-switch's PiPromptFileService (exists = active, delete = off).

let homeDir;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-pi-files-"));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

const agentFile = (name) => path.join(homeDir, ".pi", "agent", name);

describe("pi prompt files", () => {
  it("reads an absent file with a null revision", async () => {
    const file = await piFiles.read("system_override");
    assert.equal(file.exists, false);
    assert.equal(file.revision, null);
    assert.equal(file.path, agentFile("SYSTEM.md"));
  });

  it("creates, rereads and CAS-replaces a file", async () => {
    const created = await piFiles.replace("system_append", "extra instructions", null);
    assert.equal(created.exists, true);
    assert.equal(fs.readFileSync(agentFile("APPEND_SYSTEM.md"), "utf8"), "extra instructions");

    const reread = await piFiles.read("system_append");
    assert.equal(reread.revision, created.revision);

    const replaced = await piFiles.replace("system_append", "v2", created.revision);
    assert.equal(replaced.content, "v2");
    assert.notEqual(replaced.revision, created.revision);
  });

  it("refuses a replace with a stale revision (external edit)", async () => {
    await piFiles.replace("system_override", "v1", null);
    fs.writeFileSync(agentFile("SYSTEM.md"), "externally edited");
    await assert.rejects(
      () => piFiles.replace("system_override", "v2", crypto.createHash("sha256").update("v1", "utf8").digest("hex")),
      /changed outside AiTool/,
    );
    assert.equal(fs.readFileSync(agentFile("SYSTEM.md"), "utf8"), "externally edited");
  });

  it("refuses empty content and oversized files, and unknown kinds", async () => {
    await assert.rejects(() => piFiles.replace("system_append", "   ", null), /non-empty/);
    await assert.rejects(() => piFiles.replace("system_append", "x".repeat(1024 * 1024 + 1), null), /KiB limit/);
    await assert.rejects(() => piFiles.read("bogus"), /Unknown pi prompt file kind/);
    assert.equal(fs.existsSync(agentFile("APPEND_SYSTEM.md")), false);
  });

  it("deletes with CAS and refuses deleting an absent or changed file", async () => {
    const created = await piFiles.replace("system_override", "v1", null);
    await piFiles.remove("system_override", "stale-revision").then(
      () => assert.fail("expected rejection"),
      (error) => assert.match(error.message, /changed outside AiTool/),
    );
    const removed = await piFiles.remove("system_override", created.revision);
    assert.equal(removed.exists, false);
    assert.equal(fs.existsSync(agentFile("SYSTEM.md")), false);
    await assert.rejects(() => piFiles.remove("system_override", null), /does not exist/);
  });
});
