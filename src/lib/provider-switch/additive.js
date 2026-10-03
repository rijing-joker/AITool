const YAML = require("yaml");

// Generic engine for "additive" agent apps, ported from cc-switch's additive
// mode (OpenCode, OpenClaw, MiniMax Code): the provider defines one keyed
// entry inside a map in the tool's native config (e.g. opencode.json's
// `provider.<key>`, openclaw.json's `models.providers.<key>`, MiniMax Code's
// `custom_provider.<key>`) plus, where the tool has one, a default-model
// pointer (<key>/<modelId>). Switching writes the target's entry and the
// pointer, clears the previous provider's residue (only at the value it
// wrote), and leaves every other key — including the user's own provider
// entries — untouched. Same transaction shape as the switch-mode apps in
// targets.js, but over whole parsed documents instead of line edits.
//
// Provider row shape (settingsConfig wrapper, JSON-serializable):
//   { slotKey: "<key under the container map>",
//     provider: { …the native provider entry as the tool expects it… },
//     modelId?: "<the default-model pointer value verbatim, i.e. the full
//                <key>/<modelId> ref these tools store>" }

const APP_SPECS = {
  opencode: {
    // ~/.config/opencode/opencode.json — { provider: { <key>: {npm, options, models} }, model: "<key>/<modelId>" }
    format: "json",
    slotContainer: ["provider"],
    modelPointer: ["model"],
  },
  openclaw: {
    // ~/.openclaw/openclaw.json — { models: { providers: { <key>: {baseUrl, apiKey, api, models} } }, agents: { defaults: { model: { primary: "<key>/<modelId>" } } } }
    format: "json",
    slotContainer: ["models", "providers"],
    modelPointer: ["agents", "defaults", "model", "primary"],
  },
  mcode: {
    // ~/.minimax/config.yaml — { custom_provider: { <key>: {name, kind, enabled, api, options, models} } }
    // MiniMax Code owns model selection, so there is no default-model pointer.
    format: "yaml",
    slotContainer: ["custom_provider"],
    modelPointer: null,
  },
};

const ADDITIVE_APPS = Object.keys(APP_SPECS);

function isAdditiveApp(app) {
  return Object.prototype.hasOwnProperty.call(APP_SPECS, app);
}

function specOf(app) {
  if (!isAdditiveApp(app)) throw new Error(`Unsupported additive app: ${app}`);
  return APP_SPECS[app];
}

// ---------------------------------------------------------------------------
// Wrapper (provider row) helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function wrapperOf(row) {
  const config = row && row.settingsConfig;
  if (!isPlainObject(config)) return { slotKey: "", provider: {}, modelId: "" };
  return {
    slotKey: typeof config.slotKey === "string" ? config.slotKey.trim() : "",
    provider: isPlainObject(config.provider) ? config.provider : {},
    modelId: typeof config.modelId === "string" ? config.modelId.trim() : "",
  };
}

// Slot key derived from the provider name (cc-switch lets the user pick a
// key; here it is the sanitized name — stable, unique enough per config, and
// always valid for every tool).
function normalizeSlotKey(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "custom";
}

// The default-model pointer value is stored verbatim in the wrapper's
// modelId: these tools write "<slotKey>/<modelId>" (and model ids may
// themselves contain "/", e.g. ModelScope's "ZhipuAI/GLM-5.2"), so keeping
// the whole ref avoids ambiguous re-composition.
function composedModelRef(slotKey, modelId) {
  return String(modelId || "").trim();
}

function modelIdFromRef(ref, slotKey) {
  return String(ref || "").trim();
}

// Validate + normalize an incoming wrapper. `name` fills a missing slotKey.
function sanitizeWrapper(app, settingsConfig, name) {
  specOf(app);
  const config = isPlainObject(settingsConfig) ? settingsConfig : {};
  if (!isPlainObject(config.provider)) {
    throw new Error("settingsConfig.provider must be an object holding the native provider entry");
  }
  const rawSlotKey = typeof config.slotKey === "string" ? config.slotKey.trim() : "";
  const slotKey = rawSlotKey || normalizeSlotKey(name);
  if (!/^[a-z0-9_-]{1,40}$/.test(slotKey)) {
    throw new Error("settingsConfig.slotKey must contain only letters, digits, '-' or '_'");
  }
  const modelId = typeof config.modelId === "string" ? config.modelId.trim().slice(0, 300) : "";
  return { slotKey, provider: JSON.parse(JSON.stringify(config.provider)), modelId };
}

// ---------------------------------------------------------------------------
// Document get/set/delete by path
// ---------------------------------------------------------------------------

function valueAt(doc, path) {
  let current = doc;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function setValueAt(doc, path, value) {
  let current = doc;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isPlainObject(current[path[i]])) current[path[i]] = {};
    current = current[path[i]];
  }
  const last = path[path.length - 1];
  if (value === undefined) delete current[last];
  else current[last] = value;
}

function deleteValueAt(doc, path) {
  setValueAt(doc, path, undefined);
}

// ---------------------------------------------------------------------------
// Parse / serialize the live file
// ---------------------------------------------------------------------------

function parseLive(app, text) {
  const spec = specOf(app);
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return {};
  if (spec.format === "json") {
    try {
      const doc = JSON.parse(raw);
      if (!isPlainObject(doc)) throw new Error("config root must be a JSON object");
      return doc;
    } catch (error) {
      if (/\/\//.test(raw) || /\/\*/.test(raw)) {
        throw new Error("Live config contains comments (JSONC), which cannot be edited safely here");
      }
      throw new Error(`Live config is not valid JSON: ${error.message}`);
    }
  }
  const doc = YAML.parse(raw);
  if (doc === null || doc === undefined) return {};
  if (!isPlainObject(doc)) throw new Error("Live config root must be a mapping");
  return doc;
}

function serializeLive(app, doc) {
  const spec = specOf(app);
  if (spec.format === "json") return `${JSON.stringify(doc, null, 2)}\n`;
  return YAML.stringify(doc);
}

// ---------------------------------------------------------------------------
// Projection (switch)
// ---------------------------------------------------------------------------

// The container map lives at spec.slotContainer; a malformed intermediate node
// is reset to {} (cc-switch's warn-and-reset for opencode's `provider`), so a
// broken config cannot wedge the switch.
function ensureContainer(doc, spec) {
  let current = doc;
  for (const key of spec.slotContainer) {
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key];
  }
  return current;
}

function projectAdditive(app, { prev, target, live }) {
  const spec = specOf(app);
  const doc = isPlainObject(live) ? JSON.parse(JSON.stringify(live)) : {};
  const container = ensureContainer(doc, spec);

  const prevWrapper = wrapperOf(prev);
  const targetWrapper = wrapperOf(target);
  const targetSlot = targetWrapper.slotKey || normalizeSlotKey(target && target.name);

  // Residue: the previous provider's slot entry, still at the value it wrote
  // and not re-defined by the target.
  if (prevWrapper.slotKey && prevWrapper.slotKey !== targetSlot) {
    if (
      container[prevWrapper.slotKey] !== undefined &&
      stableEqual(container[prevWrapper.slotKey], prevWrapper.provider)
    ) {
      delete container[prevWrapper.slotKey];
    }
  }
  container[targetSlot] = JSON.parse(JSON.stringify(targetWrapper.provider));

  // Default-model pointer: residue first (only at the previous provider's
  // value), then the target's ref. Tools without a pointer (mcode) skip this.
  if (spec.modelPointer) {
    const liveRef = valueAt(doc, spec.modelPointer);
    const prevRef = prevWrapper.slotKey ? composedModelRef(prevWrapper.slotKey, prevWrapper.modelId) : "";
    const targetRef = composedModelRef(targetSlot, targetWrapper.modelId);
    if (prevRef && !targetRef && liveRef !== undefined && stableEqual(liveRef, prevRef)) {
      deleteValueAt(doc, spec.modelPointer);
    }
    if (targetRef) setValueAt(doc, spec.modelPointer, targetRef);
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Import from live
// ---------------------------------------------------------------------------

// Pull the provider entry the live config currently points at: prefer the
// default-model pointer's <key> prefix, fall back to the single custom entry.
function extractAdditive(app, live) {
  const spec = specOf(app);
  if (!isPlainObject(live)) throw new Error(`No live ${app} config to import from`);
  const containerRoot = valueAt(live, spec.slotContainer);
  const container = isPlainObject(containerRoot) ? containerRoot : {};
  const entries = Object.keys(container).filter((key) => isPlainObject(container[key]));
  if (entries.length === 0) {
    throw new Error(`No provider entries found in the live ${app} config`);
  }

  let slotKey = null;
  if (spec.modelPointer) {
    const ref = String(valueAt(live, spec.modelPointer) || "").trim();
    const prefix = ref.includes("/") ? ref.slice(0, ref.indexOf("/")) : "";
    if (prefix && entries.includes(prefix)) slotKey = prefix;
  }
  if (!slotKey && entries.length === 1) slotKey = entries[0];
  if (!slotKey) {
    throw new Error(`Live ${app} config holds multiple providers; the default-model pointer does not select one`);
  }

  const provider = JSON.parse(JSON.stringify(container[slotKey]));
  const ref = spec.modelPointer ? String(valueAt(live, spec.modelPointer) || "").trim() : "";
  return sanitizeWrapper(app, { slotKey, provider, modelId: modelIdFromRef(ref, slotKey) }, slotKey);
}

// ---------------------------------------------------------------------------
// Editor save (cc-switch's plan_save, simplified for whole-document apps)
// ---------------------------------------------------------------------------

// Split the edited full config against the base the editor opened with.
// Row-owned: the provider's slot entry and the default-model pointer. Every
// other difference is a global change — container entries are diffed one key
// at a time (each entry is a whole provider), everything else recursively
// down to leaves/arrays so nested keys (openclaw's agents.*, mcp maps, …)
// diff and conflict individually.
function planSaveAdditive(app, storedRow, edited, base, slotKey) {
  const spec = specOf(app);
  if (!isPlainObject(edited) || !isPlainObject(base)) {
    throw new Error(`${app} configuration must be an object`);
  }
  const stored = wrapperOf(storedRow);
  const key = resolveSlotKey(app, storedRow, base, slotKey);
  const containerDepth = spec.slotContainer.length;

  const changes = [];
  const diffValue = (before, after, path) => {
    if (spec.modelPointer && path.length === spec.modelPointer.length && path.every((k, i) => k === spec.modelPointer[i])) {
      return; // row-owned pointer
    }
    if (path.length === containerDepth && path.every((k, i) => k === spec.slotContainer[i])) {
      const baseMap = isPlainObject(before) ? before : {};
      const editedMap = isPlainObject(after) ? after : {};
      for (const entryKey of new Set([...Object.keys(baseMap), ...Object.keys(editedMap)])) {
        if (entryKey === key) continue; // row-owned slot entry
        const was = baseMap[entryKey];
        const now = editedMap[entryKey];
        if (!stableEqual(was, now)) changes.push({ path: [...path, entryKey], before: was, after: now });
      }
      return;
    }
    if (isPlainObject(before) && isPlainObject(after)) {
      for (const childKey of new Set([...Object.keys(before), ...Object.keys(after)])) {
        diffValue(before[childKey], after[childKey], [...path, childKey]);
      }
      return;
    }
    if (!stableEqual(before, after)) changes.push({ path, before, after });
  };
  diffValue(base, edited, []);

  const baseContainer = isPlainObject(valueAt(base, spec.slotContainer)) ? valueAt(base, spec.slotContainer) : {};
  const editedContainer = isPlainObject(valueAt(edited, spec.slotContainer)) ? valueAt(edited, spec.slotContainer) : {};

  // The slot key must keep pointing at the same entry: renaming or removing
  // the key in the editor would orphan the row.
  const fragment = editedContainer[key];
  if (fragment === undefined && baseContainer[key] !== undefined) {
    throw new Error(`The provider's own entry (${spec.slotContainer.join(".")}.${key}) cannot be removed here — delete the provider instead`);
  }

  // The row owns the slot entry + pointer: the fragment comes from the edited
  // doc, the model id from the edited pointer (when the base carried one).
  let modelId = stored.modelId;
  if (spec.modelPointer) {
    const baseRef = String(valueAt(base, spec.modelPointer) ?? "").trim();
    if (baseRef) {
      const editedRef = String(valueAt(edited, spec.modelPointer) ?? "").trim();
      modelId = modelIdFromRef(editedRef, key);
    }
  }
  const rowSettings = sanitizeWrapper(app, { slotKey: key, provider: isPlainObject(fragment) ? fragment : {}, modelId }, key);

  return { rowSettings, changes };
}

// The slot key for an editor save: the explicit one from the editor view
// echo, else the stored row's, else derived from the base's default-model
// pointer, else the base's single container entry.
function resolveSlotKey(app, storedRow, base, slotKey) {
  const spec = specOf(app);
  const stored = wrapperOf(storedRow);
  if (slotKey) return slotKey;
  if (stored.slotKey) return stored.slotKey;
  if (spec.modelPointer) {
    const ref = String(valueAt(base, spec.modelPointer) || "").trim();
    const prefix = ref.includes("/") ? ref.slice(0, ref.indexOf("/")) : "";
    if (prefix && /^[a-z0-9_-]{1,40}$/.test(prefix)) return prefix;
  }
  const container = isPlainObject(valueAt(base, spec.slotContainer)) ? valueAt(base, spec.slotContainer) : {};
  const entries = Object.keys(container).filter((entryKey) => isPlainObject(container[entryKey]));
  if (entries.length === 1) return entries[0];
  throw new Error("Provider slot key is missing");
}

// Three-way check against the live file (same rule as the switch-mode apps:
// a change conflicts when live now holds a third value at its path).
function additiveConflicts(app, changes, lives) {
  const spec = specOf(app);
  const file = lives.config;
  const live = file && file.exists ? parseLive(app, file.content) : {};
  return changes.map((change) => {
    const now = valueAt(live, change.path);
    const before = change.before;
    const after = change.after;
    const conflict = !stableEqual(now, before) && !stableEqual(now, after);
    return { change, conflict };
  });
}

// Apply accepted changes to the in-memory lives map (content strings).
function applyAdditiveChanges(app, lives, changes) {
  const file = lives.config;
  const live = file && file.exists ? parseLive(app, file.content) : {};
  for (const change of changes) {
    setValueAt(live, change.path, change.after);
  }
  return { ...lives, config: { ...lives.config, content: serializeLive(app, live) } };
}

module.exports = {
  ADDITIVE_APPS,
  APP_SPECS,
  isAdditiveApp,
  specOf,
  wrapperOf,
  normalizeSlotKey,
  composedModelRef,
  modelIdFromRef,
  sanitizeWrapper,
  parseLive,
  serializeLive,
  projectAdditive,
  extractAdditive,
  planSaveAdditive,
  resolveSlotKey,
  additiveConflicts,
  applyAdditiveChanges,
};
