"use strict";
// Ported from cc-switch agy_config.rs, fixed 0a41250dc03a (MIT).
// Keys go only to the spawned process; shared Gemini settings stay untouched.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { writeFileAtomic, ensureDir, chmod600IfPossible } = require("../fs");
const { createBackup } = require("./backup");
const { resolveBinaryPath } = require("../command-runner");
const paths = require("./paths");
const { privateDirectory, privateFile } = require("./agy-fs");

function sanitize(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agy settings");
  const env = {};
  for (const field of ["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"]) {
    const text = value.env?.[field];
    if (typeof text === "string" && text.trim()) env[field] = text.trim();
  }
  if (env.GOOGLE_GEMINI_BASE_URL && !env.GEMINI_API_KEY) throw new Error("Antigravity endpoint requires an API key");
  if (env.GOOGLE_GEMINI_BASE_URL) {
    const url = new URL(env.GOOGLE_GEMINI_BASE_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Antigravity endpoint");
  }
  const model = String(value.config?.model?.name || value.env?.GEMINI_MODEL || "").trim();
  return { env, config: { model: { name: model } } };
}
async function launch(row, { spawnImpl = spawn, resolve = resolveBinaryPath, platform = process.platform } = {}) {
  const binary = await resolve("agy");
  if (!binary) throw new Error("Antigravity CLI is not installed");
  const settings = sanitize(row.settingsConfig);
  const env = { ...process.env };
  for (const field of ["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GEMINI_MODEL"]) delete env[field];
  Object.assign(env, settings.env);
  const args = [];
  if (settings.env.GEMINI_API_KEY) {
    const directory = path.join(paths.providerSwitchRoot(), "agy", crypto.createHash("sha256").update(row.id).digest("hex").slice(0, 32));
    const native = path.join(directory, "antigravity-cli");
    await privateDirectory(native, paths.providerSwitchRoot());
    const file = path.join(native, "settings.json");
    await privateFile(file);
    let config = {};
    try { config = JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid private Antigravity settings");
    await createBackup("agy", file, { force: true });
    config.modelProvider = "gemini";
    if (settings.config.model.name) config.model = settings.config.model.name; else delete config.model;
    await writeFileAtomic(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await chmod600IfPossible(file);
    const shared = path.join(os.homedir(), ".gemini", "config");
    await ensureDir(shared);
    const link = path.join(directory, "config");
    const stat = await fs.lstat(link).catch(() => null);
    if (stat) {
      if (!stat.isSymbolicLink() || await fs.realpath(link) !== await fs.realpath(shared)) throw new Error("Antigravity customization path conflict");
    } else await fs.symlink(shared, link, platform === "win32" ? "junction" : "dir");
    args.push(`--gemini_dir=${directory}`);
  } else if (settings.config.model.name) args.push(`--model=${settings.config.model.name}`);
  // Terminal programs are executed directly. No shell command contains a key.
  let terminal;
  let terminalArgs;
  let broker;
  if (platform === "win32") { terminal = await resolve("wt"); terminalArgs = ["-w", "new", "new-tab", "--inheritEnvironment", binary, ...args]; }
  else if (platform === "darwin") {
    broker = await launchBroker(binary, args, env);
    terminal = "/usr/bin/open"; terminalArgs = ["-a", "Terminal", broker.script];
  }
  else {
    terminal = await resolve("x-terminal-emulator") || await resolve("gnome-terminal") || await resolve("xterm");
    if (terminal) {
      broker = await launchBroker(binary, args, env);
      const command = [process.execPath, path.join(__dirname, "agy-launcher.cjs"), broker.socket];
      terminalArgs = terminal.includes("gnome-terminal") ? ["--", ...command] : ["-e", ...command];
    }
  }
  if (!terminal) throw new Error("No supported terminal was found");
  if (!settings.env.GEMINI_API_KEY && row.meta?.agyAccountId) {
    try { await require("./agy-accounts").manager().switchAccount(row.meta.agyAccountId); }
    catch (error) { await broker?.close(); throw error; }
  }
  let child;
  try { child = spawnImpl(terminal, terminalArgs, { env, detached: true, stdio: "ignore" }); await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); }
  catch (error) { await broker?.close(); throw error; }
  child.unref();
  return { launched: true };
}
// A private Unix socket passes credentials to the terminal child, including
// terminals that reuse a GUI process and discard the launcher's environment.
// The .command file and process arguments contain only paths.
async function launchBroker(binary, args, env) {
  const root = path.join(paths.providerSwitchRoot(), "agy-launches");
  await privateDirectory(root, paths.providerSwitchRoot());
  const directory = await fs.mkdtemp(path.join(root, "launch-"));
  const socket = path.join(directory, "socket");
  const script = path.join(directory, "launch.command");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await fs.writeFile(script, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(__dirname, "agy-launcher.cjs"))} ${quote(socket)}\n`, { mode: 0o700 });
  const server = require("node:net").createServer(connection => {
    connection.end(JSON.stringify({ binary, args, env }));
    void close();
  });
  let timeout;
  const close = async () => { clearTimeout(timeout); server.close(); await fs.rm(directory, { recursive: true, force: true }); };
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  await fs.chmod(socket, 0o600);
  timeout = setTimeout(() => void close(), 120000); timeout.unref(); server.unref();
  return { socket, script, close };
}
async function models({ resolve = resolveBinaryPath, runner } = {}) {
  const binary = await resolve("agy");
  if (!binary) throw new Error("Antigravity CLI is not installed");
  const result = await require("../command-runner").runCommand(runner, binary, ["models"], { timeout: 20000, maxBuffer: 1048576 });
  if (result.status !== 0 || result.error) throw new Error("Antigravity model list is unavailable");
  const entries = String(result.stdout || "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).flatMap(line => {
    const columns = line.trim().replace(/^[│|]\s*/, "").split(/\s*[│|]\s*|\s{2,}|\t+/).map(value => value.trim()).filter(Boolean);
    if (columns.length < 2 || !/^[a-z][a-z0-9._-]*$/.test(columns[0]) || ["id", "model", "alias"].includes(columns[0])) return [];
    return [{ id: columns[1], name: columns[1], alias: columns[0] }];
  });
  if (!entries.length) throw new Error("Unrecognized Antigravity model list");
  return { models: entries, url: "agy models" };
}
module.exports = { sanitize, launch, launchBroker, models };
