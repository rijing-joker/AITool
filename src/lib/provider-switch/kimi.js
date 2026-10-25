"use strict";
// Kimi Code (MoonshotAI/kimi-code) native multi-provider management, ported
// from cc-switch's kimi_config.rs (e4873bc..d8983bb, MIT). Kimi keeps its
// providers and models in one ~/.kimi-code/config.toml: each provider is a
// [providers.<id>] table, each model a [models.<alias>] table referencing its
// provider by id, and default_model names a model alias. Unlike the generic
// additive apps, the two tables are linked (a provider owns the models that
// reference it), so this module owns its own projection.
//
// Official OAuth nodes (type "kimi" + a non-empty oauth.key) belong to the
// account manager (kimi-accounts.js): provider CRUD refuses to edit, remove
// or disconnect them, exactly like cc-switch.
//
// Divergence from cc-switch (documented): cc-switch edits the TOML through
// toml_edit and preserves comments; this port re-serializes the whole
// document via smol-toml after a structural edit — the same trade-off AiTool
// makes for the Grok Build TOML config. Pre-write backups always capture the
// original bytes.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { parse: tomlParse, stringify: tomlStringify } = require("smol-toml");
const { writeFileAtomic, chmod600IfPossible } = require("../fs");
const { createBackup } = require("./backup");
const { privateDirectory, privateFile } = require("./agy-fs");

const OFFICIAL_PROVIDER_ID = "managed:kimi-code";
const OFFICIAL_PROVIDER_NAME = "Kimi Official";
const PROVIDER_TYPES = new Set(["kimi", "openai", "openai_responses", "anthropic", "google-genai", "vertexai"]);
const ENV_AUTH_KEYS = ["KIMI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "VERTEXAI_API_KEY"];
// Official catalog fields re-owned by every login; user overrides and any
// other model fields survive.
const OFFICIAL_MODEL_FIELDS = ["capabilities", "support_efforts", "default_effort", "protocol", "beta_api", "adaptive_thinking"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The kimi home is KIMI_CODE_HOME when set; an explicit `home` option (as
// passed by kimi-accounts and tests) is already the kimi home itself, never
// re-suffixed; the default is ~/.kimi-code.
function homeOf({ env = process.env, home } = {}) {
  if (typeof home === "string" && home.trim()) return home;
  if (typeof home === "function") return home();
  const override = String(env.KIMI_CODE_HOME || "").trim();
  if (override) return override;
  return path.join(require("node:os").homedir(), ".kimi-code");
}

function configPathOf(options = {}) {
  return path.join(homeOf(options), "config.toml");
}

function credentialsDirOf(options = {}) {
  return path.join(homeOf(options), "credentials");
}

// A provider node is official when it speaks the kimi protocol and carries a
// file-backed OAuth credential reference (cc-switch is_official_provider).
function isOfficialProvider(node) {
  return isPlainObject(node) && node.type === "kimi" &&
    typeof node.oauth?.key === "string" && node.oauth.key.trim() !== "";
}

function officialProviderName(id, nickname) {
  const name = typeof nickname === "string" ? nickname.trim() : "";
  if (name) return `${OFFICIAL_PROVIDER_NAME} · ${name}`;
  if (id === OFFICIAL_PROVIDER_ID) return OFFICIAL_PROVIDER_NAME;
  const prefix = ["Kimi Subscription ", "Kimi 订阅 ", "Kimi "].find((marker) => id.startsWith(marker));
  if (prefix) return `${OFFICIAL_PROVIDER_NAME} · ${id.slice(prefix.length)}`;
  return `${OFFICIAL_PROVIDER_NAME} (${String(id).replace(/^kimi-code-ccs-/, "").slice(0, 8)})`;
}

// Parse + structurally validate native config text. An unparseable document
// is an error, never silently replaced.
function parseDocument(text) {
  let doc;
  try {
    doc = tomlParse(text);
  } catch {
    throw new Error("Kimi Code config.toml is not valid TOML");
  }
  if (!isPlainObject(doc)) throw new Error("Kimi Code config root must be a TOML table");
  for (const section of ["providers", "models", "services"]) {
    if (doc[section] !== undefined && !isPlainObject(doc[section])) {
      throw new Error(`Invalid Kimi Code ${section} table`);
    }
  }
  return doc;
}

function serializeDocument(doc) {
  const content = tomlStringify(doc);
  return content.endsWith("\n") ? content : `${content}\n`;
}

// Read and structurally validate the native config. A missing file is an
// empty document; an unparseable one is an error, never silently replaced.
async function readDocument(options = {}) {
  const file = configPathOf(options);
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("Cannot read Kimi Code config");
  }
  return parseDocument(text);
}

async function writeDocument(before, after, options = {}) {
  const file = configPathOf(options);
  let content;
  try {
    content = tomlStringify(after);
  } catch (error) {
    throw new Error(`Cannot serialize Kimi Code config: ${error.message}`);
  }
  // The first structural edit snapshots the original bytes; writeFileAtomic
  // is tmp+rename, so a failed write never leaves a partial file behind. The
  // document holds api_key values and OAuth references: write it 0600 from
  // creation (the tmp file inherits the mode), then re-assert on the renamed
  // file so a pre-existing 0644 file cannot survive the rename.
  await createBackup("kimi", file);
  await writeFileAtomic(file, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o600 });
  await chmod600IfPossible(file);
  return file;
}

// Native providers → rows { id, provider, models } where models carries the
// aliases that reference the provider (cc-switch get_providers).
function listNativeProviders(doc) {
  const providers = isPlainObject(doc.providers) ? doc.providers : {};
  const models = isPlainObject(doc.models) ? doc.models : {};
  const byProvider = new Map();
  for (const [key, model] of Object.entries(models)) {
    const owner = typeof model?.provider === "string" ? model.provider : null;
    if (!owner) continue;
    if (!byProvider.has(owner)) byProvider.set(owner, {});
    byProvider.get(owner)[key] = model;
  }
  return Object.entries(providers).map(([id, provider]) => ({
    id,
    provider,
    models: byProvider.get(id) || {},
  }));
}

function currentProviderKey(doc) {
  const key = typeof doc.default_model === "string" ? doc.default_model : "";
  const owner = key && isPlainObject(doc.models) ? doc.models[key]?.provider : null;
  return typeof owner === "string" ? owner : null;
}

// Validation ported from cc-switch validate_provider: shape only, so Kimi's
// evolving capability vocabulary passes through.
function validateProviderRow(id, row) {
  if (!id || typeof id !== "string" || id.trim() === "" || /[\x00-\x1f]/.test(id)) {
    throw new Error("Enter a Kimi Code provider key");
  }
  const provider = isPlainObject(row?.provider) ? row.provider : null;
  if (!provider || !PROVIDER_TYPES.has(provider.type)) {
    throw new Error("Select a supported Kimi Code provider type");
  }
  if (provider.base_url !== undefined) {
    let parsed;
    try {
      parsed = new URL(provider.base_url);
    } catch {
      parsed = null;
    }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error("Enter a valid Kimi Code endpoint URL");
    }
  }
  const hasApiKey = typeof provider.api_key === "string" && provider.api_key.trim() !== "";
  const hasOauth = typeof provider.oauth?.key === "string" && provider.oauth.key !== "";
  const hasKeyEnv = typeof provider.api_key_env === "string" && provider.api_key_env.trim() !== "";
  const hasEnvAuth = isPlainObject(provider.env) && ENV_AUTH_KEYS.some((key) => typeof provider.env[key] === "string" && provider.env[key].trim() !== "");
  if (!hasApiKey && !hasOauth && !hasKeyEnv && !hasEnvAuth) {
    throw new Error("Enter an API key or keep the existing Kimi OAuth reference");
  }
  if (hasKeyEnv && (hasOauth || hasApiKey)) {
    throw new Error("api_key_env cannot be combined with api_key or OAuth");
  }
  const models = isPlainObject(row?.models) ? row.models : null;
  if (!models || Object.keys(models).length === 0) throw new Error("Add at least one Kimi Code model");
  for (const [key, model] of Object.entries(models)) {
    if (!key.trim() || typeof model?.model !== "string" || model.model.trim() === "" ||
      !(Number.isFinite(model.max_context_size) && model.max_context_size > 0) ||
      (model.provider !== undefined && model.provider !== id)) {
      throw new Error("Kimi Code models need a key, model ID, positive context size and matching provider");
    }
    for (const pointer of [model.capabilities, model.overrides?.capabilities]) {
      if (pointer !== undefined && (!Array.isArray(pointer) || pointer.some((cap) => typeof cap !== "string"))) {
        throw new Error("Invalid Kimi Code model capabilities");
      }
    }
  }
  return true;
}

function modelsOfProvider(doc, id) {
  const models = isPlainObject(doc.models) ? doc.models : {};
  return Object.fromEntries(Object.entries(models).filter(([, model]) => model?.provider === id));
}

// Refuse to remove a provider whose models are still referenced by the
// conversation default, the secondary agent pool, or tool services
// (cc-switch apply_provider's in-use checks).
function assertRemovable(doc, id) {
  if (currentProviderKey(doc) === id) {
    throw new Error("This provider is in use; switch to another provider before removing it");
  }
  const owned = new Set(Object.keys(modelsOfProvider(doc, id)));
  const secondary = doc.secondary_model;
  for (const field of ["default_model", ...(isPlainObject(secondary) ? [secondary.default_model] : [])]) {
    if (typeof field === "string" && owned.has(field)) {
      throw new Error("A model of this provider is still selected in Kimi Code; change it there first");
    }
  }
}

// Apply a provider row (config = null removes). Protects official nodes,
// model-key collisions across providers and in-use models on removal.
function applyProvider(doc, id, config) {
  const next = structuredClone(doc);
  const providers = next.providers && isPlainObject(next.providers) ? next.providers : (next.providers = {});
  const models = next.models && isPlainObject(next.models) ? next.models : (next.models = {});
  const existing = providers[id];
  if (isOfficialProvider(existing)) {
    throw new Error("Kimi official accounts are managed in the account center");
  }
  if (config === null) {
    assertRemovable(next, id);
    delete providers[id];
    for (const key of Object.keys(modelsOfProvider(next, id))) delete models[key];
    return next;
  }
  // An official-shaped node handed to provider CRUD would make the account
  // manager treat the caller's endpoint as an official host. Only the account
  // manager (saveOauthLogin) writes official nodes — it never passes through
  // here.
  if (isOfficialProvider(config.provider)) {
    throw new Error("Kimi official accounts are managed in the account center");
  }
  validateProviderRow(id, config);
  if (existing !== undefined && config.create === true) {
    throw new Error(`Kimi Code provider '${id}' already exists`);
  }
  // Replace the node's models: drop stale aliases owned by this provider,
  // refuse keys that belong to another provider, keep everything else.
  const keep = modelsOfProvider(next, id);
  for (const key of Object.keys(keep)) delete models[key];
  for (const [key, model] of Object.entries(config.models)) {
    if (models[key] !== undefined) {
      throw new Error(`Kimi Code model key '${key}' belongs to another provider`);
    }
    models[key] = structuredClone(model);
  }
  providers[id] = structuredClone(config.provider);
  return next;
}

// "Set default": keep the current model when it belongs to the target
// provider, otherwise select the provider's first alias (cc-switch
// select_provider_model). ASCII-only default_model per Kimi's requirement.
function selectProviderModel(doc, id) {
  const providers = isPlainObject(doc.providers) ? doc.providers : {};
  if (!isPlainObject(providers[id])) throw new Error("Kimi Code provider not found");
  const owned = Object.keys(modelsOfProvider(doc, id)).sort();
  if (!owned.length) throw new Error("This provider has no models");
  const current = typeof doc.default_model === "string" && isPlainObject(doc.models) ? doc.models[doc.default_model] : null;
  if (!current || current.provider !== id) doc.default_model = owned[0];
  return doc;
}

// Write a provider row (add or edit) without moving default_model — the
// cc-switch "add" semantics: adding never changes the selected model unless
// no default exists.
// The pure half of setProvider: compute the post-apply document (validation,
// official-node conflicts and serialization errors all surface here) without
// touching disk, so transactional callers can stage the native patch before
// committing the SSOT row.
function stageProvider(before, id, config) {
  const after = applyProvider(before, id, { ...config, create: config.create === true });
  if (after.default_model === undefined || !isPlainObject(after.models) || after.models[after.default_model] === undefined) {
    const first = Object.keys(config.models || {})[0];
    if (first) after.default_model = first;
  }
  return after;
}

async function setProvider(id, config, options = {}) {
  const before = await readDocument(options);
  const after = stageProvider(before, id, config);
  await writeDocument(before, after, options);
  return { id };
}

async function removeProvider(id, options = {}) {
  const before = await readDocument(options);
  const after = applyProvider(before, id, null);
  await writeDocument(before, after, options);
  return { id };
}

// Switch semantics for the SSOT: write the row (if it is not already live)
// and select one of its models.
async function useProvider(id, config, options = {}) {
  const before = await readDocument(options);
  let after;
  if (config) {
    after = applyProvider(before, id, config);
  } else {
    after = structuredClone(before);
    if (!isPlainObject(after.providers?.[id])) throw new Error("Kimi Code provider not found");
  }
  selectProviderModel(after, id);
  await writeDocument(before, after, options);
  return { id, defaultModel: after.default_model };
}

// Import-from-live extraction: every native provider becomes a store row.
function extractRows(doc) {
  return listNativeProviders(doc).map((row) => ({
    id: row.id,
    name: isOfficialProvider(row.provider) ? officialProviderName(row.id, null) : row.id,
    official: isOfficialProvider(row.provider),
    settingsConfig: { slotKey: row.id, provider: row.provider, models: row.models },
  }));
}

// Provision an official login (called by kimi-accounts under its own flow):
// merges the official model catalog into the account's node, keeps user
// fields, adds missing search/fetch services, writes the credential file.
// If the credential cannot be saved, the config is restored byte for byte
// (cc-switch save_oauth_login's write_and_commit rollback).
async function saveOauthLogin({ accountId, credentialPath, credential, baseUrl, oauth, models }, options = {}) {
  const file = configPathOf(options);
  // Credentials live inside the kimi home's credentials/ directory only — a
  // caller-supplied traversal must never redirect the write.
  const home = typeof options.home === "string" && options.home ? options.home : homeOf(options);
  const credentialsRoot = path.resolve(home, "credentials");
  if (path.resolve(path.dirname(credentialPath)) !== credentialsRoot) {
    throw new Error("Invalid Kimi credential path");
  }
  const original = await fsp.readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw new Error("Cannot read Kimi Code config");
  });
  const before = original === null ? {} : (() => {
    try {
      const doc = tomlParse(original);
      if (!isPlainObject(doc)) throw new Error("root");
      return doc;
    } catch {
      throw new Error("Kimi Code config.toml is not valid TOML");
    }
  })();
  const after = structuredClone(before);
  for (const section of ["providers", "models", "services"]) {
    if (after[section] === undefined) after[section] = {};
  }
  const mergedModels = {};
  for (const [key, model] of Object.entries(models)) {
    const prior = isPlainObject(after.models[key]) ? after.models[key] : {};
    if (typeof prior.provider === "string" && prior.provider !== accountId) {
      throw new Error(`Kimi Code model key '${key}' belongs to another provider`);
    }
    const merged = { ...prior };
    for (const field of OFFICIAL_MODEL_FIELDS) delete merged[field];
    mergedModels[key] = { ...merged, ...structuredClone(model) };
  }
  const providers = after.providers;
  const provider = isPlainObject(providers[accountId]) ? { ...providers[accountId] } : {};
  for (const [key, value] of Object.entries({ type: "kimi", base_url: baseUrl, api_key: "", oauth })) {
    provider[key] = structuredClone(value);
  }
  validateProviderRow(accountId, { provider, models: mergedModels });
  providers[accountId] = provider;
  for (const [key, model] of Object.entries(mergedModels)) after.models[key] = model;
  if (typeof after.default_model !== "string" || after.models[after.default_model] === undefined) {
    after.default_model = Object.keys(models)[0];
  }
  for (const [name, suffix] of [["moonshot_search", "search"], ["moonshot_fetch", "fetch"]]) {
    if (after.services[name] === undefined) {
      after.services[name] = { base_url: `${baseUrl.replace(/\/$/, "")}/${suffix}`, api_key: "", oauth: structuredClone(oauth) };
    }
  }
  const restore = async () => {
    if (original === null) await fsp.unlink(file).catch(() => {});
    else await fsp.writeFile(file, original);
  };
  try {
    await writeDocument(before, after, options);
  } catch (error) {
    await restore().catch(() => {});
    throw error;
  }
  try {
    await privateDirectory(path.dirname(credentialPath), path.dirname(credentialPath));
    await privateFile(credentialPath);
    await writeFileAtomic(credentialPath, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    await chmod600IfPossible(credentialPath);
  } catch (error) {
    await restore().catch(() => {});
    throw new Error(`Cannot save Kimi Code credentials: ${error.message}`);
  }
  return { accountId };
}
// Remove an official account's node: provider + its models + credential
// references in services, repointed at Kimi's own default login first
// (cc-switch remove_oauth_account + repoint_services). The same in-use guards
// as provider removal apply: the conversation default and the secondary-model
// pool may not keep referencing the account's aliases.
async function removeOauthAccount(accountId, options = {}) {
  const before = await readDocument(options);
  if (currentProviderKey(before) === accountId) {
    throw new Error("This account is in use; switch to another account before removing it");
  }
  const after = structuredClone(before);
  const removed = isPlainObject(after.providers?.[accountId]) ? after.providers[accountId] : null;
  const removedKey = removed?.oauth?.key;
  const defaultProvider = after.providers?.[OFFICIAL_PROVIDER_ID];
  const fallback = isPlainProviderOauth(defaultProvider?.oauth) ? defaultProvider.oauth : null;
  const owned = new Set(Object.keys(modelsOfProvider(after, accountId)));
  const secondary = after.secondary_model;
  for (const field of isPlainObject(secondary) ? [secondary.default_model] : []) {
    if (typeof field === "string" && owned.has(field)) {
      throw new Error("A model of this account is still selected as Kimi Code's secondary model; change it there first");
    }
  }
  for (const key of owned) delete after.models[key];
  delete after.providers[accountId];
  if (removedKey && accountId !== OFFICIAL_PROVIDER_ID && isPlainObject(after.services)) {
    for (const service of Object.values(after.services)) {
      if (!isPlainObject(service) || service.oauth?.key !== removedKey) continue;
      // With the default login to repoint at, a kept reference would dangle
      // at a deleted credential file — drop it instead (cc-switch only ever
      // repoints, but it only removes non-default accounts when a default
      // exists; this port can remove without one).
      if (fallback) service.oauth = structuredClone(fallback);
      else delete service.oauth;
    }
  }
  await writeDocument(before, after, options);
  return { id: accountId };
}

function isPlainProviderOauth(oauth) {
  return isPlainObject(oauth) && typeof oauth.key === "string" && oauth.key !== "";
}

async function useOauthAccount(accountId, options = {}) {
  const before = await readDocument(options);
  if (!isOfficialProvider(before.providers?.[accountId])) {
    throw new Error("Kimi official account not found");
  }
  const after = selectProviderModel(structuredClone(before), accountId);
  await writeDocument(before, after, options);
  return { id: accountId, defaultModel: after.default_model };
}

// Disconnect (clear-current) semantics: drop the SSOT row's live node only
// when it still matches what the row wrote, and clear default_model first so
// the removal never trips the in-use guard. Official nodes stay — they are
// owned by the account manager.
function disconnectDocument(doc, id, wrapper) {
  const next = structuredClone(doc);
  const providers = isPlainObject(next.providers) ? next.providers : {};
  const node = providers[id];
  if (node === undefined || isOfficialProvider(node)) return next;
  if (wrapper && JSON.stringify(node) !== JSON.stringify(wrapper.provider)) return next;
  const owned = new Set(Object.keys(modelsOfProvider(next, id)));
  if (typeof next.default_model === "string" && owned.has(next.default_model)) delete next.default_model;
  delete providers[id];
  if (isPlainObject(next.models)) for (const key of owned) delete next.models[key];
  return next;
}

module.exports = {
  OFFICIAL_PROVIDER_ID,
  PROVIDER_TYPES,
  homeOf,
  configPathOf,
  credentialsDirOf,
  isOfficialProvider,
  officialProviderName,
  parseDocument,
  serializeDocument,
  readDocument,
  writeDocument,
  listNativeProviders,
  currentProviderKey,
  validateProviderRow,
  modelsOfProvider,
  applyProvider,
  stageProvider,
  selectProviderModel,
  disconnectDocument,
  setProvider,
  removeProvider,
  useProvider,
  extractRows,
  saveOauthLogin,
  removeOauthAccount,
  useOauthAccount,
};
