const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const paths = require("./paths");
const { isControlNotification } = require("./usage-record");

const TOKEN_FIELDS = {
  input_tokens: "inputTokens",
  cached_input_tokens: "cacheReadTokens",
  cache_creation_input_tokens: "cacheCreationTokens",
  output_tokens: "outputTokens",
  reasoning_output_tokens: "reasoningTokens",
  total_tokens: "totalTokens",
};

function readOptional(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeAtomic(file, content) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function removeControls(raw) {
  // Keep unrelated bytes, including malformed lines, unchanged.
  return raw.split(/(?<=\n)/).filter((line) => !isControlNotification(parseLine(line))).join("");
}

// Run before starting the bridge. Queue corrections are absolute cumulative
// rows, not negative deltas: readers and the uploader use last-row-wins. A
// pending journal makes retries safe even if a previous run stopped between
// appending the corrections, saving buckets and cleaning the raw record files.
function repairUsageHistory({ queuePath, toUtcHalfHourStart, appendQueueRow }) {
  const journalPath = path.join(paths.usageDir, "control-notification-repair.pending.json");
  const pending = readOptional(journalPath);
  let plan = pending ? JSON.parse(pending) : null;

  if (!plan) {
    let files;
    try {
      files = fs.readdirSync(paths.usageDir).filter((name) => /^records-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
    } catch (error) {
      if (error.code === "ENOENT") return { removedRecords: 0, correctedBuckets: 0 };
      throw error;
    }
    const changedFiles = new Map();
    const deltas = new Map();
    let removedRecords = 0;
    for (const name of files) {
      const raw = fs.readFileSync(path.join(paths.usageDir, name), "utf8");
      for (const line of raw.split("\n")) {
        const record = parseLine(line);
        if (!isControlNotification(record)) continue;
        removedRecords += 1;
        changedFiles.set(name, raw);
        if (record.failed || record.canceled) continue;
        const hourStart = toUtcHalfHourStart(record.timestamp || record.received_at);
        if (!hourStart) throw new Error(`Cannot date control notification in ${name}`);
        const model = String(record.response_model || record.model || record.alias || "unknown");
        const key = `${model}|${hourStart}`;
        const delta = deltas.get(key) || { model, hour_start: hourStart, conversation_count: 0 };
        delta.conversation_count += 1;
        for (const [field, token] of Object.entries(TOKEN_FIELDS)) {
          delta[field] = (delta[field] || 0) + (Number(record.tokens?.[token]) || 0);
        }
        deltas.set(key, delta);
      }
    }
    if (!removedRecords) return { removedRecords: 0, correctedBuckets: 0 };

    const bucketRaw = readOptional(paths.bucketsStatePath);
    const stored = bucketRaw ? JSON.parse(bucketRaw) : { version: 1, source: "cliproxy", buckets: {} };
    const queueRaw = readOptional(queuePath);
    const latest = new Map();
    for (const line of (queueRaw || "").split("\n")) {
      const row = parseLine(line);
      if (row?.source !== "cliproxy") continue;
      const key = `${row.model || "unknown"}|${row.hour_start}`;
      if (deltas.has(key)) latest.set(key, row);
    }
    const corrections = [];
    for (const [key, delta] of deltas) {
      // The queue is written before the debounced bucket state. Prefer its
      // latest totals so a restart during that debounce loses no real usage.
      const previous = latest.get(key) || stored.buckets?.[key];
      if (!previous) continue;
      const bucket = { model: delta.model, hour_start: delta.hour_start };
      for (const field of [...Object.keys(TOKEN_FIELDS), "conversation_count"]) {
        bucket[field] = Math.max(0, (Number(previous[field]) || 0) - delta[field]);
      }
      corrections.push({ key, bucket });
    }

    const backupDir = fs.mkdtempSync(path.join(paths.usageDir, "control-notification-backup-"));
    for (const [name, raw] of changedFiles) {
      fs.writeFileSync(path.join(backupDir, name), raw, { mode: 0o600 });
    }
    if (bucketRaw !== null) fs.writeFileSync(path.join(backupDir, "buckets.json"), bucketRaw, { mode: 0o600 });
    if (queueRaw !== null) fs.writeFileSync(path.join(backupDir, "queue.jsonl"), queueRaw, { mode: 0o600 });
    plan = { version: 1, removedRecords, backupDir, queuePath, files: [...changedFiles.keys()], corrections };
    writeAtomic(journalPath, JSON.stringify(plan));
  }

  for (const { bucket } of plan.corrections) appendQueueRow(bucket, plan.queuePath);
  if (plan.corrections.length) {
    const raw = readOptional(paths.bucketsStatePath);
    const stored = raw ? JSON.parse(raw) : { version: 1, source: "cliproxy", buckets: {} };
    stored.buckets ||= {};
    for (const { key, bucket } of plan.corrections) {
      if (bucket.conversation_count === 0 && Object.keys(TOKEN_FIELDS).every((field) => bucket[field] === 0)) {
        delete stored.buckets[key];
      } else {
        stored.buckets[key] = bucket;
      }
    }
    writeAtomic(paths.bucketsStatePath, JSON.stringify(stored));
  }
  for (const name of plan.files) {
    const file = path.join(paths.usageDir, name);
    const raw = readOptional(file);
    if (raw !== null) writeAtomic(file, removeControls(raw));
  }
  fs.unlinkSync(journalPath);
  return { removedRecords: plan.removedRecords, correctedBuckets: plan.corrections.length, backupDir: plan.backupDir };
}

module.exports = { repairUsageHistory };
