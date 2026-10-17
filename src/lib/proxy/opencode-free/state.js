const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.env.AITOOL_OPENCODE_FREE_DIR || require("../paths").opencodeFreeDir;
const settingsPath = path.join(root, "settings.json");
const runtimePath = path.join(root, "runtime.json");
function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw new Error("opencode_free_state_unreadable"); }
}
function write(file, value) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function settings() { return read(settingsPath, { enabled: false, port: 0, models: [] }); }
function ensureSettings() {
  const value = settings();
  if (!value.token) { value.token = crypto.randomBytes(32).toString("hex"); write(settingsPath, value); }
  return value;
}
module.exports = { root, settingsPath, runtimePath, read, write, settings, ensureSettings };
