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
// }
//
// Provider: { id, name, category: "official"|"custom", settingsConfig, notes,
//             createdAt, updatedAt }

const SUPPORTED_APPS = ["claude", "codex", "gemini"];
const PROVIDER_CATEGORIES = ["official", "custom"];

function emptyApp() {
  return { current: null, providers: [] };
}

function defaultStore() {
  const apps = {};
  for (const app of SUPPORTED_APPS) apps[app] = emptyApp();
  return { version: 1, apps };
}

function isSupportedApp(app) {
  return SUPPORTED_APPS.includes(app);
}

function newProviderId() {
  return `p_${crypto.randomUUID()}`;
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
      providers: Array.isArray(saved.providers) ? saved.providers.filter((p) => p && typeof p === "object") : [],
    };
  }
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
          providers: Array.isArray(saved.providers) ? saved.providers : [],
        };
      }
    }
    const next = update(normalized);
    return next === undefined ? normalized : next;
  });
}

function sanitizeSettingsConfig(app, settingsConfig) {
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
    return { auth: auth || null, config: config || {} };
  }
  throw new Error(`Unsupported app: ${app}`);
}

function sanitizeProviderFields(app, { name, category, settingsConfig, notes }) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("Provider name is required");
  if (trimmedName.length > 100) throw new Error("Provider name is too long");
  const normalizedCategory = PROVIDER_CATEGORIES.includes(category) ? category : "custom";
  return {
    name: trimmedName,
    category: normalizedCategory,
    settingsConfig: sanitizeSettingsConfig(app, settingsConfig || {}),
    notes: String(notes || "").slice(0, 2000),
  };
}

async function listProviders(app) {
  if (!isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const store = await readStore();
  return store.apps[app];
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

async function setCurrentProvider(app, id) {
  if (!isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  await mutateStore((store) => {
    store.apps[app].current = id;
    return store;
  });
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
  setCurrentProvider,
  sanitizeSettingsConfig,
};
