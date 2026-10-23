"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs/promises");
const { readJson, updateJsonLocked, ensureDir } = require("../fs");
const paths = require("./paths");
const store = require("./store");
const targets = require("./targets");
const additive = require("./additive");
const envConflict = require("./env-conflict");
const receiptPath = () => path.join(paths.providerSwitchRoot(), "projection-receipts.json");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Persist digests of projected fields, not a second plaintext config copy.
// A receipt is written only after every provider file write has succeeded.
async function record(app, provider, writes) {
  const fields = {};
  const slotKey = provider.settingsConfig?.slotKey || null;
  for (const write of writes) fields[write.file.id] = digestFields(app, write.file.id, write.content, slotKey);
  await ensureDir(paths.providerSwitchRoot());
  await updateJsonLocked(receiptPath(), current => ({ ...current, [app]: { providerId: provider.id, providerRevision: hash(provider),
    appliedAt: new Date().toISOString(), fields, slotKey } }));
}

function flatten(value, prefix = "", result = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key, result);
  } else result[prefix] = value;
  return result;
}

function ownedFields(app, fileId, content, slotKey) {
  if (app === "codex" && fileId === "auth") return JSON.parse(content || "{}");
  if (app === "claude") return targets.extractClaudeConfig(JSON.parse(content || "{}"));
  if (app === "codex") return targets.extractCodexConfig(content || "");
  if (app === "gemini") return targets.extractGeminiConfig(content || "");
  if (additive.isAdditiveApp(app)) return additive.diagnosticFields(app, additive.parseLive(app, content || "{}"), slotKey);
  return {};
}

function digestFields(app, fileId, content, slotKey) {
  return Object.fromEntries(Object.entries(flatten(ownedFields(app, fileId, content, slotKey))).map(([key, value]) => [key, hash(value)]));
}

async function readFiles(app) {
  const lives = {};
  for (const file of paths.targetFiles(app)) {
    try { const content = await fs.readFile(file.path, "utf8"); lives[file.id] = { exists: true, content }; }
    catch (error) { if (error.code !== "ENOENT") throw error; lives[file.id] = { exists: false, content: "" }; }
  }
  return lives;
}

function revisionOf(state, lives, receipt) { return hash([state, lives, receipt]); }

async function inspect(app) {
  if (!store.isSupportedApp(app)) throw new Error("Unsupported app");
  const state = await store.listProviders(app);
  const provider = state.providers.find(row => row.id === state.current);
  const lives = await readFiles(app);
  const receipt = (await readJson(receiptPath()))?.[app];
  let status = !provider ? "unwired" : !receipt || receipt.providerId !== provider.id ? "unverified" : "applied";
  const differences = [];
  for (const file of paths.targetFiles(app)) {
    if (!receipt?.fields?.[file.id]) continue;
    try {
      const actual = digestFields(app, file.id, lives[file.id].content, receipt.slotKey);
      const expected = receipt.fields[file.id];
      for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
        if (actual[key] !== expected[key]) differences.push({ fileId: file.id, path: file.path, field: key,
          change: actual[key] === undefined ? "removed" : expected[key] === undefined ? "added" : "changed" });
      }
    } catch { status = "invalid"; }
  }
  if (status === "applied" && differences.length) status = "replaced";
  if (status === "applied" && receipt.providerRevision !== hash(provider)) status = "presetChanged";
  const conflicts = envConflict.checkAppConflicts(app).map(({ varName, sourceType, sourcePath }) => ({ varName, sourceType, sourcePath }));
  return { app, status, providerId: provider?.id || null, appliedAt: receipt?.appliedAt || null, differences,
    environment: conflicts, revision: revisionOf(state, lives, receipt), files: paths.targetFiles(app).map(file => ({ id: file.id, path: file.path, exists: lives[file.id].exists })) };
}

function endpointOf(app, provider) {
  const spec = provider?.settingsConfig;
  if (!spec) return null;
  if (app === "claude") return spec.env?.ANTHROPIC_BASE_URL || spec.apiBaseUrl || null;
  if (app === "codex") return spec.config?.model_providers?.[spec.config?.model_provider]?.base_url || null;
  if (app === "gemini") return spec.env?.GOOGLE_GEMINI_BASE_URL || spec.GOOGLE_GEMINI_BASE_URL || spec.env?.CODE_ASSIST_ENDPOINT || spec.CODE_ASSIST_ENDPOINT || null;
  return spec.provider?.baseUrl || spec.provider?.baseURL || spec.provider?.base_url || spec.provider?.options?.baseURL || spec.baseUrl || spec.baseURL || spec.base_url || spec.options?.baseURL || null;
}

async function probeEndpoint(app, { signal, fetchImpl = fetch } = {}) {
  const before = await inspect(app);
  const state = await store.listProviders(app);
  const provider = state.providers.find(row => row.id === state.current);
  const address = endpointOf(app, provider);
  if (!address) return { revision: before.revision, status: "notConfigured" };
  let url;
  try { url = new URL(address); } catch { return { revision: before.revision, status: "invalid" }; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return { revision: before.revision, status: "invalid" };
  const start = Date.now();
  let result;
  try {
    // Reachability only: no credentials, inference or model enumeration.
    const response = await fetchImpl(url, { method: "HEAD", redirect: "error", signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(5000)]) });
    await response.body?.cancel();
    result = { status: "reachable", httpStatus: response.status, latencyMs: Date.now() - start };
  } catch { result = { status: signal?.aborted ? "cancelled" : "unreachable", latencyMs: Date.now() - start }; }
  if ((await inspect(app)).revision !== before.revision) return { revision: before.revision, status: "stale" };
  return { revision: before.revision, ...result };
}

module.exports = { record, inspect, readFiles, revisionOf, probeEndpoint, digestFields };
