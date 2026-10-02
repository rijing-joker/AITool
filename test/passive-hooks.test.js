const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { repairRuntimeIntegrations } = require("../src/commands/init");

// A shared-config server (the Docker image, which bind-mounts the host's
// ~/.claude into its own $HOME) must NOT register the interactive Claude usage
// hook: it would write this process's $HOME path into the host-shared
// settings.json and the host's own Claude Code would then fail that Stop hook.
function makeHome(label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `tt-passive-${label}-`));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true }); // config dir present → repair would install
  const trackerDir = path.join(home, ".tokentracker");
  const binDir = path.join(trackerDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  return { home, trackerDir, binDir, settingsPath: path.join(home, ".claude", "settings.json") };
}

test("AITOOL_PASSIVE_HOOKS skips the Claude usage-hook install", async () => {
  const { home, trackerDir, binDir, settingsPath } = makeHome("on");
  const prev = process.env.AITOOL_PASSIVE_HOOKS;
  process.env.AITOOL_PASSIVE_HOOKS = "1";
  try {
    const result = await repairRuntimeIntegrations({ home, trackerDir, binDir });
    assert.equal(result.integrations.claude.skippedReason, "passive-hooks");
    const written = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
    assert.doesNotMatch(written, /notify\.cjs/, "no notify hook may be written into the shared config");
  } finally {
    if (prev === undefined) delete process.env.AITOOL_PASSIVE_HOOKS;
    else process.env.AITOOL_PASSIVE_HOOKS = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("without the flag the Claude usage hook is installed as before", async () => {
  const { home, trackerDir, binDir, settingsPath } = makeHome("off");
  const prev = process.env.AITOOL_PASSIVE_HOOKS;
  delete process.env.AITOOL_PASSIVE_HOOKS;
  try {
    await repairRuntimeIntegrations({ home, trackerDir, binDir });
    assert.match(fs.readFileSync(settingsPath, "utf8"), /notify\.cjs/, "hook should install when not passive");
  } finally {
    if (prev !== undefined) process.env.AITOOL_PASSIVE_HOOKS = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
