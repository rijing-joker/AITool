const YAML = require("yaml");

// Generic engine for "additive" agent apps, ported from cc-switch's additive
// mode (OpenCode, OpenClaw, MiniMax Code, Hermes, Pi, Grok Build): the
// provider defines one keyed entry inside the tool's native config plus,
// where the tool has one, a default-model pointer. Switching writes the
// target's entry and the pointer, clears the previous provider's residue
// (only at the value it wrote), and leaves every other key — including the
// user's own provider entries — untouched. Same transaction shape as the
// switch-mode apps in targets.js, but over whole parsed documents instead of
// line edits.
//
// Provider row shape (settingsConfig wrapper, JSON-serializable):
//   { slotKey: "<key under the container>",
//     provider: { …the native provider entry as the tool expects it… },
//     modelId?: "<what the wrapper considers 'its model' — semantics per app>" }
//
// Per-app container/pointer shapes:
//   opencode  ~/.config/opencode/opencode.json  provider.<key>              + model: "<key>/<modelId>"
//   openclaw  ~/.openclaw/openclaw.json         models.providers.<key>      + agents.defaults.model.primary
//   mcode     ~/.minimax/config.yaml            custom_provider.<key>       (no pointer — MiniMax owns model selection)
//   hermes    ~/.hermes/config.yaml             custom_providers[] (list,
//                                               keyed by the entry `name`)  + model.default: <modelId>
//                                                                             + model.provider: <slotKey> (always)
//   pi        ~/.pi/agent/models.json           providers.<key>             (no pointer — membership is enabling;
//                                                                            the model rides in entry.models[0].id)
//   grokbuild ~/.grok/config.toml               model.<key> tables          + models.default: <slotKey> (the pointer
//                                                                            selects the table, not a model id)

const { parse: tomlParse, stringify: tomlStringify } = require("smol-toml");

const SLOT_KEY_PATTERN = /^[a-z0-9_-]{1,40}$/;

const APP_SPECS = {
  opencode: {
    format: "json",
    slotContainer: ["provider"],
    modelPointer: ["model"],
  },
  openclaw: {
    format: "json",
    slotContainer: ["models", "providers"],
    modelPointer: ["agents", "defaults", "model", "primary"],
  },
  mcode: {
    format: "yaml",
    slotContainer: ["custom_provider"],
    modelPointer: null,
  },
  hermes: {
    format: "yaml",
    // cc-switch's Hermes support: providers live in the `custom_providers`
    // sequence keyed by the entry's `name` field; the pointer is the
    // top-level `model:` section — `model.default` carries the model id,
    // `model.provider` names the provider and is rewritten on every switch.
    slotContainer: ["custom_providers"],
    slotContainerKind: "list",
    slotKeyField: "name",
    modelPointer: ["model", "default"],
    pointerProviderKey: ["model", "provider"],
    modelIdFrom: "entryModel",
    // Hermes v12+ keeps a second, self-managed `providers:` dict in the same
    // file; cc-switch treats those entries as read-only (edit via the Hermes
    // Web UI) and refuses writes that would touch them.
    readOnlyContainer: ["providers"],
  },
  pi: {
    format: "json",
    slotContainer: ["providers"],
    modelPointer: null,
    // Enabling a Pi provider = its entry exists in models.json; Pi itself
    // owns defaultProvider/defaultModel in settings.json, which stays
    // untouched. The wrapper's modelId mirrors entry.models[0].id.
    modelIdFrom: "modelListFirst",
    slugPattern: /^[a-z0-9-]{1,40}$/,
  },
  grokbuild: {
    format: "toml",
    // cc-switch's Grok Build: one [model."<key>"] table per provider and a
    // [models] default pointer that names the table (not a model id).
    slotContainer: ["model"],
    modelPointer: ["models", "default"],
    pointerKind: "slotKey",
    modelIdFrom: "entryModel",
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

// serde_json Value equality is key-order-insensitive; config files are
// hand-editable, so residue/change detection must be too (arrays keep their
// order — they are sequences, not maps).
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function stableEqual(a, b) {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
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

function slotKeyPattern(spec) {
  return spec.slugPattern || SLOT_KEY_PATTERN;
}

// Slot key derived from the provider name (cc-switch lets the user pick a
// key; here it is the sanitized name — stable, unique enough per config, and
// always valid for every tool). Pi keys allow only lowercase letters, digits
// and '-'; every other app also allows '_'.
function normalizeSlotKey(name, app) {
  const spec = isAdditiveApp(app) ? APP_SPECS[app] : null;
  const slug = String(name || "")
    .toLowerCase()
    .replace(spec && spec.slugPattern ? /[^a-z0-9-]+/g : /[^a-z0-9_-]+/g, "-")
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

// The pointer value a switch should leave behind. Grok Build's pointer names
// the table (the slot key); every other pointed app stores the model id.
function pointerValueOf(app, wrapper) {
  const spec = specOf(app);
  if (!spec.modelPointer) return "";
  return spec.pointerKind === "slotKey" ? wrapper.slotKey : wrapper.modelId;
}

// What the wrapper's modelId means for an app that derives it from the entry
// rather than from the pointer (cc-switch's singular-model / first-model
// rules). Returns the derived id or "" when the entry carries none.
function modelIdFromEntry(app, entry) {
  const spec = specOf(app);
  if (!spec.modelIdFrom || !isPlainObject(entry)) return "";
  if (spec.modelIdFrom === "entryModel") {
    return typeof entry.model === "string" ? entry.model.trim() : "";
  }
  // modelListFirst
  const models = Array.isArray(entry.models) ? entry.models : [];
  const first = models.find((model) => isPlainObject(model) && typeof model.id === "string" && model.id.trim());
  return first ? first.id.trim() : "";
}

// Hermes writes snake_case entries and mirrors the singular `model` field
// into the `models` catalog (cc-switch's sanitize + models-array rules, in
// the singular-model direction this dialog edits in): camelCase aliases are
// rewritten, UI markers and the legacy `api` field are stripped, and the
// entry's model id is guaranteed to be a key of `models` (empty metadata
// when none existed).
function normalizeHermesEntry(entry) {
  const aliases = {
    baseUrl: "base_url",
    apiKey: "api_key",
    apiMode: "api_mode",
    maxTokens: "max_tokens",
    contextLength: "context_length",
  };
  const cleaned = isPlainObject(entry) ? { ...entry } : {};
  for (const [from, to] of Object.entries(aliases)) {
    if (cleaned[from] !== undefined && cleaned[to] === undefined) {
      cleaned[to] = cleaned[from];
    }
    delete cleaned[from];
  }
  delete cleaned.api; // legacy field Hermes itself dropped
  delete cleaned._cc_source; // cc-switch UI markers must never reach the YAML
  delete cleaned.provider_key;

  let models = isPlainObject(cleaned.models) ? { ...cleaned.models } : null;
  const model = typeof cleaned.model === "string" ? cleaned.model.trim() : "";
  if (model) {
    models = models || {};
    if (!isPlainObject(models[model])) models[model] = {};
  } else if (models) {
    // No singular model: cc-switch derives one from the first catalog key.
    const first = Object.keys(models)[0];
    if (first) cleaned.model = first;
    else models = null;
  }
  if (models) cleaned.models = models;
  else delete cleaned.models;
  return cleaned;
}

// Validate + normalize an incoming wrapper. `name` fills a missing slotKey.
function sanitizeWrapper(app, settingsConfig, name) {
  const spec = specOf(app);
  const config = isPlainObject(settingsConfig) ? settingsConfig : {};
  if (!isPlainObject(config.provider)) {
    throw new Error("settingsConfig.provider must be an object holding the native provider entry");
  }
  const rawSlotKey = typeof config.slotKey === "string" ? config.slotKey.trim() : "";
  const slotKey = rawSlotKey || normalizeSlotKey(name, app);
  if (!slotKeyPattern(spec).test(slotKey)) {
    throw new Error(
      spec.slugPattern
        ? "settingsConfig.slotKey must contain only lowercase letters, digits or '-'"
        : "settingsConfig.slotKey must contain only letters, digits, '-' or '_'",
    );
  }
  let provider = JSON.parse(JSON.stringify(config.provider));
  if (app === "hermes") provider = normalizeHermesEntry(provider);
  let modelId = typeof config.modelId === "string" ? config.modelId.trim().slice(0, 300) : "";
  if (spec.modelIdFrom) {
    // Entry-derived apps keep the wrapper and the entry in sync (the entry
    // wins when it carries a model id).
    const derived = modelIdFromEntry(app, provider);
    if (derived) modelId = derived.slice(0, 300);
  }
  return { slotKey, provider, modelId };
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
// Container abstraction (map keyed by slot key vs. list keyed by a field)
// ---------------------------------------------------------------------------

function isListContainer(spec) {
  return spec.slotContainerKind === "list";
}

function ensureContainer(doc, spec) {
  let current = doc;
  for (const key of spec.slotContainer) {
    const want = isListContainer(spec) ? [] : {};
    if (!Array.isArray(current[key]) && !isPlainObject(current[key])) current[key] = want;
    current = current[key];
  }
  return current;
}

function slotEntriesOf(doc, spec) {
  const container = valueAt(doc, spec.slotContainer);
  if (isListContainer(spec)) {
    const list = Array.isArray(container) ? container : [];
    const field = spec.slotKeyField;
    return list
      .filter((entry) => isPlainObject(entry) && typeof entry[field] === "string" && entry[field].trim())
      .map((entry) => ({ key: entry[field].trim(), entry }));
  }
  const map = isPlainObject(container) ? container : {};
  return Object.keys(map)
    .filter((key) => isPlainObject(map[key]))
    .map((key) => ({ key, entry: map[key] }));
}

function readSlot(doc, spec, key) {
  const found = slotEntriesOf(doc, spec).find((slot) => slot.key === key);
  return found ? found.entry : undefined;
}

function writeSlot(doc, spec, key, entry) {
  const container = ensureContainer(doc, spec);
  if (isListContainer(spec)) {
    const field = spec.slotKeyField;
    const next = { ...entry, [field]: key };
    const index = container.findIndex(
      (item) => isPlainObject(item) && typeof item[field] === "string" && item[field].trim() === key,
    );
    if (index === -1) container.push(next);
    else container[index] = next;
    return;
  }
  container[key] = entry;
}

function removeSlot(doc, spec, key) {
  const container = valueAt(doc, spec.slotContainer);
  if (isListContainer(spec)) {
    if (!Array.isArray(container)) return;
    const field = spec.slotKeyField;
    const index = container.findIndex(
      (item) => isPlainObject(item) && typeof item[field] === "string" && item[field].trim() === key,
    );
    if (index !== -1) container.splice(index, 1);
    return;
  }
  if (isPlainObject(container)) delete container[key];
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
  if (spec.format === "toml") {
    try {
      const doc = tomlParse(raw);
      if (!isPlainObject(doc)) throw new Error("config root must be a TOML table");
      return doc;
    } catch (error) {
      throw new Error(`Live config is not valid TOML: ${error.message}`);
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
  if (spec.format === "toml") return tomlStringify(doc);
  return YAML.stringify(doc);
}

// ---------------------------------------------------------------------------
// Projection (switch)
// ---------------------------------------------------------------------------

// Hermes' self-managed `providers:` dict must stay untouched: refuse a switch
// whose slot key would shadow a dict-only entry (cc-switch's
// ensure_provider_writable).
function assertSlotWritable(app, doc, spec, slotKey) {
  if (!spec.readOnlyContainer) return;
  const dict = valueAt(doc, spec.readOnlyContainer);
  if (!isPlainObject(dict) || dict[slotKey] === undefined) return;
  const listed = slotEntriesOf(doc, spec).some((slot) => slot.key === slotKey);
  if (!listed) {
    throw new Error(
      `Provider '${slotKey}' is managed by Hermes' '${spec.readOnlyContainer.join(".")}:' dict — edit it in the Hermes Web UI`,
    );
  }
}

function projectAdditive(app, { prev, target, live }) {
  const spec = specOf(app);
  const doc = isPlainObject(live) ? JSON.parse(JSON.stringify(live)) : {};
  const prevWrapper = wrapperOf(prev);
  const targetWrapper = wrapperOf(target);
  const targetSlot = targetWrapper.slotKey || normalizeSlotKey(target && target.name, app);

  assertSlotWritable(app, doc, spec, targetSlot);

  // Residue: the previous provider's slot entry, still at the value it wrote
  // and not re-defined by the target.
  if (prevWrapper.slotKey && prevWrapper.slotKey !== targetSlot) {
    const prevEntry = readSlot(doc, spec, prevWrapper.slotKey);
    if (prevEntry !== undefined && stableEqual(prevEntry, prevWrapper.provider)) {
      removeSlot(doc, spec, prevWrapper.slotKey);
    }
  }
  writeSlot(doc, spec, targetSlot, JSON.parse(JSON.stringify(targetWrapper.provider)));

  // Hermes also carries a provider pointer (`model.provider`) that is
  // rewritten on every switch, independently of the model id.
  if (spec.pointerProviderKey) setValueAt(doc, spec.pointerProviderKey, targetSlot);

  // Default-model pointer: residue first (only at the previous provider's
  // value), then the target's value. Tools without a pointer (mcode, pi) skip
  // this.
  if (spec.modelPointer) {
    const liveRef = valueAt(doc, spec.modelPointer);
    const prevRef = prevWrapper.slotKey ? pointerValueOf(app, prevWrapper) : "";
    const targetRef = pointerValueOf(app, { ...targetWrapper, slotKey: targetSlot });
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

// Pull the provider entry the live config currently points at. The pointer's
// slot-key side differs per app: a "<key>/<modelId>" ref (opencode/openclaw),
// the provider name (hermes' model.provider), or the table name itself
// (grokbuild's models.default). Falls back to the single custom entry.
function extractAdditive(app, live) {
  const spec = specOf(app);
  if (!isPlainObject(live)) throw new Error(`No live ${app} config to import from`);
  const slots = slotEntriesOf(live, spec);
  const entries = slots.map((slot) => slot.key);
  if (entries.length === 0) {
    throw new Error(`No provider entries found in the live ${app} config`);
  }

  let slotKey = null;
  if (spec.pointerProviderKey) {
    const provider = String(valueAt(live, spec.pointerProviderKey) || "").trim();
    if (provider && entries.includes(provider)) slotKey = provider;
  }
  if (!slotKey && spec.modelPointer && spec.pointerKind !== "slotKey") {
    const ref = String(valueAt(live, spec.modelPointer) || "").trim();
    const prefix = ref.includes("/") ? ref.slice(0, ref.indexOf("/")) : "";
    if (prefix && entries.includes(prefix)) slotKey = prefix;
  }
  if (!slotKey && spec.modelPointer && spec.pointerKind === "slotKey") {
    const ref = String(valueAt(live, spec.modelPointer) || "").trim();
    if (ref && entries.includes(ref)) slotKey = ref;
  }
  if (!slotKey && entries.length === 1) slotKey = entries[0];
  if (!slotKey) {
    throw new Error(`Live ${app} config holds multiple providers; the default-model pointer does not select one`);
  }

  const slot = slots.find((item) => item.key === slotKey);
  const provider = JSON.parse(JSON.stringify(slot.entry));
  const modelId =
    spec.modelIdFrom || !spec.modelPointer
      ? modelIdFromEntry(app, provider)
      : modelIdFromRef(String(valueAt(live, spec.modelPointer) || "").trim(), slotKey);
  return sanitizeWrapper(app, { slotKey, provider, modelId }, slotKey);
}

// ---------------------------------------------------------------------------
// Editor save (cc-switch's plan_save, simplified for whole-document apps)
// ---------------------------------------------------------------------------

function isOwnedPath(spec, path) {
  const eq = (other) => path.length === other.length && other.every((key, index) => key === path[index]);
  if (spec.modelPointer && eq(spec.modelPointer)) return true;
  if (spec.pointerProviderKey && eq(spec.pointerProviderKey)) return true;
  return false;
}

function isUnderPath(path, prefix) {
  return path.length >= prefix.length && prefix.every((key, index) => key === path[index]);
}

// Split the edited full config against the base the editor opened with.
// Row-owned: the provider's slot entry and the default-model pointer(s).
// Every other difference is a global change — map containers are diffed one
// key at a time (each entry is a whole provider), list containers per named
// entry, everything else recursively down to leaves/arrays so nested keys
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
    if (isOwnedPath(spec, path)) return; // row-owned pointer(s)
    if (spec.readOnlyContainer && isUnderPath(path, spec.readOnlyContainer)) {
      if (!stableEqual(before, after)) {
        throw new Error(
          `Hermes' '${spec.readOnlyContainer.join(".")}:' entries are managed by the Hermes Web UI and cannot be edited here`,
        );
      }
      return;
    }
    if (path.length === containerDepth && isUnderPath(path, spec.slotContainer)) {
      if (isListContainer(spec)) {
        const field = spec.slotKeyField;
        const toMap = (value) => {
          const list = Array.isArray(value) ? value : [];
          const map = new Map();
          for (const item of list) {
            if (!isPlainObject(item)) continue;
            const name = typeof item[field] === "string" ? item[field].trim() : "";
            if (!name) {
              throw new Error(`${spec.slotContainer.join(".")} entries must carry a non-empty '${field}'`);
            }
            map.set(name, item);
          }
          return map;
        };
        const baseMap = toMap(before);
        const editedMap = toMap(after);
        for (const name of new Set([...baseMap.keys(), ...editedMap.keys()])) {
          if (name === key) continue; // row-owned slot entry
          const was = baseMap.get(name);
          const now = editedMap.get(name);
          if (!stableEqual(was, now)) {
            changes.push({ path: [...spec.slotContainer, name], before: was, after: now });
          }
        }
        return;
      }
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

  const baseFragment = readSlot(base, spec, key);
  const fragment = readSlot(edited, spec, key);

  // The slot key must keep pointing at the same entry: renaming or removing
  // the key in the editor would orphan the row.
  if (fragment === undefined && baseFragment !== undefined) {
    throw new Error(`The provider's own entry (${spec.slotContainer.join(".")}.${key}) cannot be removed here — delete the provider instead`);
  }

  // The row owns the slot entry + pointer: the fragment comes from the edited
  // doc; the model id follows the app's pointer/entry semantics.
  let modelId = stored.modelId;
  if (spec.modelIdFrom) {
    const derived = modelIdFromEntry(app, fragment);
    if (derived) modelId = derived;
  } else if (spec.modelPointer) {
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
// echo, else the stored row's, else derived from the base's pointer (per-app
// semantics), else the base's single container entry.
function resolveSlotKey(app, storedRow, base, slotKey) {
  const spec = specOf(app);
  const stored = wrapperOf(storedRow);
  const pattern = slotKeyPattern(spec);
  if (slotKey) return slotKey;
  if (stored.slotKey) return stored.slotKey;
  if (spec.pointerProviderKey) {
    const provider = String(valueAt(base, spec.pointerProviderKey) || "").trim();
    if (provider && pattern.test(provider)) return provider;
  }
  if (spec.modelPointer && spec.pointerKind !== "slotKey") {
    const ref = String(valueAt(base, spec.modelPointer) || "").trim();
    const prefix = ref.includes("/") ? ref.slice(0, ref.indexOf("/")) : "";
    if (prefix && pattern.test(prefix)) return prefix;
  }
  if (spec.modelPointer && spec.pointerKind === "slotKey") {
    const ref = String(valueAt(base, spec.modelPointer) || "").trim();
    if (ref && pattern.test(ref)) return ref;
  }
  const entries = slotEntriesOf(base, spec).map((slot) => slot.key);
  if (entries.length === 1) return entries[0];
  throw new Error("Provider slot key is missing");
}

// Three-way check against the live file (same rule as the switch-mode apps:
// a change conflicts when live now holds a third value at its path). List
// containers resolve their per-name change paths back to whole entries.
function changeValueAt(app, live, path) {
  const spec = specOf(app);
  if (isListContainer(spec) && isUnderPath(path, spec.slotContainer)) {
    const name = path[path.length - 1];
    return readSlot(live, spec, String(name));
  }
  return valueAt(live, path);
}

function additiveConflicts(app, changes, lives) {
  const file = lives.config;
  const live = file && file.exists ? parseLive(app, file.content) : {};
  return changes.map((change) => {
    const now = changeValueAt(app, live, change.path);
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
  const spec = specOf(app);
  for (const change of changes) {
    if (isListContainer(spec) && isUnderPath(change.path, spec.slotContainer)) {
      const name = String(change.path[change.path.length - 1]);
      if (change.after === undefined) removeSlot(live, spec, name);
      else {
        if (!isPlainObject(change.after)) {
          throw new Error(`Cannot write a non-object entry to ${spec.slotContainer.join(".")}`);
        }
        writeSlot(live, spec, name, JSON.parse(JSON.stringify(change.after)));
      }
      continue;
    }
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
