const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const state = require("./state");
const management = require("../management");
const { createCatalog, VERIFIED_FREE_IDS } = require("./catalog");
const discovery = createCatalog();
const GROUP = "aitool-opencode-free";
const ROUTE = "/v8/management/config/api-keys/openai-compatibility";

async function control(route, method = "GET", settings = state.settings()) {
  const runtime = state.read(state.runtimePath, null);
  if (!Number.isInteger(runtime?.port) || runtime.port < 1 || runtime.port > 65535 || !settings.token) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method, headers: { authorization: `Bearer ${settings.token}` },
      signal: AbortSignal.timeout(route === "/refresh" ? 20_000 : 1500), redirect: "error",
    });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

async function status() {
  const settings = state.settings();
  const health = await control("/health");
  const running = health?.service === "aitool-opencode-free";
  return {
    enabled: settings.enabled === true, running, port: running ? state.read(state.runtimePath, {}).port : settings.port,
    selectedModels: settings.models, catalog: running ? health.catalog : discovery.snapshot(),
    lastInference: running ? health.lastInference : null,
  };
}

// Serialise dashboard/CLI mutations across processes. A dead owner's lock can
// be removed, but an unrelated live process is never signalled.
async function locked(operation) {
  fs.mkdirSync(state.root, { recursive: true, mode: 0o700 });
  const file = path.join(state.root, "mutation.lock");
  const deadline = Date.now() + 25_000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(file, "wx", 0o600); fs.writeFileSync(fd, String(process.pid)); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let pid;
      try { pid = Number(fs.readFileSync(file, "utf8")); } catch {}
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (probe) { if (probe.code === "ESRCH") { fs.rmSync(file, { force: true }); continue; } }
      }
      if (Date.now() >= deadline) throw new Error("opencode_free_busy");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await operation(); }
  finally { fs.closeSync(fd); fs.rmSync(file, { force: true }); }
}

async function startRuntime() {
  const settings = state.ensureSettings();
  if ((await control("/health"))?.service === "aitool-opencode-free") {
    const runtime = state.read(state.runtimePath, {});
    // Recover a launcher crash between listener creation and port persistence.
    if (settings.port !== runtime.port) state.write(state.settingsPath, { ...settings, port: runtime.port });
    return;
  }
  fs.rmSync(state.runtimePath, { force: true });
  const child = spawn(process.execPath, [path.join(__dirname, "daemon.js")], {
    detached: true, stdio: "ignore", windowsHide: true,
    env: { ...process.env, AITOOL_OPENCODE_FREE_DIR: state.root },
  });
  let exited = false;
  child.on("error", () => { exited = true; }); child.on("exit", () => { exited = true; }); child.unref();
  const deadline = Date.now() + 8000;
  while (!exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const health = await control("/health");
    if (health?.service === "aitool-opencode-free" && health.pid === child.pid) {
      const runtime = state.read(state.runtimePath, {});
      // Keep the assigned port stable across restarts so core configuration stays valid.
      state.write(state.settingsPath, { ...settings, port: runtime.port }); return;
    }
  }
  // This is the child object we just spawned, never a PID taken from disk.
  if (!exited) child.kill();
  throw new Error("opencode_free_start_failed");
}

async function stopRuntime() {
  const health = await control("/health");
  if (health?.service !== "aitool-opencode-free") return;
  if (!(await control("/shutdown", "POST"))) throw new Error("opencode_free_stop_failed");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await control("/health"))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("opencode_free_stop_failed");
}

function mergeSelectedModels(existing, selected, additions = selected) {
  // Model names select the upstream; aliases and all other model fields belong
  // to the user's native configuration. Keep their order and multiple aliases.
  const selectedNames = new Set(selected);
  const models = Array.isArray(existing) ? existing.filter((model) => selectedNames.has(model?.name)) : [];
  const present = new Set(models.map((model) => model.name));
  for (const id of new Set(additions)) {
    if (!present.has(id)) models.push({ name: id, alias: id });
  }
  return models;
}

function mergeGroup(groups, settings, enabled) {
  if (!Array.isArray(groups)) throw new Error("invalid_upstream_groups");
  const existing = groups.find((group) => group.name === GROUP);
  if (existing && !existing.keys?.some((key) => key["api-key"] === settings.token)) throw new Error("opencode_free_group_conflict");
  const remaining = groups.filter((group) => group.name !== GROUP);
  if (!enabled) return remaining;
  const existingKey = existing?.keys?.find((key) => key["api-key"] === settings.token);
  const key = { ...existingKey, "api-key": settings.token, "proxy-url": "direct" };
  if (Array.isArray(key.models)) {
    // Preserve a key's narrower model selection on restart. Only newly added
    // group models need a default mapping in an explicit key-level list.
    const previousNames = new Set((existing.models || []).map((model) => model?.name));
    const additions = settings.models.filter((id) => !previousNames.has(id));
    key.models = mergeSelectedModels(key.models, settings.models, additions);
  }
  const record = {
    ...(existing || {}), name: GROUP, "base-url": `http://127.0.0.1:${settings.port}/v1`,
    keys: [key],
    models: mergeSelectedModels(existing?.models, settings.models),
  };
  if (existing) return groups.map((group) => group.name === GROUP ? record : group);
  return [...remaining, record];
}

async function syncGroup(enabled = state.settings().enabled === true) {
  const result = await management.request("GET", ROUTE);
  if (!result.ok && !enabled && result.error === "ECONNREFUSED") {
    const manager = require("../manager");
    if (await manager.managedCoreAlive(manager.readPid())) throw new Error("opencode_free_core_unavailable");
    // With the core stopped, remove only our YAML node, preserving comments,
    // other providers and a byte-for-byte backup for recovery.
    const configPath = require("../paths").configPath;
    if (!fs.existsSync(configPath)) return;
    const YAML = require("yaml");
    const raw = fs.readFileSync(configPath, "utf8");
    const doc = YAML.parseDocument(raw);
    if (doc.errors.length) throw new Error("invalid_proxy_config");
    const key = ["api-keys", "openai-compatibility"];
    const groups = doc.getIn(key)?.toJSON() || [];
    const next = mergeGroup(groups, state.settings(), false);
    if (JSON.stringify(next) === JSON.stringify(groups)) return;
    doc.setIn(key, next);
    const backup = `${configPath}.opencode-free-${require("node:crypto").randomBytes(6).toString("hex")}.bak`;
    fs.writeFileSync(backup, raw, { mode: 0o600, flag: "wx" });
    const temp = `${backup}.tmp`;
    try { fs.writeFileSync(temp, String(doc), { mode: 0o600 }); fs.renameSync(temp, configPath); }
    finally { fs.rmSync(temp, { force: true }); }
    return;
  }
  if (!result.ok && !(result.status === 404 && (result.data === "not_found" || result.data?.error === "not_found"))) throw new Error("opencode_free_core_unavailable");
  // Native v8 returns a bare array; accept a wrapped data value as well.
  const groups = result.status === 404 ? [] : Array.isArray(result.data) ? result.data : result.data?.data;
  const next = mergeGroup(groups, state.settings(), enabled);
  if (JSON.stringify(groups) === JSON.stringify(next)) return;
  const saved = await management.request("PUT", ROUTE, { body: next });
  if (!saved.ok) throw new Error("opencode_free_group_save_failed");
}

async function refresh() {
  const remote = await control("/refresh", "POST");
  return remote || discovery.refresh(true);
}

async function configure(input) {
  return locked(async () => {
    if (typeof input.enabled !== "boolean") throw new Error("enabled_must_be_boolean");
    const previous = state.ensureSettings();
    const models = input.models ?? previous.models;
    const port = input.port ?? previous.port;
    if (!Array.isArray(models) || models.some((id) => !VERIFIED_FREE_IDS.includes(id))) throw new Error("invalid_free_models");
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_adapter_port");
    if (input.enabled) {
      if (!models.length) throw new Error("select_free_models");
      const catalog = await refresh();
      if (catalog.lastError || models.some((id) => !catalog.models.some((m) => m.id === id))) throw new Error("model_unavailable");
    }
    // Remove the core route before stopping its listener. If the core cannot
    // save, keep the current working configuration and report the error.
    if (!input.enabled) {
      await syncGroup(false);
      state.write(state.settingsPath, { ...previous, enabled: false });
      await stopRuntime();
      return status();
    }
    const wasRunning = (await control("/health"))?.service === "aitool-opencode-free";
    try {
      if (port !== previous.port && wasRunning) await stopRuntime();
      state.write(state.settingsPath, { ...previous, enabled: true, models: [...new Set(models)], port });
      await startRuntime();
      const activeCatalog = await control("/refresh", "POST");
      if (!activeCatalog || activeCatalog.lastError || models.some((id) => !activeCatalog.models.some((m) => m.id === id))) throw new Error("model_unavailable");
      await syncGroup(true);
    } catch (error) {
      await stopRuntime();
      state.write(state.settingsPath, previous);
      if (wasRunning) await startRuntime();
      throw error;
    }
    return status();
  });
}

async function startEnabled() {
  if (state.settings().enabled === true) await locked(startRuntime);
}
async function stop() { return locked(stopRuntime); }
module.exports = { status, configure, refresh, startEnabled, syncGroup, stop, mergeGroup };
