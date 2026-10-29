"use strict";
// EasyCLIProxyAPI 066ed455, agents/native_oauth.rs (MIT). Model/effort are
// provider-owned here, so this global surface changes only the runtime limits.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { parse } = require("smol-toml");
const toml = require("./toml");
const { withFileLock, ensureDir, writeFileAtomic } = require("../fs");
const revision = text => crypto.createHash("sha256").update(text).digest("hex");
function configOf(text) {
  const agents = parse(text || "").agents || {};
  if (typeof agents !== "object" || Array.isArray(agents)) throw new Error("Codex agents configuration must be a table");
  return { enabled: agents.enabled ?? true, maxConcurrentThreadsPerSession: agents.max_concurrent_threads_per_session ?? null, interruptMessage: agents.interrupt_message ?? true };
}
async function read(file = require("./paths").targetFile("codex", "config").path) {
  const text = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  return { config: configOf(text), revision: revision(text), path: file };
}
function project(text, config) {
  if (typeof config.enabled !== "boolean" || typeof config.interruptMessage !== "boolean") throw new Error("Codex subagent toggles must be booleans");
  const max = config.maxConcurrentThreadsPerSession;
  if (max !== null && (!Number.isSafeInteger(max) || max < 1)) throw new Error("Maximum concurrent threads must be a positive integer or empty");
  configOf(text);
  let result = toml.setTableValue(text, "agents", "enabled", config.enabled);
  result = toml.setTableValue(result, "agents", "interrupt_message", config.interruptMessage);
  result = toml.setTableValue(result, "agents", "max_concurrent_threads_per_session", max === null ? undefined : max);
  configOf(result);
  return result;
}
async function save(config, expectedRevision, file = require("./paths").targetFile("codex", "config").path) {
  return withFileLock(file, async () => {
    const before = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    if (!expectedRevision || revision(before) !== expectedRevision) throw Object.assign(new Error("Codex configuration changed; reload before saving"), { status: 409 });
    const after = project(before, config);
    if (after !== before) {
      await require("./backup").createBackup("codex", file);
      await ensureDir(path.dirname(file));
      // Recheck after the asynchronous backup, immediately before mutation.
      const current = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      if (current !== before) throw Object.assign(new Error("Codex configuration changed; reload before saving"), { status: 409 });
      await writeFileAtomic(file, after, { mode: 0o600 });
    }
    return { config: configOf(after), revision: revision(after), path: file };
  });
}
module.exports = { read, save, project, configOf };
