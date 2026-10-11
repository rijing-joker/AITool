"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolvePiSessionFiles } = require("../src/lib/rollout");

// Multica launches pi headless with a flat ~/.multica/pi-sessions layout and
// never creates the TUI ~/.pi/agent/sessions tree — the Multica scan must run
// even when the TUI scan has nothing to walk (TokenTracker PR #770 review).
test("Multica pi-sessions are counted even when the pi TUI sessions dir is absent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pi-multica-"));
  try {
    const multicaDir = path.join(home, ".multica", "pi-sessions");
    fs.mkdirSync(multicaDir, { recursive: true });
    fs.writeFileSync(path.join(multicaDir, "session-a.jsonl"), "{}\n");
    fs.writeFileSync(path.join(multicaDir, "notes.txt"), "not a session");

    const files = resolvePiSessionFiles({ HOME: home });
    assert.deepEqual(files, [path.join(multicaDir, "session-a.jsonl")]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("TUI and Multica sessions combine into one sorted list", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pi-multica-"));
  try {
    const tuiDir = path.join(home, ".pi", "agent", "sessions", "home-project");
    fs.mkdirSync(tuiDir, { recursive: true });
    fs.writeFileSync(path.join(tuiDir, "tui-1.jsonl"), "{}\n");
    const multicaDir = path.join(home, ".multica", "pi-sessions");
    fs.mkdirSync(multicaDir, { recursive: true });
    fs.writeFileSync(path.join(multicaDir, "orch-1.jsonl"), "{}\n");

    const files = resolvePiSessionFiles({ HOME: home });
    assert.deepEqual(files, [
      path.join(multicaDir, "orch-1.jsonl"),
      path.join(tuiDir, "tui-1.jsonl"),
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
