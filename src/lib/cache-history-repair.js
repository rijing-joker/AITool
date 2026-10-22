"use strict";

// Rebuild in isolation, then publish a recoverable set of statistics. The
// journal contains counters/cursors only; decoded session content stays in RAM.
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { physicalJsonlRecords } = require("./jsonl-lines");
const codexFiles = require("./codex-rollout-file");
const { parseRolloutIncremental, parseClaudeIncremental, codexSessionIdFromPath } = require("./rollout");
// v2 also repairs relays whose reported totals place writes outside input.
const KEYS = { codex: "codexCacheWriteRepair_2026_10_v3", claude: "claudeCacheTtlRepair_2026_10_v1" };
const JOURNAL = "cache-history-repair.pending.json";
const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const encode = (value) => JSON.stringify(value) + "\n";

async function readOptional(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function atomicWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
}

function rows(raw) {
  return (raw || "").split("\n").filter((line) => line.trim()).map(JSON.parse);
}

function latest(raw, source, project = false) {
  const out = new Map();
  for (const row of rows(raw)) {
    if (row.source !== source || !row.hour_start) continue;
    const key = `${project ? row.project_key + "|" : ""}${row.model}|${row.hour_start}`;
    out.set(key, row);
  }
  return out;
}

function stateRows(state, source, project = false) {
  return Object.entries(state?.buckets || {}).filter(([key, bucket]) =>
    (bucket.source || key.split("|")[project ? 1 : 0]) === source,
  ).map(([key, bucket]) => encode({
    ...bucket.totals, source, hour_start: bucket.hour_start || key.split("|").at(-1),
    ...(project ? { project_key: bucket.project_key || key.split("|")[0] } : { model: key.split("|")[1] }),
  })).join("");
}

function validateCoverage(previous, next, source, project) {
  const oldRows = latest(previous, source, project), newRows = latest(next, source, project);
  // These counters are unaffected by either fix. A decrease proves that the
  // logs cannot reproduce the old history (even if a truncated file retains
  // its session id). Defer rather than make a destructive guess.
  const fields = ["total_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens"];
  if (source === "claude") fields.push("input_tokens", "cache_creation_input_tokens");
  for (const [key, before] of oldRows) {
    const after = newRows.get(key);
    if (fields.some((field) => Number(before[field] || 0) > Number(after?.[field] || 0))) {
      throw new Error(`history_not_covered:${project ? "project" : "main"}:${key}`);
    }
  }
  // The queue attributes unknown-model user turns to the known model for the
  // hour. Cursor state retains the original unknown bucket, so compare turn
  // counts across the whole hour instead of requiring the same model label.
  const conversations = (values) => {
    const sums = new Map();
    for (const row of values) {
      const key = `${project ? row.project_key : ""}|${row.hour_start}`;
      sums.set(key, (sums.get(key) || 0) + Number(row.conversation_count || 0));
    }
    return sums;
  };
  const nextCounts = conversations(newRows.values());
  for (const [key, count] of conversations(oldRows.values())) {
    if (count > (nextCounts.get(key) || 0)) throw new Error(`history_not_covered:conversations:${key}`);
  }
}

function validateProjectTotals(main, project, source) {
  const sum = (values) => {
    const result = new Map();
    for (const row of values) {
      const key = row.hour_start;
      const current = result.get(key) || {};
      for (const field of ["total_tokens", "input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "cache_creation_1h_input_tokens"]) {
        current[field] = (current[field] || 0) + Number(row[field] || 0);
      }
      result.set(key, current);
    }
    return result;
  };
  const mainTotals = sum(latest(main, source).values());
  for (const [key, totals] of sum(latest(project, source, true).values())) {
    for (const [field, count] of Object.entries(totals)) {
      if (count > (mainTotals.get(key)?.[field] || 0)) throw new Error(`project_exceeds_main:${key}:${field}`);
    }
  }
}

function belongs(file, source, roots) {
  const normal = file.replace(/\\/g, "/");
  return roots.some((root) => normal.startsWith(root.replace(/\\/g, "/").replace(/\/$/, "") + "/")) ||
    (source === "codex" ? /\/\.codex\/(?:archived_)?sessions\// : /\/\.claude\/projects\//).test(normal);
}

async function auditFile(file) {
  const before = await fs.stat(file);
  const input = codexFiles.isCompressed(file)
    ? codexFiles.bufferStream((await codexFiles.readSnapshot(file, { expectedStat: before })).data)
    : fssync.createReadStream(file);
  try {
    for await (const record of physicalJsonlRecords(input, { invalidUtf8: "throw" })) {
      if (record.line.trim()) JSON.parse(record.line);
    }
  } finally { input.destroy(); }
  if (codexFiles.signature(before) !== codexFiles.signature(await fs.stat(file))) throw new Error("log_changed_during_audit");
  return before;
}

function replaceSourceState(target, rebuilt, source, roots) {
  for (const stateKey of ["hourly", "projectHourly"]) {
    const state = target[stateKey] ||= {};
    for (const field of ["buckets", "groupQueued"]) {
      if (!state[field] && !rebuilt[stateKey]?.[field]) continue;
      state[field] ||= {};
      for (const key of Object.keys(state[field])) {
        const rowSource = state[field][key]?.source || key.split("|")[stateKey === "hourly" ? 0 : 1];
        if (rowSource === source) delete state[field][key];
      }
      Object.assign(state[field], rebuilt[stateKey]?.[field] || {});
    }
    if (rebuilt[stateKey]?.projects) state.projects = { ...state.projects, ...rebuilt[stateKey].projects };
    if (rebuilt[stateKey]?.version) state.version = rebuilt[stateKey].version;
  }
  target.files ||= {};
  for (const file of Object.keys(target.files)) if (belongs(file, source, roots)) delete target.files[file];
  Object.assign(target.files, rebuilt.files);
  for (const key of Object.keys(rebuilt)) {
    if (key.startsWith(source) && key !== "files") target[key] = rebuilt[key];
  }
}

async function publish({ journal, trackerDir, cursors, commitCursors, afterPublish }) {
  for (let index = 0; index < journal.files.length; index++) {
    const entry = journal.files[index];
    let content = await fs.readFile(entry.staged, "utf8");
    if (digest(content) !== entry.digest) throw new Error("repair_stage_checksum_mismatch");
    if (entry.queue) {
      // Source snapshots are last-row-wins. Publish only correction rows by
      // append; the proxy bridge writes outside sync.lock. Replaying a journal
      // may append the same snapshot again, which is deliberately idempotent.
      content = rows(content).filter((row) => row.source === journal.source).map(JSON.stringify).join("\n");
      if (content) await fs.appendFile(entry.target, content + "\n", { mode: 0o600 });
    } else {
      await atomicWrite(entry.target, content);
    }
    if (afterPublish) await afterPublish(index);
  }
  // Opening the sharded store materializes its old generation. Clear its old
  // source state before installing the journal's complete cursor snapshot.
  for (const key of Object.keys(cursors)) delete cursors[key];
  Object.assign(cursors, clone(journal.cursors));
  await commitCursors(cursors);
  if (journal.sessionMetaPath) await fs.rm(journal.sessionMetaPath, { force: true });
  await atomicWrite(path.join(journal.backupDir, "completed.json"), encode({ completedAt: new Date().toISOString(), source: journal.source }));
  await fs.rm(path.join(trackerDir, JOURNAL), { force: true });
}

async function recoverCacheHistoryRepair({ trackerDir, cursors, commitCursors, materialize }) {
  const raw = await readOptional(path.join(trackerDir, JOURNAL));
  if (!raw) return false;
  if (materialize) await materialize();
  await publish({ journal: JSON.parse(raw), trackerDir, cursors, commitCursors });
  return true;
}

async function repairCacheHistory({ source, files, roots = [], cursors, trackerDir, queuePath,
  projectQueuePath, queueStatePath, projectQueueStatePath, commitCursors, sessionMetaPath,
  publicRepoResolver, beforeValidate, afterPublish, completedKeys = [] }) {
  const key = KEYS[source];
  if (!key) throw new Error("unsupported_cache_repair_source");
  if (cursors.migrations?.[key]?.status === "complete") return false;
  const work = await fs.mkdtemp(path.join(trackerDir, ".cache-rebuild-"));
  let prepared = false;
  try {
    files = codexFiles.dedupeSiblings([...new Set(files)]);
    const fileSet = new Set(files);
    const ids = new Set(files.map((file) => source === "codex" ? codexSessionIdFromPath(file) : path.basename(file)));
    for (const file of Object.keys(cursors.files || {})) {
      if (!belongs(file, source, roots) || fileSet.has(file)) continue;
      const id = source === "codex" ? codexSessionIdFromPath(file) : path.basename(file);
      if (!id || !ids.has(id)) throw new Error("session_log_missing");
    }
    const originals = new Map();
    for (const file of [queuePath, projectQueuePath, queueStatePath, projectQueueStatePath].filter(Boolean)) originals.set(file, await readOptional(file));
    const snapshots = new Map();
    for (const file of files) snapshots.set(file, await auditFile(file));
    const rebuilt = { version: 1, files: {} };
    const nextQueue = path.join(work, "queue.jsonl"), nextProject = path.join(work, "project.queue.jsonl");
    const args = { cursors: rebuilt, queuePath: nextQueue, projectQueuePath: projectQueuePath ? nextProject : null, publicRepoResolver };
    if (source === "codex") await parseRolloutIncremental({ ...args, rolloutFiles: files, invalidRecordPolicy: "throw" });
    else await parseClaudeIncremental({ ...args, projectFiles: files });
    const mainRaw = await readOptional(nextQueue) || "", projectRaw = await readOptional(nextProject) || "";
    validateCoverage(originals.get(queuePath), mainRaw, source, false);
    validateCoverage(stateRows(cursors.hourly, source), mainRaw, source, false);
    if (projectQueuePath) validateCoverage(originals.get(projectQueuePath), projectRaw, source, true);
    if (projectQueuePath) validateCoverage(stateRows(cursors.projectHourly, source, true), projectRaw, source, true);
    validateProjectTotals(mainRaw, projectRaw, source);
    if (beforeValidate) await beforeValidate();
    for (const [file, stat] of snapshots) {
      if (codexFiles.signature(stat) !== codexFiles.signature(await fs.stat(file))) throw new Error("log_changed_during_rebuild");
      if (rebuilt.files[file]?.offset !== stat.size) throw new Error("log_not_consumed_through_eof");
    }
    for (const [file, raw] of originals) if (await readOptional(file) !== raw) throw new Error("statistics_changed_during_rebuild");
    const next = clone(cursors);
    replaceSourceState(next, rebuilt, source, roots);
    (next.migrations ||= {})[key] = { status: "complete", at: new Date().toISOString(), files: files.length };
    for (const completedKey of completedKeys) next.migrations[completedKey] = new Date().toISOString();
    const backupDir = path.join(trackerDir, "repair-backups", `${source}-${crypto.randomUUID()}`);
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(backupDir, "cursors.before.json"), encode(cursors));
    const journal = { version: 1, source, backupDir, cursors: next, sessionMetaPath, files: [] };
    for (const [target, original] of originals) {
      const index = journal.files.length;
      if (original !== null) await atomicWrite(path.join(backupDir, `${index}.before`), original);
      let content;
      if (target === queuePath || target === projectQueuePath) {
        const kept = rows(original).filter((row) => row.source !== source);
        content = kept.concat(rows(target === queuePath ? mainRaw : projectRaw)).map(JSON.stringify).join("\n") + "\n";
      } else {
        content = encode({ ...JSON.parse(original || "{}"), offset: 0, updatedAt: new Date().toISOString(), note: `reset_after_${key}` });
      }
      const staged = path.join(backupDir, `${index}.after`);
      await atomicWrite(staged, content);
      journal.files.push({ target, staged, digest: digest(content), queue: target === queuePath || target === projectQueuePath });
    }
    await atomicWrite(path.join(trackerDir, JOURNAL), encode(journal));
    prepared = true;
    await publish({ journal, trackerDir, cursors, commitCursors, afterPublish });
    return true;
  } catch (error) {
    // Once publication starts, abort this sync. Startup recovery must finish
    // the journal before any parser or uploader can see mixed generations.
    if (prepared) throw error;
    const safeReason = /^(history_not_covered:|project_exceeds_main:|session_log_missing$|log_changed_|log_not_consumed_|statistics_changed_)/.test(error.message)
      ? error.message : error instanceof SyntaxError ? "invalid_json" : error.code || "rebuild_failed";
    (cursors.migrations ||= {})[key] = { status: error instanceof SyntaxError ? "failed" : "deferred", reason: safeReason, at: new Date().toISOString() };
    console.error(`[sync] ${source} cache history repair deferred: ${safeReason}`);
    return false;
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}

module.exports = { KEYS, JOURNAL, repairCacheHistory, recoverCacheHistoryRepair };
