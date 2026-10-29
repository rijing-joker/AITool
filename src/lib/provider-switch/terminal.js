"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
const { resolveBinaryPath } = require("../command-runner");

// Execute a CLI in a terminal; secrets stay in process memory and the private
// one-shot broker, never in command strings, script files or process arguments.
async function launch(binary, args = [], env = process.env, { resolve = resolveBinaryPath, spawnImpl = spawn, platform = process.platform } = {}) {
  let terminal, terminalArgs, broker;
  if (platform === "win32") { terminal = await resolve("wt"); terminalArgs = ["-w", "new", "new-tab", "--inheritEnvironment", binary, ...args]; }
  else {
    terminal = platform === "darwin" ? "/usr/bin/open" : await resolve("x-terminal-emulator") || await resolve("gnome-terminal") || await resolve("xterm");
    if (terminal) {
      broker = await require("./agy").launchBroker(binary, args, env);
      const command = [process.execPath, path.join(__dirname, "agy-launcher.cjs"), broker.socket];
      terminalArgs = platform === "darwin" ? ["-a", "Terminal", broker.script] : terminal.includes("gnome-terminal") ? ["--", ...command] : ["-e", ...command];
    }
  }
  if (!terminal) throw new Error("No supported terminal was found");
  try {
    const child = spawnImpl(terminal, terminalArgs, { env, detached: true, stdio: "ignore" });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  } catch (error) { await broker?.close(); throw error; }
  return { launched: true };
}
async function launchNative(app, options = {}) {
  if (!["dsh", "omp"].includes(app)) throw new Error("Unsupported CLI launch");
  const binary = await (options.resolve || resolveBinaryPath)(app);
  if (!binary) throw new Error(`${app} CLI is not installed`);
  const env = { ...process.env };
  if (app === "omp") env.PI_CODING_AGENT_DIR = require("./omp").agentDir(env);
  return launch(binary, [], env, options);
}
module.exports = { launch, launchNative };
