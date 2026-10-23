"use strict";
const path = require("node:path");
const { spawn } = require("node:child_process");
const state = require("../managed-upstream");
const direct = require("./http");
async function control(route, options = {}) {
  const config = await state.settings(options), runtime = await state.read(path.join(state.root(options), "runtime.json"));
  if (!runtime?.port || !config.token) return null;
  try { return await direct.json(`http://127.0.0.1:${runtime.port}${route}`, { method: route === "/shutdown" ? "POST" : "GET", headers: { authorization: `Bearer ${config.token}` }, timeout: 1500 }); } catch { return null; }
}
async function start(options = {}) {
  return require("../../fs").withFileLock(path.join(state.root(options), "runtime-lifecycle"), () => startLocked(options));
}
async function startLocked(options = {}) {
  const current = await state.read(path.join(state.root(options), "runtime.json"));
  if (current?.port && (await control("/health", options))?.pid === current.pid) {
    await state.saveSettings(value => ({ ...value, port: current.port }), options); return current.port;
  }
  await state.saveSettings(value => value, options);
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, AITOOL_EXTENSIONS_DIR: state.root(options) }, detached: true, stdio: "ignore", windowsHide: true });
  let exited = false; child.on("error", () => { exited = true; }); child.on("exit", () => { exited = true; }); child.unref();
  for (let i = 0; i < 80 && !exited; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const runtime = await state.read(path.join(state.root(options), "runtime.json"));
    if (runtime?.pid === child.pid && (await control("/health", options))?.pid === child.pid) {
      await state.saveSettings(value => ({ ...value, port: runtime.port }), options); return runtime.port;
    }
  }
  child.kill(); throw new Error("Optional upstream listener could not start");
}
async function stop(options = {}) {
  return require("../../fs").withFileLock(path.join(state.root(options), "runtime-lifecycle"), async () => {
    const result = await control("/shutdown", options);
    for (let i = 0; result && i < 40; i++) {
      if (!await control("/health", options)) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (result) throw new Error("Optional listener did not stop");
    return result;
  });
}
async function startEnabled(options = {}) {
  const config = await state.settings(options);
  if (Object.values(config.enabled).some(value => value === true)) await start(options);
}
module.exports = { start, stop, startEnabled, control };
