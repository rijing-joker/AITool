const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ensureDir, readJsonStrict, updateJsonLocked, writeFileAtomic } = require("../fs");
const paths = require("./paths");
const backup = require("./backup");

// Prompt management, ported from cc-switch's prompt module (services/prompt.rs
// + prompt_files.rs). Each app owns a named prompt list; enabling one prompt
// writes its content over the app's instruction file:
//
//   claude     ~/.claude/CLAUDE.md
//   codex      ~/.codex/AGENTS.md
//   gemini     ~/.gemini/GEMINI.md
//   grokbuild  ~/.grok/AGENTS.md
//   opencode   ~/.config/opencode/AGENTS.md
//   openclaw   ~/.openclaw/AGENTS.md
//   hermes     ~/.hermes/SOUL.md
//   pi         ~/.pi/agent/AGENTS.md
//   mcode      ~/.minimax/AGENTS.md
//
// Exactly one prompt is enabled per app, and the live file is the user's
// ground truth — so, like cc-switch:
//
//   - enabling a prompt backfills first: the live file's content refreshes
//     the currently-enabled prompt, or — when none is enabled — becomes a
//     disabled "original" backup unless some prompt already holds that
//     content. A hand-written CLAUDE.md is therefore never silently lost.
//   - listing refreshes the enabled prompt from the live file (external
//     editors bypass the store; the enabled entry tracks the file).
//   - re-saving the last enabled prompt as disabled clears the live file;
//     fresh or already-disabled entries never touch it (it may hold
//     user-authored content the store has never owned).
//   - deleting an enabled prompt is refused.
//
// The store is one JSON file; each app's list is insertion-ordered (cc-switch
// uses an IndexMap) and that order is the stable pick order when projecting —
// the first enabled prompt wins (a state only reachable through store edits;
// the API keeps it at one).

// cc-switch's MAX_PROMPT_FILE_BYTES: live instruction files larger than 1 MiB
// are refused rather than slurped into memory.
const MAX_PROMPT_FILE_BYTES = 1024 * 1024;
// cc-switch's validate_prompt_content: MCode global instructions cap.
const MCODE_CONTENT_LIMIT_BYTES = 32 * 1024;

const PROMPT_APPS = ["claude", "codex", "gemini", "grokbuild", "opencode", "openclaw", "hermes", "pi", "mcode"];

function promptFilePath(app) {
  const home = os.homedir();
  switch (app) {
    case "claude":
      return path.join(home, ".claude", "CLAUDE.md");
    case "codex":
      return path.join(home, ".codex", "AGENTS.md");
    case "gemini":
      return path.join(home, ".gemini", "GEMINI.md");
    case "grokbuild":
      return path.join(home, ".grok", "AGENTS.md");
    case "opencode":
      return path.join(home, ".config", "opencode", "AGENTS.md");
    case "openclaw":
      return path.join(home, ".openclaw", "AGENTS.md");
    case "hermes":
      return path.join(home, ".hermes", "SOUL.md");
    case "pi":
      return path.join(home, ".pi", "agent", "AGENTS.md");
    case "mcode":
      return path.join(home, ".minimax", "AGENTS.md");
    default:
      throw new Error(`Prompts are not supported for app: ${app}`);
  }
}

// ---------------------------------------------------------------------------
// Store (prompts.json)
// ---------------------------------------------------------------------------

function normalizePrompt(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    content: typeof raw.content === "string" ? raw.content : "",
    description: typeof raw.description === "string" ? raw.description : "",
    enabled: raw.enabled === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

function normalizeStore(current) {
  const apps = current && typeof current.apps === "object" && current.apps !== null && !Array.isArray(current.apps)
    ? current.apps
    : {};
  const out = {};
  for (const app of PROMPT_APPS) {
    const list = Array.isArray(apps[app]) ? apps[app] : [];
    out[app] = list.map((raw) => normalizePrompt(raw)).filter(Boolean);
  }
  return { version: 1, apps: out };
}

async function readStore() {
  const result = await readJsonStrict(paths.promptsStorePath());
  if (result.status === "missing") return normalizeStore(null);
  if (result.status !== "ok") {
    throw new Error(`Prompt store is unreadable: ${paths.promptsStorePath()}`);
  }
  return normalizeStore(result.value);
}

async function mutateStore(update) {
  await ensureDir(path.dirname(paths.promptsStorePath()));
  return updateJsonLocked(paths.promptsStorePath(), (current) => {
    const store = normalizeStore(current);
    const next = update(store);
    return next === undefined ? undefined : normalizeStore(next);
  });
}

function requireApp(app) {
  if (!PROMPT_APPS.includes(app)) throw new Error(`Prompts are not supported for app: ${app}`);
  return app;
}

function sanitizeId(id) {
  const trimmed = String(id || "").trim();
  if (!trimmed) throw new Error("Prompt id is required");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) {
    throw new Error("Prompt id may only contain letters, digits, '_' and '-' (max 64)");
  }
  return trimmed;
}

function validateContent(app, content) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_PROMPT_FILE_BYTES) {
    throw new Error(`Prompt content must not exceed 1 MiB (${bytes} bytes given)`);
  }
  if (app === "mcode" && bytes > MCODE_CONTENT_LIMIT_BYTES) {
    throw new Error("MCode global instructions must not exceed 32 KiB");
  }
}

// ---------------------------------------------------------------------------
// Live instruction file
// ---------------------------------------------------------------------------

// Reads the app's live instruction file for a backfill, or null when it does
// not exist / cannot be read (cc-switch's enable_prompt degrades the same
// way; the pre-write backup is the safety net). An oversized file is
// rethrown — its content must not be silently overwritten with prompt
// content we were never able to read.
async function readLiveFile(filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return null;
  }
  if (stat.size > MAX_PROMPT_FILE_BYTES) {
    throw new Error(`Prompt file exceeds 1 MiB, refusing to read: ${filePath}`);
  }
  return fsp.readFile(filePath, "utf8");
}

async function readLiveForBackfill(filePath) {
  return readLiveFile(filePath).catch((error) => {
    if (error && /exceeds 1 MiB/.test(error.message)) throw error;
    return null;
  });
}

async function writeLiveFile(app, filePath, content) {
  await backup.createBackup(app, filePath);
  await writeFileAtomic(filePath, content);
}

// ---------------------------------------------------------------------------
// Operations (used by the API layer)
// ---------------------------------------------------------------------------

function formatStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Enable-flow backfill (cc-switch enable_prompt): capture the live file into
// the store before it gets overwritten. Returns the store mutation to apply —
// refreshed content on the currently-enabled prompt, or a new disabled backup
// entry — or null when there is nothing to capture.
function buildLiveBackfill(store, app, liveContent) {
  const prompts = store.apps[app];
  const enabled = prompts.find((prompt) => prompt.enabled);
  if (enabled) {
    if (enabled.content === liveContent) return null;
    return { kind: "refresh", id: enabled.id, content: liveContent };
  }
  const exists = prompts.some((prompt) => prompt.content.trim() === liveContent.trim());
  if (exists) return null;
  const now = new Date();
  return {
    kind: "backup",
    prompt: {
      id: `backup-${now.getTime()}`,
      name: `原始提示词 ${formatStamp(now)}`,
      content: liveContent,
      description: "自动备份的原始提示词",
      enabled: false,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  };
}

// Apply a backfill plan inside a store mutation; the live file is written by
// the caller afterwards, so a failed file write leaves the capture recorded —
// re-running the operation restores it into the flow instead of losing it.
function applyBackfill(store, app, plan, nowIso) {
  if (!plan) return;
  if (plan.kind === "refresh") {
    const prompt = store.apps[app].find((entry) => entry.id === plan.id);
    if (prompt) {
      prompt.content = plan.content;
      prompt.updatedAt = nowIso;
    }
    return;
  }
  store.apps[app].push(normalizePrompt(withUniqueId(store.apps[app], plan.prompt)));
}

// Generated ids (backup-<ms>, imported-<ms>) can collide on near-simultaneous
// writes, and duplicate ids would make the findIndex-based updates and delete
// only touch the first copy (cc-switch keys prompts in an IndexMap; our array
// needs the suffix uniquification instead).
function withUniqueId(prompts, record) {
  if (!prompts.some((prompt) => prompt.id === record.id)) return record;
  let index = 2;
  while (prompts.some((prompt) => prompt.id === `${record.id}-${index}`)) index += 1;
  return { ...record, id: `${record.id}-${index}` };
}

// List one app's prompts, first refreshing the enabled prompt's content from
// the live file so externally-edited instruction files show up (cc-switch
// get_prompts). The refresh is best-effort: a read or store failure returns
// the saved state unchanged, with a warning logged since the "enabled entry
// tracks the live file" invariant then depends on a later successful refresh.
async function listPrompts(app) {
  requireApp(app);
  const store = await readStore();
  const enabled = store.apps[app].find((prompt) => prompt.enabled);
  if (!enabled) return store.apps[app];
  try {
    const live = await readLiveFile(promptFilePath(app));
    if (live === null || live.trim() === "" || live === enabled.content) return store.apps[app];
    const next = await mutateStore((current) => {
      const prompt = current.apps[app]?.find((entry) => entry.id === enabled.id);
      if (prompt) {
        prompt.content = live;
        prompt.updatedAt = new Date().toISOString();
      }
      return current;
    });
    return next.apps[app];
  } catch (error) {
    console.warn(`[prompts] ${app}: refreshing the enabled prompt from the live file failed:`, error?.message || error);
    return store.apps[app];
  }
}

async function upsertPrompt(app, input) {
  requireApp(app);
  if (!input || typeof input !== "object") throw new Error("Prompt payload required");
  const id = sanitizeId(input.id);
  const name = String(input.name || id).trim().slice(0, 100) || id;
  const content = String(input.content ?? "");
  const description = String(input.description || "").slice(0, 500);
  const enabled = input.enabled === true;
  validateContent(app, content);

  const filePath = promptFilePath(app);
  // Enabling from the upsert path overwrites the live file too, so the same
  // capture-first rule as enablePrompt applies (cc-switch's UI splits this
  // into create + enable; our dialog does it in one call).
  const live = enabled ? await readLiveForBackfill(filePath) : null;
  const liveContent = live !== null && live.trim() !== "" ? live : null;
  const nowIso = new Date().toISOString();
  let clearLive = false;
  await mutateStore((store) => {
    const prompts = store.apps[app];
    if (liveContent !== null) {
      applyBackfill(store, app, buildLiveBackfill(store, app, liveContent), nowIso);
    }
    const current = store.apps[app];
    const index = current.findIndex((prompt) => prompt.id === id);
    const previous = index === -1 ? null : current[index];
    // Only clearing the LAST enabled prompt may blank the live file; fresh,
    // imported or already-disabled entries must never touch user content.
    clearLive = !enabled
      && previous !== null
      && previous.enabled
      && !current.some((prompt) => prompt.id !== id && prompt.enabled);
    const record = {
      id,
      name,
      content,
      description,
      enabled,
      createdAt: previous ? previous.createdAt : nowIso,
      updatedAt: nowIso,
    };
    if (index === -1) current.push(record);
    else current[index] = record;
    // Enabling here is a full enable: exactly one prompt stays active per app
    // (cc-switch's enable_prompt loop), otherwise the next list's backfill
    // would treat the older enabled entry as the live file's owner.
    if (enabled) {
      for (const prompt of current) prompt.enabled = prompt.id === id;
    }
    return store;
  });
  if (enabled) {
    await writeLiveFile(app, filePath, content);
  } else if (clearLive) {
    let fileExists = true;
    try {
      await fsp.access(filePath);
    } catch {
      fileExists = false; // File vanished meanwhile — nothing to clear.
    }
    if (fileExists) await writeLiveFile(app, filePath, "");
  }
  return { prompts: await listPrompts(app), targetPath: filePath };
}

async function enablePrompt(app, id) {
  requireApp(app);
  const cleanId = sanitizeId(id);
  const filePath = promptFilePath(app);
  const live = await readLiveForBackfill(filePath);
  const liveContent = live !== null && live.trim() !== "" ? live : null;
  const nowIso = new Date().toISOString();

  let target = null;
  await mutateStore((store) => {
    if (liveContent !== null) {
      applyBackfill(store, app, buildLiveBackfill(store, app, liveContent), nowIso);
    }
    const found = store.apps[app].find((prompt) => prompt.id === cleanId);
    if (!found) throw new Error(`Prompt not found: ${cleanId}`);
    validateContent(app, found.content);
    for (const prompt of store.apps[app]) prompt.enabled = prompt.id === cleanId;
    target = { ...found, enabled: true, updatedAt: nowIso };
    return store;
  });

  await writeLiveFile(app, filePath, target.content);
  return { prompts: await listPrompts(app), targetPath: filePath };
}

async function deletePrompt(app, id) {
  requireApp(app);
  const cleanId = sanitizeId(id);
  await mutateStore((store) => {
    const prompts = store.apps[app];
    const target = prompts.find((prompt) => prompt.id === cleanId);
    if (!target) return undefined;
    if (target.enabled) throw new Error("无法删除已启用的提示词");
    store.apps[app] = prompts.filter((prompt) => prompt.id !== cleanId);
    return store;
  });
  return { prompts: await listPrompts(app), targetPath: promptFilePath(app) };
}

// Import the app's current instruction file as a disabled prompt (cc-switch
// import_from_file). Disabled entries never touch the live file, so the
// import is observation-only.
async function importFromFile(app) {
  requireApp(app);
  const filePath = promptFilePath(app);
  const live = await readLiveFile(filePath);
  if (live === null) throw new Error("提示词文件不存在");
  const now = new Date();
  const record = {
    id: `imported-${now.getTime()}`,
    name: `导入的提示词 ${formatStamp(now)}`,
    content: live,
    description: "从现有配置文件导入",
    enabled: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await mutateStore((store) => {
    store.apps[app].push(normalizePrompt(withUniqueId(store.apps[app], record)));
    return store;
  });
  return { prompts: await listPrompts(app), targetPath: filePath };
}

// Re-project one app (cc-switch's restore projection): the first enabled
// prompt in insertion order wins and is written to the live file; with none
// enabled the file is left untouched — it may hold content the store never
// owned. Used to repair drift after external rewrites.
async function projectPromptsToApp(app) {
  requireApp(app);
  const store = await readStore();
  const enabled = store.apps[app].filter((prompt) => prompt.enabled);
  if (enabled.length === 0) return { projected: false, warning: null };
  // Same rule as cc-switch's sync_to_live: the cap is re-checked at
  // projection so an entry that pre-dates a tightened limit cannot bypass it.
  validateContent(app, enabled[0].content);
  await writeLiveFile(app, promptFilePath(app), enabled[0].content);
  const warning = enabled.length > 1
    ? `多个 Prompt 同时启用，已按稳定顺序投影第一个: ${enabled.map((prompt) => prompt.id).join(", ")}`
    : null;
  return { projected: true, warning };
}

async function syncPrompts(apps) {
  const targets = Array.isArray(apps) && apps.length
    ? apps.filter((app) => PROMPT_APPS.includes(app))
    : PROMPT_APPS.slice();
  const failures = [];
  const warnings = [];
  for (const app of targets) {
    try {
      const result = await projectPromptsToApp(app);
      if (result.warning) warnings.push(result.warning);
    } catch (error) {
      failures.push(`${app}: ${error?.message || String(error)}`);
    }
  }
  return { failures, warnings };
}

module.exports = {
  PROMPT_APPS,
  MAX_PROMPT_FILE_BYTES,
  MCODE_CONTENT_LIMIT_BYTES,
  promptFilePath,
  listPrompts,
  upsertPrompt,
  enablePrompt,
  deletePrompt,
  importFromFile,
  projectPromptsToApp,
  syncPrompts,
};
