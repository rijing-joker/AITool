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
//   universalProviders: [UniversalProvider],  // cross-app shared credentials
//   settings: {
//     visibleApps: { claude: true, ..., mcode: true },  // which agent tabs the dashboard shows
//   },
// }
//
// Provider: { id, name, category: "official"|"custom", settingsConfig, notes,
//             createdAt, updatedAt }
// UniversalProvider: { id, name, providerType, apps: {claude,codex,gemini},
//                      baseUrl, apiKey, models, websiteUrl, notes, icon,
//                      iconColor, meta?, createdAt, updatedAt, sortIndex }

const additive = require("./additive");

const SUPPORTED_APPS = ["claude", "codex", "gemini", "opencode", "openclaw", "mcode", "hermes", "pi", "grokbuild"];
const PROVIDER_CATEGORIES = ["official", "custom"];

// Apps a universal provider (cc-switch's UniversalProvider) can project into.
// The fork's other agent tabs are outside upstream's universal scope.
const UNIVERSAL_APPS = ["claude", "codex", "gemini"];
const UNIVERSAL_PROVIDER_TYPES = ["newapi", "custom_gateway", "custom"];

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
  return { version: 1, apps, universalProviders: [], settings: { visibleApps: defaultVisibleApps() } };
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
  const config = require("./codex-provider-config").normalizeCodexProviderConfig(
    settingsConfig.config, { official: provider.category === "official" },
  );
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
  next.universalProviders = Array.isArray(store.universalProviders)
    ? store.universalProviders.filter((p) => p && typeof p === "object")
    : [];
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
    normalized.universalProviders = Array.isArray(store.universalProviders)
      ? store.universalProviders.filter((p) => p && typeof p === "object")
      : [];
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
    return { auth: auth || null, config: config || {} };
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
  const normalizedSettings = sanitizeSettingsConfig(app, settingsConfig || {}, trimmedName);
  if (app === "codex") {
    normalizedSettings.config = require("./codex-provider-config").normalizeCodexProviderConfig(
      normalizedSettings.config, { official: normalizedCategory === "official" },
    );
  }
  return {
    name: trimmedName,
    category: normalizedCategory,
    settingsConfig: normalizedSettings,
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
// NOT inherited. Additive wrappers carry their slotKey inside settingsConfig,
// so the clone must be re-keyed — sanitizeWrapper only fills a missing
// slotKey, and keeping the source's would make the copy write into the very
// slot the source card still claims.
async function duplicateProvider(app, id) {
  if (!isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const state = await listProviders(app);
  const source = state.providers.find((p) => p.id === id);
  if (!source) throw new Error(`Provider not found: ${id}`);
  const settingsConfig = JSON.parse(JSON.stringify(source.settingsConfig || {}));
  if (additive.isAdditiveApp(app)) {
    // Derive the copy's slot from "<name> copy", uniquified against the
    // existing cards (upstream validates the cloned key against existing and
    // live config keys before writing).
    const taken = new Set(
      state.providers
        .map((p) => (p.settingsConfig && typeof p.settingsConfig.slotKey === "string" ? p.settingsConfig.slotKey : ""))
        .filter(Boolean),
    );
    const base = additive.normalizeSlotKey(`${source.name} copy`, app);
    let slotKey = base;
    for (let n = 2; taken.has(slotKey); n += 1) {
      const suffix = `-${n}`;
      slotKey = `${base.slice(0, Math.max(1, 40 - suffix.length))}${suffix}`;
    }
    // OpenCode/OpenClaw pointers include the owning provider key. Only
    // re-key that prefix; model ids may themselves contain slashes, and a
    // deliberate reference to another provider must remain unchanged.
    const sourceSlot = settingsConfig.slotKey;
    if ((app === "opencode" || app === "openclaw") && sourceSlot
      && typeof settingsConfig.modelId === "string"
      && settingsConfig.modelId.startsWith(`${sourceSlot}/`)) {
      settingsConfig.modelId = slotKey + settingsConfig.modelId.slice(sourceSlot.length);
    }
    settingsConfig.slotKey = slotKey;
  }
  return createProvider(app, {
    name: `${source.name} copy`,
    category: source.category,
    settingsConfig,
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

// ---------------------------------------------------------------------------
// Universal providers (cc-switch's universal_providers blob, kept in the same
// JSON SSOT): one shared credential projected into per-app child providers by
// syncUniversalToApps (see universal.js). The store only owns persistence.
// ---------------------------------------------------------------------------

function sanitizeUniversalModels(value) {
  const models = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const out = {};
  if (models.claude && typeof models.claude === "object" && !Array.isArray(models.claude)) {
    const c = models.claude;
    out.claude = {
      model: String(c.model || "").slice(0, 200),
      haikuModel: String(c.haikuModel || "").slice(0, 200),
      sonnetModel: String(c.sonnetModel || "").slice(0, 200),
      opusModel: String(c.opusModel || "").slice(0, 200),
    };
  }
  if (models.codex && typeof models.codex === "object" && !Array.isArray(models.codex)) {
    out.codex = {
      model: String(models.codex.model || "").slice(0, 200),
      reasoningEffort: String(models.codex.reasoningEffort || "").slice(0, 32),
    };
  }
  if (models.gemini && typeof models.gemini === "object" && !Array.isArray(models.gemini)) {
    out.gemini = { model: String(models.gemini.model || "").slice(0, 200) };
  }
  return out;
}

function sanitizeUniversalFields({ name, providerType, apps, baseUrl, apiKey, models, websiteUrl, notes, icon, iconColor, meta }) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("Provider name is required");
  if (trimmedName.length > 100) throw new Error("Provider name is too long");
  const normalizedApps = {};
  for (const app of UNIVERSAL_APPS) normalizedApps[app] = Boolean(apps?.[app]);
  return {
    name: trimmedName,
    providerType: UNIVERSAL_PROVIDER_TYPES.includes(providerType) ? providerType : "custom",
    apps: normalizedApps,
    baseUrl: String(baseUrl || "").trim().slice(0, 500),
    apiKey: String(apiKey || "").slice(0, 2000),
    models: sanitizeUniversalModels(models),
    websiteUrl: sanitizeWebsiteUrl(websiteUrl),
    notes: String(notes || "").slice(0, 2000),
    icon: sanitizeIcon(icon),
    iconColor: sanitizeIconColor(iconColor),
    meta: sanitizeMeta(meta),
  };
}

async function listUniversalProviders() {
  const store = await readStore();
  return store.universalProviders
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => {
      const sa = Number.isFinite(a.provider.sortIndex) ? a.provider.sortIndex : a.index;
      const sb = Number.isFinite(b.provider.sortIndex) ? b.provider.sortIndex : b.index;
      return sa - sb;
    })
    .map((entry) => entry.provider);
}

async function getUniversalProvider(id) {
  const providers = await listUniversalProviders();
  return providers.find((p) => p.id === id) || null;
}

// Create (no id) or patch (id) one universal provider. The patch merges onto
// the existing record before sanitizing, so partial payloads keep their other
// fields. Position follows sortIndex like per-app providers; updates keep the
// existing position.
async function upsertUniversalProvider(fields) {
  const existing = fields.id ? await getUniversalProvider(fields.id) : null;
  const clean = sanitizeUniversalFields(existing ? { ...existing, ...fields } : fields);
  const now = new Date().toISOString();
  let saved = null;
  await mutateStore((store) => {
    const providers = store.universalProviders.slice();
    const index = fields.id ? providers.findIndex((p) => p.id === fields.id) : -1;
    if (index === -1) {
      saved = {
        id: `u_${crypto.randomUUID()}`,
        ...clean,
        createdAt: now,
        updatedAt: now,
        sortIndex: Number.isFinite(fields.sortIndex) ? fields.sortIndex : providers.length,
      };
      providers.push(saved);
    } else {
      const current = providers[index];
      saved = { ...current, ...clean, createdAt: current.createdAt, updatedAt: now };
      providers[index] = saved;
    }
    store.universalProviders = providers;
    return store;
  });
  return saved;
}

async function deleteUniversalProvider(id) {
  let removed = null;
  await mutateStore((store) => {
    const index = store.universalProviders.findIndex((p) => p.id === id);
    if (index === -1) return store;
    removed = store.universalProviders[index];
    store.universalProviders = store.universalProviders.filter((p) => p.id !== id);
    return store;
  });
  return removed;
}

// Deterministic save for a generated universal child: creates with the fixed
// id or updates in place, preserving position (unlike createProvider, which
// always mints an id and appends).
async function putUniversalChildProvider(app, fields) {
  if (!isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const clean = sanitizeProviderFields(app, fields);
  const now = new Date().toISOString();
  await mutateStore((store) => {
    const providers = store.apps[app].providers;
    const index = providers.findIndex((p) => p.id === fields.id);
    if (index === -1) {
      providers.push({
        id: fields.id,
        ...clean,
        createdAt: fields.createdAt || now,
        updatedAt: now,
        sortIndex: Number.isFinite(fields.sortIndex) ? fields.sortIndex : providers.length,
      });
    } else {
      providers[index] = { ...providers[index], ...clean, updatedAt: now };
    }
    return store;
  });
  return getProvider(app, fields.id);
}

module.exports = {
  SUPPORTED_APPS,
  UNIVERSAL_APPS,
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
  listUniversalProviders,
  getUniversalProvider,
  upsertUniversalProvider,
  deleteUniversalProvider,
  putUniversalChildProvider,
};
