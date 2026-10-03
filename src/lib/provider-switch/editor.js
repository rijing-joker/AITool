const fs = require("node:fs/promises");
const store = require("./store");
const targets = require("./targets");
const paths = require("./paths");
const floor = require("./floor");
const toml = require("./toml");
const envfile = require("./envfile");
const additive = require("./additive");

// cc-switch's provider editor (services/provider/{claude,codex,gemini}_editor.rs):
//
// View — the dialog's config editor shows the FULL config file as it would
// look after switching to this provider: the same minimal-patch projection
// the switch runs, computed in memory against the current live files. Floor
// and exclusive keys come from the provider row, everything else stays live
// as-is — for the current provider, a non-current one, and the add dialog
// alike.
//
// Save — the edited full config is split: floor/exclusive keys are stored
// back into the provider row (the row's other content is preserved); every
// other change the user made against the view is a global settings change
// and is written into the live files directly (only the touched keys). When
// editing the current provider, the floor keys are also swapped into live in
// the same save (the caller re-runs the switch projection).
//
// Three-way compare — every change carries the value shown when the editor
// opened (before). If the live value has since become a third value (neither
// before nor after) the change conflicts; the caller picks a policy: refuse
// (default, report the keys), keepMine (overwrite), keepTheirs (skip the
// conflicting keys, write the rest).

function stableEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pathKey(path) {
  return path.join(".");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

// Port of cc-switch's ClaudeProjection::of: the floor top keys, the floor env
// keys and the exclusive env keys a provider owns.
function claudeProjectionOf(settingsConfig) {
  const config = settingsConfig && typeof settingsConfig === "object" ? settingsConfig : {};
  const projection = { top: {}, env: {}, exclusive: {} };
  for (const [key, value] of Object.entries(config)) {
    if (floor.isClaudeFloorTop(key)) projection.top[key] = value;
  }
  const env = isPlainObject(config.env) ? config.env : {};
  for (const [key, value] of Object.entries(env)) {
    if (floor.isClaudeFloorEnv(key)) projection.env[key] = value;
    else if (floor.CLAUDE_EXCLUSIVE_ENV.includes(key)) projection.exclusive[key] = value;
  }
  return projection;
}

// Port of cc-switch's store_into_row: the row's floor/exclusive keys are
// replaced with the edited ones; anything else the row carries (legacy
// extras) is preserved.
function claudeStoreIntoRow(storedRow, projection) {
  const row = storedRow && typeof storedRow === "object" ? JSON.parse(JSON.stringify(storedRow)) : {};
  for (const key of Object.keys(row)) {
    if (floor.isClaudeFloorTop(key)) delete row[key];
  }
  for (const [key, value] of Object.entries(projection.top)) row[key] = value;

  const rowEnv = isPlainObject(row.env) ? { ...row.env } : {};
  for (const key of Object.keys(rowEnv)) {
    if (floor.isClaudeProjectedEnv(key)) delete rowEnv[key];
  }
  for (const [key, value] of Object.entries(projection.env)) rowEnv[key] = value;
  for (const [key, value] of Object.entries(projection.exclusive)) rowEnv[key] = value;
  if (Object.keys(rowEnv).length > 0) row.env = rowEnv;
  else delete row.env;
  return row;
}

// Port of cc-switch's plan_save for Claude: split the edited full config
// against the view base. `removedFromLive` are from-live exclusive fields the
// user deleted — they become live deletions instead of row keys.
function claudePlanSave(storedRow, edited, base) {
  const shape = (doc) => isPlainObject(doc) && (!("env" in doc) || doc.env === null || doc.env === undefined || isPlainObject(doc.env));
  if (!shape(edited) || !shape(base)) {
    throw new Error("Claude configuration and its env must be JSON objects");
  }
  const stored = storedRow && typeof storedRow === "object" ? storedRow : {};
  const storedEnv = isPlainObject(stored.env) ? stored.env : {};
  const baseEnv = isPlainObject(base.env) ? base.env : {};
  const editedEnv = isPlainObject(edited.env) ? edited.env : {};

  // Exclusive fields the view carried from live (not the row): untouched
  // ones stay live-owned (not absorbed into the row), deleted ones are
  // removed from live, edited ones are absorbed into the row.
  const fromLive = Object.keys(baseEnv).filter((key) => floor.CLAUDE_EXCLUSIVE_ENV.includes(key) && !(key in storedEnv));
  const projection = claudeProjectionOf(edited);
  for (const key of fromLive) {
    if (key in editedEnv && stableEqual(baseEnv[key], editedEnv[key])) delete projection.exclusive[key];
  }
  const removedFromLive = fromLive.filter((key) => !(key in editedEnv));

  // Global changes: diff base vs edited, skipping everything the row owns.
  const changes = [];
  const diffLevel = (parent, before, after, skip) => {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (skip(key)) continue;
      const was = key in before ? before[key] : undefined;
      const now = key in after ? after[key] : undefined;
      if (stableEqual(was, now)) continue;
      changes.push({ path: parent ? [parent, key] : [key], before: was, after: now });
    }
  };
  diffLevel(null, base, edited, (key) => key === "env" || floor.isClaudeFloorTop(key));
  diffLevel("env", baseEnv, editedEnv, (key) =>
    floor.isClaudeFloorEnv(key) ||
    (floor.CLAUDE_EXCLUSIVE_ENV.includes(key) && !removedFromLive.includes(key)));

  return { rowSettings: claudeStoreIntoRow(stored, projection), changes };
}

function claudeInactiveFields(row, display) {
  const fields = [];
  const config = row && typeof row === "object" ? row : {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "env" || floor.isClaudeFloorTop(key)) continue;
    if (display[key] === undefined || !stableEqual(display[key], value)) {
      fields.push({ path: [key], value });
    }
  }
  const env = isPlainObject(config.env) ? config.env : {};
  const displayEnv = isPlainObject(display.env) ? display.env : {};
  for (const [key, value] of Object.entries(env)) {
    if (floor.isClaudeProjectedEnv(key)) continue;
    if (displayEnv[key] === undefined || !stableEqual(displayEnv[key], value)) {
      fields.push({ path: ["env", key], value });
    }
  }
  return fields;
}

function claudeReadLive(lives) {
  const live = lives.settings && lives.settings.exists ? JSON.parse(lives.settings.content) : null;
  if (live === null || typeof live !== "object" || Array.isArray(live)) {
    throw new Error("Live ~/.claude/settings.json is missing or not a JSON object");
  }
  return live;
}

function claudeConflicts(changes, lives) {
  const live = claudeReadLive(lives);
  const valueAt = (path) => {
    let current = live;
    for (const key of path) {
      if (current === null || typeof current !== "object") return undefined;
      current = current[key];
    }
    return current;
  };
  return changes.map((change) => {
    const now = valueAt(change.path);
    const conflict = !stableEqual(now, change.before) && !stableEqual(now, change.after);
    return { change, conflict };
  });
}

function claudeApply(lives, changes) {
  const live = claudeReadLive(lives);
  for (const change of changes) {
    const [head, second] = change.path;
    if (second === undefined) {
      if (change.after === undefined) delete live[head];
      else live[head] = change.after;
    } else {
      const env = isPlainObject(live[head]) ? live[head] : {};
      if (change.after === undefined) delete env[second];
      else env[second] = change.after;
      if (Object.keys(env).length > 0) live[head] = env;
      else delete live[head];
    }
  }
  return { ...lives, settings: { ...lives.settings, content: `${JSON.stringify(live, null, 2)}\n` } };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

// Global-settings entries of a parsed config.toml object (cc-switch's
// entries()): top-level scalars; every table under [model_providers] except
// the route table (whole table); one level of children for other top-level
// tables ([mcp_servers.fs] counts as one entry). Floor keys never appear.
function codexEntries(config) {
  const entries = [];
  const doc = isPlainObject(config) ? config : {};
  for (const [key, value] of Object.entries(doc)) {
    if (floor.isCodexFloorTop(key)) continue;
    if (key === "model_providers") {
      if (isPlainObject(value)) {
        for (const [id, table] of Object.entries(value)) {
          if (id === "custom") continue;
          entries.push({ path: ["model_providers", id], value: table });
        }
      } else {
        entries.push({ path: ["model_providers"], value });
      }
      continue;
    }
    if (isPlainObject(value)) {
      const hasScalarChild = Object.values(value).some((child) => !isPlainObject(child));
      if (hasScalarChild) {
        // Mixed section (scalar + sub-table children) — the line editor can
        // only rewrite it as one inline block, so it diffs as a whole.
        entries.push({ path: [key], value });
      } else {
        for (const [child, childValue] of Object.entries(value)) {
          entries.push({ path: [key, child], value: childValue });
        }
      }
    } else {
      entries.push({ path: [key], value });
    }
  }
  return entries;
}

function codexRowSettings(storedRow, edited) {
  const editedConfig = isPlainObject(edited && edited.config) ? edited.config : {};
  const auth = edited && isPlainObject(edited.auth) ? edited.auth : null;
  const authKey = auth ? String(auth.OPENAI_API_KEY ?? "").trim() : "";

  const config = {};
  for (const [key, value] of Object.entries(editedConfig)) {
    if (!floor.isCodexFloorTop(key)) continue;
    // The model catalog sidecar is meta-owned: switching re-writes the
    // pointer from provider meta, so the row never stores it.
    if (key === "model_catalog_json") continue;
    config[key] = value;
  }
  const table = editedConfig.model_providers && editedConfig.model_providers.custom;
  if (isPlainObject(table)) {
    const cleaned = { ...table };
    // Both are recomputed by the switch projection from the row key and the
    // login state; storing them would freeze today's answer into the row.
    delete cleaned.requires_openai_auth;
    if (authKey) delete cleaned.experimental_bearer_token;
    config.model_providers = { custom: cleaned };
  }
  return { auth: authKey ? { OPENAI_API_KEY: authKey } : null, config };
}

function codexPlanSave(storedRow, edited, base) {
  const editedConfig = isPlainObject(edited && edited.config) ? edited.config : {};
  const baseConfig = isPlainObject(base && base.config) ? base.config : {};
  const baseEntries = new Map(codexEntries(baseConfig).map((entry) => [pathKey(entry.path), entry]));
  const editedEntries = new Map(codexEntries(editedConfig).map((entry) => [pathKey(entry.path), entry]));
  const changes = [];
  for (const [key, entry] of baseEntries) {
    if (editedEntries.has(key)) continue;
    changes.push({ path: entry.path, before: entry.value, after: undefined });
  }
  for (const [key, entry] of editedEntries) {
    const before = baseEntries.get(key);
    if (before && stableEqual(before.value, entry.value)) continue;
    changes.push({ path: entry.path, before: before ? before.value : undefined, after: entry.value });
  }
  return { rowSettings: codexRowSettings(storedRow, edited), changes };
}

function codexInactiveFields(row) {
  const fields = [];
  const config = row && isPlainObject(row.config) ? row.config : {};
  for (const [key, value] of Object.entries(config)) {
    if (floor.isCodexFloorTop(key)) continue;
    fields.push({ path: ["config", key], value });
  }
  return fields;
}

// The three-way check needs the live file parsed in full (tables carry
// arrays/inline tables the line editor cannot round-trip).
function codexParseLive(lives) {
  const text = lives.config && lives.config.exists ? lives.config.content : "";
  const { parse } = require("smol-toml");
  return parse(text || "");
}

function codexConflicts(changes, lives) {
  const live = codexParseLive(lives);
  const valueAt = (path) => {
    let current = live;
    for (const key of path) {
      if (current === null || typeof current !== "object") return undefined;
      current = current[key];
    }
    return current;
  };
  return changes.map((change) => {
    const now = valueAt(change.path);
    const conflict = !stableEqual(now, change.before) && !stableEqual(now, change.after);
    return { change, conflict };
  });
}

function codexApply(lives, changes) {
  let text = lives.config && lives.config.exists ? lives.config.content : "";
  for (const change of changes) {
    const [head, second] = change.path;
    assertNoArrayOfTables(text, second === undefined ? head : `${head}.${second}`);
    if (second === undefined) {
      if (change.after === undefined) {
        text = toml.removeTopLevelKey(text, head);
        text = toml.setTable(text, head, null);
      } else if (isPlainObject(change.after)) {
        // The live key may be a [table] block — replace the block, not the
        // top-level key line (an inline write would duplicate the table).
        // Drop a stale inline form first so the block write cannot collide.
        text = toml.removeTopLevelKey(text, head);
        text = toml.setTable(text, head, change.after);
      } else {
        text = toml.setTopLevelKey(text, head, change.after);
      }
    } else {
      // Table entries are always whole tables (codexEntries only emits
      // objects at two-segment paths); anything else is a caller bug.
      if (!isPlainObject(change.after) && change.after !== undefined) {
        throw new Error(`Cannot write a scalar at [${change.path.join(".")}]: tables must be objects`);
      }
      const dotted = `${head}.${second}`;
      assertBlockChildEditable(text, head, second);
      text = toml.setTable(text, dotted, change.after === undefined ? null : change.after);
    }
  }
  return { ...lives, config: { ...lives.config, content: text } };
}

// The line editor rewrites [a.b] blocks but cannot splice a value out of an
// inline position inside its parent's block. When [a.b] has no header of its
// own and [a] carries `b = …` inline, refuse loudly instead of appending a
// duplicate definition.
function assertBlockChildEditable(text, parent, child) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*\\[\\s*"?${parent}"?\\s*\\]\\s*$`).test(line));
  if (start === -1) return;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break;
    if (new RegExp(`^\\s*"?${child}"?\\s*=`).test(lines[i])) {
      throw new Error(`[${parent}.${child}] is written inline inside [${parent}], which the editor cannot rewrite in place`);
    }
  }
}

// The line editor cannot rewrite [[array-of-tables]] blocks; refuse loudly
// rather than appending a duplicate plain table next to the array.
function assertNoArrayOfTables(text, dotted) {
  const escaped = dotted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^\\s*\\[\\[\\s*"?${escaped}"?\\s*(?:\\]|\\.)`, "m").test(text)) {
    throw new Error(`[[${dotted}]] is an array-of-tables, which the editor cannot rewrite`);
  }
}

// ---------------------------------------------------------------------------
// Gemini CLI
// ---------------------------------------------------------------------------

function geminiRowSettings(storedRow, edited) {
  const editedEnv = isPlainObject(edited && edited.env) ? edited.env : {};
  const env = {};
  for (const [key, value] of Object.entries(editedEnv)) {
    if (floor.isGeminiFloorEnv(key)) env[key] = value;
  }
  return { env };
}

function geminiPlanSave(storedRow, edited, base) {
  const baseEnv = isPlainObject(base && base.env) ? base.env : {};
  const editedEnv = isPlainObject(edited && edited.env) ? edited.env : {};
  const changes = [];
  const keys = new Set([...Object.keys(baseEnv), ...Object.keys(editedEnv)]);
  for (const key of keys) {
    if (floor.isGeminiFloorEnv(key)) continue;
    const was = key in baseEnv ? String(baseEnv[key]) : undefined;
    const now = key in editedEnv ? String(editedEnv[key]) : undefined;
    if (stableEqual(was, now)) continue;
    changes.push({ path: [key], before: was, after: now });
  }
  return { rowSettings: geminiRowSettings(storedRow, edited), changes };
}

function geminiInactiveFields(row) {
  const fields = [];
  const env = row && isPlainObject(row.env) ? row.env : {};
  for (const [key, value] of Object.entries(env)) {
    if (floor.isGeminiFloorEnv(key)) continue;
    fields.push({ path: ["env", key], value });
  }
  return fields;
}

function geminiReadLiveText(lives) {
  if (!lives.env || !lives.env.exists || typeof lives.env.content !== "string") {
    throw new Error("Live ~/.gemini/.env is missing (create it or run Gemini CLI once)");
  }
  return lives.env.content;
}

function geminiConflicts(changes, lives) {
  const text = geminiReadLiveText(lives);
  return changes.map((change) => {
    const now = envfile.getEnvValue(text, change.path[0]);
    const was = change.before === undefined ? undefined : String(change.before);
    const after = change.after === undefined ? undefined : String(change.after);
    const conflict = !stableEqual(now, was) && !stableEqual(now, after);
    return { change, conflict };
  });
}

function geminiApply(lives, changes) {
  let text = geminiReadLiveText(lives);
  for (const change of changes) {
    const key = change.path[0];
    if (change.after === undefined) text = envfile.removeEnvValue(text, key);
    else text = envfile.setEnvValue(text, key, String(change.after));
  }
  return { ...lives, env: { ...lives.env, content: text } };
}

// ---------------------------------------------------------------------------
// Editor view (cc-switch's get_provider_editor_view)
// ---------------------------------------------------------------------------

async function readCodexStash() {
  try {
    const { readJson } = require("../fs");
    const stash = await readJson(paths.codexAuthStashPath());
    return stash && typeof stash === "object" ? stash.auth || null : null;
  } catch {
    return null;
  }
}

// Build the full post-switch projection for the editor. `settingsConfig` is
// the row/draft being edited (add dialog: the preset fragment or empty);
// `id` identifies the provider when editing an existing one and `category`
// is the add-dialog's selection (the row's category wins when present).
async function buildEditorView(app, { settingsConfig, id, category } = {}) {
  if (!store.isSupportedApp(app)) throw new Error(`Unsupported app: ${app}`);
  const state = await store.listProviders(app);
  const row = id ? state.providers.find((p) => p.id === id) || null : null;
  const draft = settingsConfig !== undefined && settingsConfig !== null ? settingsConfig : row ? row.settingsConfig : {};
  const prev = state.current ? state.providers.find((p) => p.id === state.current) || null : null;
  const isCurrent = !!id && state.current === id;
  // The projections read the provider shape ({settingsConfig, category}):
  // the draft rides in settingsConfig, the official/custom decision comes
  // from the row (edit) or the caller (add dialog).
  const target = { settingsConfig: draft, category: row ? row.category : category || "custom" };

  const files = paths.targetFiles(app);
  const lives = {};
  for (const file of files) {
    try {
      const content = await fs.readFile(file.path, "utf8");
      lives[file.id] = { exists: true, content };
    } catch {
      lives[file.id] = { exists: false, content: null };
    }
  }

  if (app === "claude") {
    const live = claudeReadLive(lives);
    const settings = targets.projectClaude({ prev, target, live });
    return { ok: true, app, isCurrent, inactive: claudeInactiveFields(draft, settings), settings };
  }

  if (app === "codex") {
    if (!lives.config.exists || typeof lives.config.content !== "string") {
      throw new Error("Live ~/.codex/config.toml is missing (create it or run Codex once)");
    }
    let liveAuth = {};
    if (lives.auth.exists) {
      liveAuth = JSON.parse(lives.auth.content);
    }
    const stash = await readCodexStash();
    const { configToml, auth } = targets.projectCodex({
      prev,
      target,
      liveToml: lives.config.content,
      liveAuth,
      stash,
    });
    const authJson = auth.action === "write" ? auth.content : auth.action === "stash" ? {} : liveAuth;
    return { ok: true, app, isCurrent, inactive: codexInactiveFields(draft), configToml, authJson };
  }

  // Additive apps (opencode / openclaw / mcode): the editor shows the whole
  // native file as it would look after the switch. A missing file starts from
  // an empty document — the projection creates it on save (cc-switch does the
  // same for OpenCode).
  if (additive.isAdditiveApp(app)) {
    const live = lives.config.exists ? additive.parseLive(app, lives.config.content) : {};
    const next = additive.projectAdditive(app, { prev, target, live });
    // Echo the slot key the projection pinned the draft under, so the save
    // can split the row's entry back out of the edited document.
    const draftSlotKey = additive.wrapperOf({ settingsConfig: draft }).slotKey;
    return {
      ok: true,
      app,
      isCurrent,
      inactive: [],
      configText: additive.serializeLive(app, next),
      slotKey: draftSlotKey || additive.normalizeSlotKey(row && row.name, app),
    };
  }

  // gemini
  const envText = targets.projectGemini({ prev, target, liveEnv: geminiReadLiveText(lives) });
  return { ok: true, app, isCurrent, inactive: geminiInactiveFields(draft), envText };
}

// ---------------------------------------------------------------------------
// Save planning + three-way resolution
// ---------------------------------------------------------------------------

// Split an edited full config (what the dialog's editor showed, after user
// edits) against the base it was opened with. Returns the provider row
// content and the global-settings changes for the live files. `slotKey` is
// the additive editor-view echo (which container entry the row owns).
function planSave(app, storedRow, edited, base, slotKey) {
  if (app === "claude") return claudePlanSave(storedRow, edited, base);
  if (app === "codex") return codexPlanSave(storedRow, edited, base);
  if (app === "gemini") return geminiPlanSave(storedRow, edited, base);
  if (additive.isAdditiveApp(app)) return additive.planSaveAdditive(app, { settingsConfig: storedRow }, edited, base, slotKey);
  throw new Error(`Unsupported app: ${app}`);
}

// Mark each change with whether the live file now holds a third value at its
// path (edited by another program since the editor opened).
function resolveConflicts(app, changes, lives) {
  if (changes.length === 0) return [];
  if (app === "claude") return claudeConflicts(changes, lives);
  if (app === "codex") return codexConflicts(changes, lives);
  if (app === "gemini") return geminiConflicts(changes, lives);
  if (additive.isAdditiveApp(app)) return additive.additiveConflicts(app, changes, lives);
  throw new Error(`Unsupported app: ${app}`);
}

// Apply accepted changes to the in-memory lives map (content strings), so
// the caller can hand the patched contents straight into the switch
// projection without a second disk round-trip.
function applyChanges(app, lives, changes) {
  if (changes.length === 0) return lives;
  if (app === "claude") return claudeApply(lives, changes);
  if (app === "codex") return codexApply(lives, changes);
  if (app === "gemini") return geminiApply(lives, changes);
  if (additive.isAdditiveApp(app)) return additive.applyAdditiveChanges(app, lives, changes);
  throw new Error(`Unsupported app: ${app}`);
}

module.exports = {
  buildEditorView,
  planSave,
  resolveConflicts,
  applyChanges,
  pathKey,
};
