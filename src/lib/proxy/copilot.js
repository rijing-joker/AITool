"use strict";

// EasyCLIProxyAPI's Copilot integrations, adapted to the Node management layer.
// The CLI's native settings are untouched. VS Code credentials are handed to
// its native provider command in a temporary extension development host.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { writeFileAtomic, ensureDir } = require("../fs");
const { runCommand, resolveBinaryPath, resolvedCliEnvironment } = require("../command-runner");
const MARKER = "aitool";
const GROUP = "AiTool";
const fields = ["provider", "baseUrl", "apiKey", "model"];
const hash = (key) => crypto.createHash("sha256").update(key).digest("hex");
const validSecret = (value) => typeof value === "string" && /^\$\{input:chat\.lm\.secret\.[^}\s\x00-\x1f]+\}$/.test(value);
const managedGroup = (value) => value?.vendor === "customendpoint" && value.name === GROUP;

function locations(client, { home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  if (!["cli", "vscode"].includes(client)) throw new Error("Unknown Copilot client.");
  const absolute = (value, fallback) => value && path.isAbsolute(value) ? value : fallback;
  const directory = client === "cli" ? absolute(env.COPILOT_HOME, path.join(home, ".copilot"))
    : path.join(platform === "win32" ? absolute(env.APPDATA, path.join(home, "AppData/Roaming"))
      : platform === "darwin" ? path.join(home, "Library/Application Support")
        : absolute(env.XDG_CONFIG_HOME, path.join(home, ".config")), "Code/User");
  const target = path.join(directory, client === "cli" ? "aitool-connection.json" : "chatLanguageModels.json");
  const state = path.join(directory, "aitool-copilot");
  return { target, state, baseline: path.join(state, `${client}-baseline.json`), credential: path.join(state, "credential.json") };
}
async function optionalText(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("Cannot read Copilot configuration."); }
}
function parse(client, text) {
  let value;
  try { value = text === null ? (client === "cli" ? {} : []) : JSON.parse(text); }
  catch { throw new Error("Copilot configuration contains invalid JSON."); }
  if (client === "cli" ? !value || typeof value !== "object" || Array.isArray(value) : !Array.isArray(value)) {
    throw new Error("Copilot configuration has an invalid structure.");
  }
  return value;
}
async function json(file) {
  const text = await optionalText(file);
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch { throw new Error("Copilot configuration contains invalid JSON."); }
}
async function privateWrite(file, value) { await writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); }
const pending = new Map();
function serialized(key, fn) {
  const previous = pending.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  pending.set(key, next);
  void next.finally(() => { if (pending.get(key) === next) pending.delete(key); }).catch(() => {});
  return next;
}

async function executable(client, options = {}) {
  const found = options.executable || await resolveBinaryPath(client === "cli" ? "copilot" : "code", options);
  if (!found || !path.isAbsolute(found)) throw new Error(client === "cli" ? "GitHub Copilot CLI is unavailable." : "VS Code is unavailable.");
  const platform = options.platform || process.platform;
  const result = await runCommand(options.commandRunner, found, ["--version"], {
    timeout: 5000, windowsHide: true, useShell: platform === "win32" && /\.(cmd|bat)$/i.test(found),
    env: resolvedCliEnvironment(found, { platform }),
  });
  const version = String(result.stdout || "");
  if (result.error || result.status !== 0 || (client === "cli"
    ? !/^GitHub Copilot CLI \d+\.\d+\.\d+(?:[-+][^\s]+)?\.?\s*$/m.test(version)
    : !/^\d+\.\d+\.\d+(?:[-+][^\s]+)?\s*$/m.test(version))) {
    throw new Error("The selected executable did not identify itself as the expected Copilot client.");
  }
  return found;
}
async function cachedSecret(files, key) {
  const value = await json(files.credential);
  return value?.keyHash === hash(key) && validSecret(value.secretReference) ? value.secretReference : null;
}
async function cleanupRun(directory) {
  for (const name of ["request.json", "response.json", "response.pending"]) await fs.unlink(path.join(directory, name)).catch(() => {});
  const helper = path.join(directory, "helper");
  const stat = await fs.lstat(helper).catch(() => null);
  if (stat?.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of ["package.json", "extension.cjs"]) await fs.unlink(path.join(helper, name)).catch(() => {});
    await fs.rmdir(helper).catch(() => {});
  }
  await fs.rmdir(directory).catch(() => {});
}
async function prepareSecret(files, key, binary, options) {
  const cached = await cachedSecret(files, key);
  if (cached) return cached;
  await fs.mkdir(files.state, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(files.state, "setup-"));
  const helper = path.join(directory, "helper");
  const id = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 120000;
  try {
    await fs.mkdir(helper, { mode: 0o700 });
    for (const name of ["package.json", "extension.cjs"]) {
      const source = await fs.readFile(path.join(__dirname, "resources/copilot-setup", name));
      await fs.writeFile(path.join(helper, name), source, { mode: 0o600 });
    }
    await privateWrite(path.join(directory, "request.json"), { id, apiKey: key, configPath: files.target, expiresAt });
    const platform = options.platform || process.platform;
    const launched = await runCommand(options.commandRunner, binary, ["--new-window", `--extensionDevelopmentPath=${helper}`], {
      timeout: 10000, windowsHide: true, useShell: platform === "win32" && /\.(cmd|bat)$/i.test(binary),
      env: resolvedCliEnvironment(binary, { platform }),
    });
    if (launched.error || launched.status !== 0) throw new Error("COPILOT_SETUP_LAUNCH_FAILED");
    const deadline = Math.min(expiresAt, Date.now() + (options.setupTimeoutMs ?? 120000));
    while (Date.now() < deadline) {
      const result = await json(path.join(directory, "response.json"));
      if (result?.id === id) {
        if (validSecret(result.secretReference)) {
          await privateWrite(files.credential, { keyHash: hash(key), secretReference: result.secretReference });
          return result.secretReference;
        }
        const errors = { "copilot-disabled": "DISABLED", "ai-disabled": "DISABLED", dirty: "DIRTY", unsupported: "UNSUPPORTED", "profile-mismatch": "PROFILE" };
        throw new Error(`COPILOT_SETUP_${errors[result.error] || "FAILED"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("COPILOT_SETUP_TIMEOUT");
  } finally { await cleanupRun(directory); }
}

function baseUrl(options = {}) {
  return `http://127.0.0.1:${options.port || require("./config").getServerPort()}/v1`;
}
function selection({ apiKey, model }) {
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]+$/.test(apiKey)) throw new Error("A valid proxy client key is required.");
  if (typeof model !== "string" || !model.trim() || model.length > 256 || /[\x00-\x1f]/.test(model)) throw new Error("A model is required.");
}
function owned(client, value) {
  return client === "cli" ? Object.fromEntries(fields.filter((key) => key in value).map((key) => [key, value[key]])) : value.filter(managedGroup);
}
async function backupCurrent(files, text) {
  if (text === null) return;
  await ensureDir(path.join(files.state, "backups"));
  await fs.writeFile(path.join(files.state, "backups", `${Date.now()}-${crypto.randomUUID()}.json`), text, { mode: 0o600 });
  const names = (await fs.readdir(path.join(files.state, "backups"))).sort().reverse();
  for (const name of names.slice(20)) await fs.unlink(path.join(files.state, "backups", name));
}
async function connect(client, values, options = {}) {
  selection(values);
  const files = locations(client, options);
  return serialized(files.target, async () => {
    const initialText = await optionalText(files.target);
    parse(client, initialText);
    const binary = await executable(client, options);
    // Save the first image before VS Code's native command can create the file.
    let baseline = await json(files.baseline);
    if (baseline && baseline.target !== files.target) throw new Error("Copilot backup belongs to another profile.");
    if (!baseline) {
      baseline = { target: files.target, original: initialText };
      await privateWrite(files.baseline, baseline);
    }
    await backupCurrent(files, initialText);
    const secret = client === "vscode" ? await prepareSecret(files, values.apiKey, binary, options) : values.apiKey;
    const current = parse(client, await optionalText(files.target));
    const base = baseUrl(options);
    let next;
    if (client === "cli") next = { ...current, provider: MARKER, baseUrl: base, apiKey: secret, model: values.model.trim() };
    else {
      const group = { ...current.find(managedGroup), name: GROUP, vendor: "customendpoint", apiKey: secret,
        models: buildVscodeModels(values, base) };
      next = [...current.filter((row) => !managedGroup(row)), group];
    }
    // Journal the proposed owned fields before replacing the target so restore
    // can recover even if the process stops between these two atomic writes.
    await privateWrite(files.baseline, { ...baseline, pendingApplied: owned(client, next), pendingKeyHash: hash(values.apiKey) });
    await privateWrite(files.target, next);
    const { pendingApplied, pendingKeyHash, ...committed } = baseline;
    await privateWrite(files.baseline, { ...committed, applied: owned(client, next), keyHash: hash(values.apiKey) });
    return { configured: true, path: files.target, model: values.model.trim(), modelCount: client === "vscode" ? next.find(managedGroup).models.length : 1, command: client === "cli" ? "aitool copilot" : null };
  });
}
async function restore(client, options = {}) {
  const files = locations(client, options);
  return serialized(files.target, async () => {
    const baseline = await json(files.baseline);
    if (!(baseline?.applied || baseline?.pendingApplied) || baseline.target !== files.target) return { restored: false };
    const text = await optionalText(files.target);
    const current = parse(client, text);
    const currentOwned = JSON.stringify(owned(client, current));
    const original = parse(client, baseline.original);
    if (![baseline.applied, baseline.pendingApplied, baseline.pendingApplied ? owned(client, original) : null]
      .some((value) => value && JSON.stringify(value) === currentOwned)) {
      throw new Error("COPILOT_CONFIG_CONFLICT");
    }
    let next;
    if (client === "cli") {
      next = { ...current };
      for (const key of fields) { if (key in original) next[key] = original[key]; else delete next[key]; }
    } else next = [...current.filter((row) => !managedGroup(row)), ...original.filter(managedGroup)];
    await backupCurrent(files, text);
    if (baseline.original === null && Object.keys(next).length === 0) await fs.unlink(files.target).catch((error) => { if (error.code !== "ENOENT") throw error; });
    else await privateWrite(files.target, next);
    await fs.unlink(files.baseline);
    return { restored: true };
  });
}
async function status(options = {}) {
  const clients = [];
  const code = await resolveBinaryPath("code", options).catch(() => null);
  for (const client of ["cli", "vscode"]) {
    const files = locations(client, options);
    try {
      const value = parse(client, await optionalText(files.target));
      const baseline = await json(files.baseline);
      const entry = client === "cli" ? value.provider === MARKER ? value : null : value.find(managedGroup);
      clients.push({ client, installed: client === "vscode" ? Boolean(code) : undefined, path: files.target, configured: !!entry, canRestore: !!(baseline?.applied || baseline?.pendingApplied),
        model: client === "cli" ? entry?.model || null : entry?.models?.[0]?.id || null,
        modelCount: client === "cli" ? entry ? 1 : 0 : entry?.models?.length || 0,
        keyHash: JSON.stringify(owned(client, value)) === JSON.stringify(baseline?.pendingApplied)
          ? baseline?.pendingKeyHash || null : baseline?.keyHash || null });
    } catch { clients.push({ client, path: files.target, configured: false, canRestore: false, error: "COPILOT_CONFIG_INVALID" }); }
  }
  return clients;
}
async function directModelCatalog(url, key) {
  // node:http bypasses environment/global outbound proxy dispatchers. This
  // client key is sent only to the fixed loopback endpoint, with no redirects.
  return new Promise((resolve, reject) => {
    const unavailable = () => new Error("Copilot model catalog is unavailable. Check the proxy and client key.");
    const request = require("node:http").get(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(unavailable()); return; }
      let text = "";
      let size = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > 8 * 1024 * 1024) { response.destroy(); reject(unavailable()); return; }
        text += chunk;
      });
      response.on("error", () => reject(unavailable()));
      response.on("end", () => {
        try { resolve(JSON.parse(text)); } catch { reject(unavailable()); }
      });
    });
    request.on("error", () => reject(unavailable()));
  });
}
async function models(values, options = {}) {
  return (await modelCatalog(values, options)).map((row) => row.id);
}
async function modelCatalog(values, options = {}) {
  selection({ ...values, model: "catalog" });
  const result = await directModelCatalog(`${baseUrl(options)}/models`, values.apiKey);
  const pricing = require("./pricing");
  const metadata = (await pricing.loadPricingStore(options.pricingPath || require("./paths").pricingPath))?.models || {};
  const seen = new Set();
  return (Array.isArray(result?.data) ? result.data : []).flatMap((row) => {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id || id.length > 256 || /[\x00-\x1f]/.test(id) || seen.has(id)) return [];
    seen.add(id);
    const fallback = pricing.findPricing(metadata, id) || {};
    return [{ id, contextWindow: row.context_window ?? row.contextWindow ?? fallback.contextWindow,
      inputModalities: row.input_modalities ?? row.inputModalities ?? fallback.inputModalities,
      maxOutputTokens: row.max_output_tokens ?? row.maxOutputTokens ?? fallback.maxOutputTokens }];
  });
}

function buildVscodeModels(values, base, metadata) {
  const pricing = require("./pricing");
  const known = metadata || {};
  const catalog = Array.isArray(values.models) ? values.models : [];
  const ids = [...new Set([values.model.trim(), ...catalog.map((row) => row.id)].filter((id) => typeof id === "string" && id.trim()))];
  return ids.map((id) => {
    const row = catalog.find((row) => row.id === id) || {};
    const fallback = pricing.findPricing(known, id) || {};
    const window = row.contextWindow ?? (id === values.model.trim() ? values.contextWindow : undefined) ?? fallback.contextWindow;
    const contextWindow = Number.isSafeInteger(window) && window > 1 ? Math.min(window, 10000000) : 128000;
    const modalities = row.inputModalities ?? fallback.inputModalities;
    const vision = Array.isArray(modalities) && modalities.length ? modalities.some((value) => String(value).toLowerCase() === "image")
      : id === values.model.trim() && typeof values.vision === "boolean" ? values.vision : false;
    const output = row.maxOutputTokens ?? fallback.maxOutputTokens;
    const maxOutputTokens = Math.min(Number.isSafeInteger(output) && output > 0 ? output : 16384, Math.floor(contextWindow / 2));
    return { id, name: id, url: `${base}/chat/completions`, apiType: "chat-completions", toolCalling: true, vision, contextWindow, maxOutputTokens };
  });
}
function cliEnvironment(connection, binary, options = {}) {
  const env = resolvedCliEnvironment(binary, options);
  for (const key of ["BEARER_TOKEN", "API_KEY_COMMAND", "HEADERS", "MODEL_ID", "WIRE_MODEL", "TRANSPORT"]) delete env[`COPILOT_PROVIDER_${key}`];
  return { ...env, COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_WIRE_API: "completions",
    COPILOT_PROVIDER_BASE_URL: connection.baseUrl, COPILOT_PROVIDER_API_KEY: connection.apiKey, COPILOT_MODEL: connection.model };
}
async function launch(args, options = {}) {
  const connection = parse("cli", await optionalText(locations("cli", options).target));
  if (connection.provider !== MARKER) throw new Error("Connect GitHub Copilot CLI in the proxy dashboard first.");
  selection(connection);
  const url = new URL(connection.baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1" || url.username || url.password) throw new Error("Invalid local Copilot endpoint.");
  const binary = await executable("cli", options);
  const env = cliEnvironment(connection, binary, options);
  const platform = options.platform || process.platform;
  let command = binary;
  let forwarded = args;
  if (platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
    // Resolve npm's fixed launcher target and invoke it directly. User arguments
    // never pass through cmd.exe, whose metacharacter expansion would corrupt
    // prompts and could execute an additional command.
    const shim = await fs.readFile(binary, "utf8");
    const match = /"%dp0%[\\/]([^"\r\n]+\.(?:[cm]?js|exe))"\s+%\*/i.exec(shim);
    if (!match) throw new Error("Unsupported Copilot CLI launcher.");
    const target = path.resolve(path.dirname(binary), ...match[1].split(/[\\/]/));
    const relative = path.relative(path.dirname(binary), target);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !(await fs.stat(target)).isFile()) throw new Error("Invalid Copilot CLI launcher.");
    if (/\.exe$/i.test(target)) command = target;
    else {
      const siblingNode = path.join(path.dirname(binary), "node.exe");
      command = (await fs.stat(siblingNode).catch(() => null))?.isFile() ? siblingNode : process.execPath;
      forwarded = [target, ...args];
    }
  }
  const child = (options.spawn || require("node:child_process").spawn)(command, forwarded, {
    env, stdio: "inherit", shell: false,
  });
  return new Promise((resolve, reject) => { child.once("error", () => reject(new Error("Failed to start Copilot CLI."))); child.once("exit", (code) => resolve(code ?? 1)); });
}
module.exports = { locations, connect, restore, status, models, modelCatalog, buildVscodeModels, launch, cliEnvironment, validSecret };
