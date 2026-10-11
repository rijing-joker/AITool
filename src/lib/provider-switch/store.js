const path = require("node:path");
const crypto = require("node:crypto");
const { readJson, updateJsonLocked, ensureDir } = require("../fs");
const paths = require("./paths");

// SSOT store of provider presets, ported from cc-switch's providers table
// (SQLite) but kept as a single JSON document, matching how AiTool stores
// other feature state (buckets.json, remarks.json).
//
// Shape:
// {
//   version: 1,
//   apps: {
//     claude: { current: "p_x" | null, providers: [Provider] },
//     codex:  { ... },
//     gemini: { ... },
//   },
//   settings: {
//     visibleApps: { claude: true, ..., mcode: true },  // which agent tabs the dashboard shows
//   },
// }
//
// Provider: { id, name, category: "official"|"custom", settingsConfig, notes,
//             createdAt, updatedAt }

const additive = require("./additive");
const floor = require("./floor");

const SUPPORTED_APPS = ["claude", "codex", "gemini", "opencode", "openclaw", "mcode", "hermes", "pi", "grokbuild"];
const PROVIDER_CATEGORIES = ["official", "custom"];

function emptyApp() {
  return { current: null, providers: [] };
}

function defaultVisibleApps() {
  const visibleApps = {};
  for (const app of SUPPORTED_APPS) visibleApps[app] = true;
  return visibleApps;
}

function defaultStore() {
  const apps = {};
  for (const app of SUPPORTED_APPS) apps[app] = emptyApp();
  return { version: 1, apps, settings: { visibleApps: defaultVisibleApps() } };
}

function normalizeVisibleApps(value) {
  const visibleApps = defaultVisibleApps();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const app of SUPPORTED_APPS) {
      if (typeof value[app] === "boolean") visibleApps[app] = value[app];
    }
  }
  return visibleApps;
}

function isSupportedApp(app) {
  return SUPPORTED_APPS.includes(app);
}

function newProviderId() {
  return `p_${crypto.randomUUID()}`;
}

// Legacy Codex rows (top-level base_url/openai_base_url with no route
// selector) are folded into [model_providers.custom] on every read/write so
// the editor, model fetch and switch projection all see the modern shape
// (cc-switch 84457b510). Idempotent; prev rows converge on the next mutation.
function normalizeProviderRow(app, provider) {
  if (app !== "codex" || !provider || typeof provider !== "object") return provider;
  const settingsConfig = provider.settingsConfig;
  if (!settingsConfig || typeof settingsConfig !== "object") return provider;
  const config = floor.normalizeCodexConfig(settingsConfig.config);
  if (config === settingsConfig.config) return provider;
  return { ...provider, settingsConfig: { ...settingsConfig, config } };
}

async function readStore() {
  const store = await readJson(paths.storePath());
  if (!store || typeof store !== "object" || !store.apps) return defaultStore();
  const next = defaultStore();
  for (const app of SUPPORTED_APPS) {
    const saved = store.apps[app];
    if (!saved || typeof saved !== "object") continue;
    next.apps[app] = {
      current: typeof saved.current === "string" ? saved.current : null,
      providers: Array.isArray(saved.providers)
        ? saved.providers.filter((p) => p && typeof p === "object").map((p) => normalizeProviderRow(app, p))
        : [],
    };
  }
  next.settings = { visibleApps: normalizeVisibleApps(store.settings && store.settings.visibleApps) };
  return next;
}

async function mutateStore(update) {
  // The lock file lives next to the store; the directory must exist before
  // openLock can create it (first-ever mutation runs on a fresh install).
  await ensureDir(path.dirname(paths.storePath()));
  return updateJsonLocked(paths.storePath(), (current) => {
    const store = current && current.apps ? current : defaultStore();
    const normalized = defaultStore();
    for (const app of SUPPORTED_APPS) {
      const saved = store.apps[app];
      if (saved && typeof saved === "object") {
        normalized.apps[app] = {
          current: typeof saved.current === "string" ? saved.current : null,
          providers: Array.isArray(saved.providers) ? saved.providers.map((p) => normalizeProviderRow(app, p)) : [],
        };
      }
    }
    normalized.settings = { visibleApps: normalizeVisibleApps(store.settings && store.settings.visibleApps) };
    const next = update(normalized);
    return next === undefined ? normalized : next;
  });
}

function sanitizeSettingsConfig(app, settingsConfig, name) {
  if (!settingsConfig || typeof settingsConfig !== "object" || Array.isArray(settingsConfig)) {
    throw new Error("settingsConfig must be an object");
  }
  if (app === "claude") return settingsConfig;
  if (app === "gemini") {
    const env = settingsConfig.env;
    if (env !== undefined && (typeof env !== "object" || env === null || Array.isArray(env))) {
      throw new Error("settingsConfig.env must be an object");
    }
    return { env: env || {} };
  }
  if (app === "codex") {
    const { auth, config } = settingsConfig;
    if (auth !== undefined && auth !== null && (typeof auth !== "object" || Array.isArray(auth))) {
      throw new Error("settingsConfig.auth must be an object or null");
    }
    if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config))) {
      throw new Error("settingsConfig.config must be an object");
    }
    return { auth: auth || null, config: floor.normalizeCodexConfig(config || {}) };
  }
  if (additive.isAdditiveApp(app)) {
    // Wrapper shape { slotKey, provider, modelId? } — see additive.js. The
    // slotKey is filled from the provider name when missing.
    return additive.sanitizeWrapper(app, settingsConfig, name);
  }
  throw new Error(`Unsupported app: ${app}`);
}

function sanitizeWebsiteUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (!/^https?:\/\/\S+$/.test(url) || url.length > 500) {
    throw new Error("websiteUrl must be an http(s) URL");
  }
  return url;
}

// Free-form provider metadata (port of cc-switch's ProviderMeta, reduced to
// the keys this port consumes): apiFormat, apiKeyField, customUserAgent,
// localProxyRequestOverrides, endpointAutoSelect, isFullUrl. Unknown keys are
// preserved so the dashboard can extend it without a store migration.
function sanitizeMeta(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("meta must be an object");
  }
  // codexCatalogModels rows carry per-model base_instructions (the official
  // template alone is ~21KB), so the cap has to clear catalog-sized payloads.
  if (JSON.stringify(value).length > 256 * 1024) {
    throw new Error("meta is too large");
  }
  return value;
}

function sanitizeIcon(value) {
  return String(value || "").trim().slice(0, 48);
}

function sanitizeIconColor(value) {
  return String(value || "").trim().slice(0, 32);
}

function sanitizeProviderFields(app, { name, category, settingsConfig, notes, websiteUrl, icon, iconColor, meta }) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("Provider name is required");
  if (trimmedName.length > 100) throw new Error("Provider name is too long");
  const normalizedCategory = PROVIDER_CATEGORIES.includes(category) ? category : "custom";
  return {
    name: trimmedName,
    category: normalizedCategory,
    settingsConfig: sanitizeSettingsConfig(app, settingsConfig || {}, trimmedName),
    notes: String(notes || "").slice(0, 2000),
    websiteUrl: sanitizeWebsiteUrl(websiteUrl),
    icon: sanitizeIcon(icon),
    iconColor: sanitizeIconColor(iconColor),
    meta: sanitizeMeta(meta),
  };
}

async function listProviders(app) {
  if (!isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const store = await readStore();
  const state = store.apps[app];
  // Presentation order = sort_index (dnd reorder), falling back to creation
  // order for providers saved before sorting existed.
  const providers = state.providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => {
      const sa = Number.isFinite(a.provider.sortIndex) ? a.provider.sortIndex : a.index;
      const sb = Number.isFinite(b.provider.sortIndex) ? b.provider.sortIndex : b.index;
      return sa - sb;
    })
    .map((entry) => entry.provider);
  return { current: state.current, providers };
}

// Persist a drag-reorder: orderedIds is the full provider list in its new
// order; unknown ids are ignored and missing ids keep their relative order.
async function reorderProviders(app, orderedIds) {
  if (!isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  if (!Array.isArray(orderedIds)) throw new Error("orderedIds must be an array");
  await mutateStore((store) => {
    const providers = store.apps[app].providers;
    const rank = new Map(orderedIds.map((id, index) => [id, index]));
    const ordered = providers
      .map((provider, index) => ({
        provider,
        rank: rank.has(provider.id) ? rank.get(provider.id) : orderedIds.length + index,
      }))
      .sort((a, b) => a.rank - b.rank);
    store.apps[app].providers = ordered.map((entry, index) => ({
      ...entry.provider,
      sortIndex: index,
    }));
    return store;
  });
}

async function getProvider(app, id) {
  const state = await listProviders(app);
  return state.providers.find((p) => p.id === id) || null;
}

async function createProvider(app, fields) {
  if (!isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const clean = sanitizeProviderFields(app, fields);
  const now = new Date().toISOString();
  const provider = { id: newProviderId(), ...clean, createdAt: now, updatedAt: now };
  await mutateStore((store) => {
    // Duplicates pass their own position (right after the source,
    // cc-switch's sortIndex+1); new providers append at the end.
    provider.sortIndex = Number.isFinite(fields.sortIndex) ? fields.sortIndex : store.apps[app].providers.length;
    store.apps[app].providers.push(provider);
    return store;
  });
  return provider;
}

async function updateProvider(app, id, patch) {
  if (!isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  let updated = null;
  await mutateStore((store) => {
    const index = store.apps[app].providers.findIndex((p) => p.id === id);
    if (index === -1) return store;
    const existing = store.apps[app].providers[index];
    const merged = sanitizeProviderFields(app, {
      name: patch.name !== undefined ? patch.name : existing.name,
      category: patch.category !== undefined ? patch.category : existing.category,
      settingsConfig: patch.settingsConfig !== undefined ? patch.settingsConfig : existing.settingsConfig,
      notes: patch.notes !== undefined ? patch.notes : existing.notes,
      websiteUrl: patch.websiteUrl !== undefined ? patch.websiteUrl : existing.websiteUrl,
      icon: patch.icon !== undefined ? patch.icon : existing.icon,
      iconColor: patch.iconColor !== undefined ? patch.iconColor : existing.iconColor,
      meta: patch.meta !== undefined ? patch.meta : existing.meta,
    });
    updated = { ...existing, ...merged, updatedAt: new Date().toISOString() };
    const providers = store.apps[app].providers.slice();
    providers[index] = updated;
    store.apps[app].providers = providers;
    return store;
  });
  if (!updated) throw new Error(`Provider not found: ${id}`);
  return updated;
}

async function deleteProvider(app, id) {
  if (!isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  await mutateStore((store) => {
    const index = store.apps[app].providers.findIndex((p) => p.id === id);
    if (index === -1) return store;
    const providers = store.apps[app].providers.slice();
    providers.splice(index, 1);
    store.apps[app].providers = providers;
    if (store.apps[app].current === id) store.apps[app].current = null;
    return store;
  });
}

// Deep-copy a provider next to the original (cc-switch's duplicate): new id,
// "<name> copy", sortIndex+1, everything else cloned. The current pointer is
// NOT inherited; additive slot keys come from the name, so the copy gets its
// own slot automatically.
async function duplicateProvider(app, id) {
  if (!isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const state = await listProviders(app);
  const source = state.providers.find((p) => p.id === id);
  if (!source) throw new Error(`Provider not found: ${id}`);
  return createProvider(app, {
    name: `${source.name} copy`,
    category: source.category,
    settingsConfig: JSON.parse(JSON.stringify(source.settingsConfig || {})),
    notes: source.notes || "",
    websiteUrl: source.websiteUrl || "",
    icon: source.icon || "",
    iconColor: source.iconColor || "",
    meta: source.meta ? JSON.parse(JSON.stringify(source.meta)) : undefined,
    ...(Number.isFinite(source.sortIndex) ? { sortIndex: source.sortIndex + 1 } : {}),
  });
}

async function setCurrentProvider(app, id) {
  if (!isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  await mutateStore((store) => {
    store.apps[app].current = id;
    return store;
  });
}

// Dashboard-facing feature settings (which agent tabs are visible). At least
// one app stays visible — enforced here so a bad client cannot blank the page.
async function readVisibleApps() {
  const store = await readStore();
  return store.settings.visibleApps;
}

async function updateVisibleApps(visibleApps) {
  const next = normalizeVisibleApps(visibleApps);
  if (!Object.values(next).some(Boolean)) {
    throw new Error("At least one app must stay visible");
  }
  await mutateStore((store) => {
    store.settings.visibleApps = next;
    return store;
  });
  return next;
}

module.exports = {
  SUPPORTED_APPS,
  isSupportedApp,
  readStore,
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
  duplicateProvider,
  reorderProviders,
  setCurrentProvider,
  sanitizeProviderFields,
  sanitizeSettingsConfig,
  readVisibleApps,
  updateVisibleApps,
};
