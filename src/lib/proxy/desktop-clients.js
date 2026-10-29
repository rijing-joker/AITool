"use strict";
// Native client configuration and GPUI keyring conventions adapted from
// yetone/magpie @ 86254d4049cb6be4a2ccdab02edf0bd59860c603 (MIT).
// Attribution/license: extensions/LICENSE.magpie.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const jsonc = require("jsonc-parser");
const { writeFileAtomic, withFileLock } = require("../fs");
const { runCommand, resolveBinaryPath } = require("../command-runner");
const CLIENTS = ["workbuddy", "workbuddy-ai", "zed"];
const ZED_PATHS = [["language_models", "openai_compatible", "aitool"], ["agent", "default_model"]];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function locations(client, { home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  if (!CLIENTS.includes(client)) throw new Error("Unknown desktop client");
  const absolute = (value, fallback) => value && path.isAbsolute(value) ? value : fallback;
  const directory = client === "workbuddy" ? absolute(env.WORKBUDDY_CONFIG_DIR, path.join(home, ".workbuddy"))
    : client === "workbuddy-ai" ? path.join(home, ".workbuddy-ai")
      : absolute(env.AITOOL_ZED_CONFIG_DIR, path.join(platform === "win32" ? absolute(env.APPDATA, path.join(home, "AppData/Roaming"))
        : platform === "darwin" ? path.join(home, ".config") : absolute(env.XDG_CONFIG_HOME, path.join(home, ".config")), platform === "win32" ? "Zed" : "zed"));
  return { target: path.join(directory, client === "zed" ? "settings.json" : "models.json"), state: path.join(home, ".aitool/provider-switch/desktop-clients", `${client}.json`) };
}
async function text(file) {
  try {
    if ((await fs.stat(file)).size > 4 * 1024 * 1024) throw new Error("Desktop client configuration is too large");
    return await fs.readFile(file, "utf8");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function parse(client, raw) {
  const errors = [];
  let doc;
  try {
    const tree = jsonc.parseTree(raw || (client === "zed" ? "{}" : "[]"), errors, { allowTrailingComma: client === "zed" });
    const validate = node => {
      if (node?.type === "object") {
        const names = node.children.map(property => property.children[0].value);
        if (new Set(names).size !== names.length) throw new Error("Duplicate fields");
      }
      node?.children?.forEach(validate);
    };
    validate(tree);
    doc = client === "zed" ? jsonc.getNodeValue(tree) : JSON.parse(raw || "[]");
  } catch { throw new Error("Invalid desktop client configuration; the file was kept"); }
  if (errors.length || doc === null || typeof doc !== "object" || (client === "zed" && Array.isArray(doc))) throw new Error("Invalid desktop client configuration; the file was kept");
  if (client !== "zed" && !Array.isArray(doc) && (!Array.isArray(doc.models) || (doc.availableModels !== undefined && (!Array.isArray(doc.availableModels) || doc.availableModels.some(id => typeof id !== "string"))))) throw new Error("WorkBuddy model lists have an invalid structure");
  if (client !== "zed") {
    const rows = Array.isArray(doc) ? doc : doc.models;
    if (rows.some(row => !row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string") || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Invalid or duplicate WorkBuddy models");
  } else {
    for (const keys of ZED_PATHS) for (let i = 1; i < keys.length; i++) {
      const parent = at(doc, keys.slice(0, i));
      if (parent !== undefined && (!parent || typeof parent !== "object" || Array.isArray(parent))) throw new Error("Invalid Zed configuration section");
    }
  }
  return doc;
}
const at = (doc, keys) => keys.reduce((value, key) => value?.[key], doc);
function owned(client, doc, ids = []) {
  if (client === "zed") return ZED_PATHS.map(keys => at(doc, keys) ?? null);
  const rows = Array.isArray(doc) ? doc : doc.models;
  return { models: rows.filter(row => ids.includes(row.id)), availableModels: Array.isArray(doc.availableModels) ? doc.availableModels.filter(id => ids.includes(id)) : null };
}
async function write(file, value) { await writeFileAtomic(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function comparable(client, value) {
  if (client === "zed" || !value) return value;
  // WorkBuddy rewrites models.json itself seconds after every start (local
  // model gate) and may encrypt apiKey (WBEF1). Neither changes AiTool's
  // models, so compare vendor rows without apiKey, disabled or reasoning
  // (magpie 5e0d7c0); otherwise every restart reads as an external change.
  const ignored = ["disabled", "reasoning", ...(client === "workbuddy" || client === "workbuddy-ai" ? ["apiKey"] : [])];
  return { ...value, models: value.models.map(row => Object.fromEntries(
    Object.entries(row).filter(([key]) => !ignored.includes(key)),
  )) };
}
function matches(client, doc, value, ids) { return value !== undefined && same(comparable(client, owned(client, doc, ids)), comparable(client, value)); }
function recoverReceipt(client, doc, raw, receipt) {
  if (!receipt) return null;
  if (matches(client, doc, receipt.pending, receipt.pendingIds)) return { ...receipt, ids: receipt.pendingIds, applied: receipt.pending };
  if (matches(client, doc, receipt.applied, receipt.ids)) return receipt;
  if (receipt.applied === undefined && raw === receipt.original) return null;
  throw new Error("Desktop client configuration changed; review it before reconnecting or restoring");
}
async function backup(state, raw) {
  if (raw !== null) await write(`${state}.backup.${crypto.randomUUID()}`, raw);
  const dir = path.dirname(state), prefix = `${path.basename(state)}.backup.`;
  const files = await Promise.all((await fs.readdir(dir)).filter(name => name.startsWith(prefix)).map(async name => ({ name, time: (await fs.stat(path.join(dir, name))).mtimeMs })));
  for (const file of files.sort((a, b) => b.time - a.time).slice(20)) await fs.unlink(path.join(dir, file.name));
}

function projectBuddy(doc, values, catalog, receipt) {
  const rows = Array.isArray(doc) ? doc : doc.models;
  const ids = catalog.map(model => model.id), previousIds = receipt?.ids || [];
  const current = rows.filter(row => previousIds.includes(row.id));
  for (const row of current) {
    const expected = receipt?.applied?.models.find(item => item.id === row.id);
    // Native enable/reasoning choices survive; address/key changes conflict.
    if (expected && !same(comparable("workbuddy", { models: [row] }), comparable("workbuddy", { models: [expected] }))) throw new Error("Desktop client configuration changed outside AiTool; restore or review it first");
  }
  for (const id of ids) if (rows.some(row => row.id === id && !previousIds.includes(row.id))) throw new Error(`A user model already uses this ID: ${id}`);
  const generated = catalog.map(model => {
    const old = current.find(row => row.id === model.id);
    const context = Number.isSafeInteger(model.contextWindow) && model.contextWindow > 1 ? model.contextWindow : 128000;
    const output = Math.min(Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0 ? model.maxOutputTokens : 16384, Math.floor(context / 2));
    return { id: model.id, name: model.id, vendor: "aitool", apiKey: values.apiKey, url: `${values.baseUrl}/chat/completions`,
      maxInputTokens: context, maxOutputTokens: output, supportsToolCall: true, supportsImages: model.inputModalities?.includes("image") || false,
      supportsReasoning: model.reasoning === true, ...(old?.disabled !== undefined ? { disabled: old.disabled } : {}),
      ...(old?.reasoning !== undefined ? { reasoning: old.reasoning } : {}) };
  });
  const kept = rows.filter(row => !previousIds.includes(row.id));
  if (Array.isArray(doc)) return [...kept, ...generated];
  return { ...doc, models: [...kept, ...generated], ...(Array.isArray(doc.availableModels) ? { availableModels: [...doc.availableModels.filter(id => !previousIds.includes(id)), ...ids] } : {}) };
}

function projectZed(raw, values, catalog, receipt) {
  const doc = parse("zed", raw);
  if (!receipt && at(doc, ZED_PATHS[0]) !== undefined) throw new Error("A user Zed provider already uses the aitool name");
  if (receipt && !same(owned("zed", doc), receipt.applied)) throw new Error("Zed's AiTool provider or default model changed; review it before reconnecting");
  const native = require("./copilot").buildVscodeModels({ model: values.model, models: catalog }, values.baseUrl);
  const previousModels = at(doc, ZED_PATHS[0])?.available_models || [];
  const models = native.map(model => ({ name: model.id, display_name: model.name, max_tokens: model.contextWindow,
    max_output_tokens: model.maxOutputTokens, capabilities: { tools: model.toolCalling, images: model.vision, parallel_tool_calls: false, prompt_cache_key: false, chat_completions: true },
    ...(previousModels.find(row => row.name === model.id)?.reasoning_effort !== undefined ? { reasoning_effort: previousModels.find(row => row.name === model.id).reasoning_effort } : {}) }));
  let next = raw || "{}\n";
  for (const [keys, value] of [[ZED_PATHS[0], { api_url: values.baseUrl, available_models: models }], [ZED_PATHS[1], { provider: "aitool", model: values.model }]]) {
    next = jsonc.applyEdits(next, jsonc.modify(next, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
  }
  return next;
}

async function connect(client, values, options = {}) {
  if (!CLIENTS.includes(client) || typeof values.apiKey !== "string" || !/^[\x21-\x7e]+$/.test(values.apiKey)) throw new Error("Select a valid client key");
  const catalog = values.models?.filter(row => values.selectedModels?.includes(row.id)) || [];
  if (!catalog.length || catalog.length > 100 || !catalog.some(row => row.id === values.model)) throw new Error("Select available models and a default model");
  const files = locations(client, options);
  return withFileLock(files.target, async () => {
    const raw = await text(files.target), doc = parse(client, raw);
    const saved = await text(files.state); let receipt;
    try { receipt = saved ? JSON.parse(saved) : null; } catch { throw new Error("Invalid desktop connection recovery record"); }
    if (receipt && receipt.target !== files.target) throw new Error("Desktop client location changed; restore its previous connection first");
    receipt = recoverReceipt(client, doc, raw, receipt);
    const baseUrl = `http://127.0.0.1:${options.port || require("./config").getServerPort()}/v1`;
    const config = { ...values, baseUrl };
    const next = client === "zed" ? projectZed(raw, config, catalog, receipt) : projectBuddy(doc, config, catalog, receipt);
    const ids = catalog.map(row => row.id), applied = owned(client, client === "zed" ? parse(client, next) : next, ids);
    const baseline = receipt || { target: files.target, original: raw, ids: [] };
    if (client === "zed") await saveZedCredential(baseUrl, values.apiKey, options);
    if (await text(files.target) !== raw || await text(files.state) !== saved) throw new Error("Desktop client configuration changed during setup; reload and try again");
    // Write-ahead record makes an interrupted target replacement reviewable.
    await write(files.state, { ...baseline, pending: applied, pendingIds: ids });
    await backup(files.state, raw);
    if (await text(files.target) !== raw) throw new Error("Desktop client configuration changed during setup; reload and try again");
    await write(files.target, next);
    await write(files.state, { target: files.target, original: baseline.original, ids, applied });
    return { path: files.target, modelCount: ids.length, credential: client === "zed" ? "native" : "config" };
  });
}

async function restore(client, options = {}) {
  const files = locations(client, options);
  return withFileLock(files.target, async () => {
    const saved = await text(files.state); if (!saved) return { restored: false };
    let receipt;
    try { receipt = JSON.parse(saved); } catch { throw new Error("Invalid desktop connection recovery record"); }
    if (receipt.target !== files.target) throw new Error("Desktop client location changed");
    const raw = await text(files.target), doc = parse(client, raw);
    receipt = recoverReceipt(client, doc, raw, receipt);
    if (!receipt) { await fs.unlink(files.state); return { restored: true, path: files.target }; }
    const ids = receipt.ids;
    const original = parse(client, receipt.original);
    let next;
    if (client === "zed") {
      next = raw || "{}\n";
      for (const keys of ZED_PATHS) next = jsonc.applyEdits(next, jsonc.modify(next, keys, at(original, keys), { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      // Remove only empty parents created by this connection.
      for (const keys of [["language_models", "openai_compatible"], ["language_models"], ["agent"]]) {
        const value = at(parse(client, next), keys);
        if (at(original, keys) === undefined && value && Object.keys(value).length === 0) next = jsonc.applyEdits(next, jsonc.modify(next, keys, undefined, {}));
      }
    } else {
      const rows = (Array.isArray(doc) ? doc : doc.models).filter(row => !ids.includes(row.id));
      next = Array.isArray(doc) ? rows : { ...doc, models: rows, ...(Array.isArray(doc.availableModels) ? { availableModels: doc.availableModels.filter(id => !ids.includes(id)) } : {}) };
    }
    await backup(files.state, raw);
    if (await text(files.target) !== raw) throw new Error("Desktop client configuration changed during restore; reload and try again");
    const result = client === "zed" ? parse(client, next) : next;
    if (receipt.original === null && (Array.isArray(result) ? !result.length : !Object.keys(result).length)) await fs.rm(files.target, { force: true });
    else await write(files.target, next);
    await fs.unlink(files.state);
    return { restored: true, path: files.target };
  });
}

async function status(options = {}) {
  return Promise.all(CLIENTS.map(async client => {
    const files = locations(client, options);
    try {
      const raw = await text(files.target), doc = parse(client, raw), saved = await text(files.state), receipt = saved ? JSON.parse(saved) : null;
      return { client, path: files.target, configured: !!receipt && receipt.target === files.target && (matches(client, doc, receipt.pending, receipt.pendingIds) || matches(client, doc, receipt.applied, receipt.ids)), canRestore: !!receipt,
        installed: raw !== null, modelCount: receipt?.ids?.length || 0 };
    } catch { return { client, path: files.target, configured: false, canRestore: false, error: "Invalid configuration" }; }
  }));
}

async function saveZedCredential(url, key, options) {
  if (options.saveCredential) return options.saveCredential(url, key);
  const platform = options.platform || process.platform;
  let command, args, input;
  if (platform === "linux" || platform === "freebsd") {
    command = await resolveBinaryPath("secret-tool", options);
    args = ["store", "--label=zed-github-account", "url", url, "username", "Bearer"]; input = key;
  } else if (platform === "darwin") {
    command = "/usr/bin/security"; args = ["-i"];
    const quote = value => '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    // Interactive security reads its command from stdin; the key never
    // appears in a process argument or generated script file.
    const home = options.home || os.homedir();
    const candidates = options.zedAppPath ? [options.zedAppPath] : [path.join(home, "Applications/Zed.app"), path.join(home, "Applications/Zed Preview.app"), "/Applications/Zed.app", "/Applications/Zed Preview.app"];
    let bundle;
    for (const candidate of candidates) if (path.isAbsolute(candidate) && candidate.endsWith(".app") && (await fs.stat(candidate).catch(() => null))?.isDirectory()) { bundle = candidate; break; }
    if (!bundle) throw new Error("Find or install Zed.app before connecting its native keyring");
    input = `add-internet-password -U -T ${quote(bundle)} -T /usr/bin/security -s ${quote(url)} -a Bearer -w ${quote(key)}\nquit\n`;
  } else if (platform === "win32") {
    command = "powershell.exe"; args = ["-NoProfile", "-NonInteractive", "-File", path.join(__dirname, "resources/zed-credential.ps1")]; input = JSON.stringify({ url, key });
  } else throw new Error("Zed native credential storage is unsupported on this platform");
  if (!command) throw new Error("Install secret-tool and unlock the Secret Service keyring to connect Zed");
  const result = await runCommand(options.commandRunner, command, args, { input, timeout: 60000, maxBuffer: 32768, windowsHide: true });
  if (result.error || result.status !== 0 || (platform === "darwin" && /(?:error|failed|SecKeychain|could not)/i.test(result.stderr || ""))) throw new Error("Could not save Zed's credential in the native keyring");
}

module.exports = { CLIENTS, locations, connect, restore, status, projectBuddy, projectZed, saveZedCredential };
