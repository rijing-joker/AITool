"use strict";

// Compare the child's leading token snapshots with its parent's timeline.
// Match raw counters, including cumulative lineage, rather than timestamps or
// normalized cost columns. Paginated parent rollouts are one ordered timeline.
const fs = require("node:fs/promises");
const path = require("node:path");
const files = require("./codex-rollout-file");
const { usageSignature } = require("./codex-token-usage");
const { applyCodexModelEvent, createCodexModelAttributionState, currentCodexModel, snapshotCodexModelAttributionState } = require("./codex-model-attribution");
const { readCodexServiceTier } = require("./codex-service-tier");
const { createUsageDeltaState, consumeUsageDelta, snapshotUsageBaselines } = require("./codex-token-usage");
const cache = new Map();
function deferred(message) { const error = new Error(message); error.code = "CODEX_FORK_DEFERRED"; return error; }
function forkReplayMetadata(meta) {
  const id = (value) => typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
  // Native spawned threads keep their parent in source.subagent.thread_spawn.
  // Persist only these IDs when resuming, never the rest of the source object.
  const lineage = {
    forked_from_id: id(meta?.forked_from_id),
    parent_thread_id: id(meta?.parent_thread_id),
    spawned_from_id: id(meta?.source?.subagent?.thread_spawn?.parent_thread_id ?? meta?.spawned_from_id),
  };
  return Object.values(lineage).some(Boolean) ? lineage : null;
}
function tokenSignature(info) {
  const last = usageSignature(info?.last_token_usage);
  const total = usageSignature(info?.total_token_usage);
  return last || total ? `${last}|${total}` : null;
}
async function timeline(file, previous = null) {
  const stat = await fs.stat(file);
  const seed = previous ? { lastTotal: previous.lastTotal, tokenUsageBaselines: previous.tokenUsageBaselines, modelAttributionState: previous.modelAttributionState, lastServiceTier: previous.lastServiceTier } : null;
  const stamp = `${files.signature(stat)}|${JSON.stringify(seed)}`;
  const cached = cache.get(file);
  if (cached?.stamp === stamp) return cached;
  const snapshot = await files.readSnapshot(file, { expectedStat: stat });
  const events = [];
  let maxTimestamp = null;
  let invalidTimestamp = false;
  let lastServiceTier = previous?.lastServiceTier || null;
  const attribution = createCodexModelAttributionState(previous?.modelAttributionState || {});
  const usageState = createUsageDeltaState({ lastTotal: previous?.lastTotal, baselines: previous?.tokenUsageBaselines });
  for (const line of snapshot.data.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ms = Date.parse(obj.timestamp);
    applyCodexModelEvent(attribution, obj);
    lastServiceTier = readCodexServiceTier(obj) || lastServiceTier;
    if (Number.isFinite(ms)) maxTimestamp = Math.max(maxTimestamp || 0, ms);
    if (obj.type !== "event_msg" || obj.payload?.type !== "token_count") continue;
    const signature = tokenSignature(obj.payload.info);
    if (!signature) continue;
    if (!Number.isFinite(ms)) invalidTimestamp = true;
    else events.push({ ms, signature });
    consumeUsageDelta(usageState, obj.payload.info?.last_token_usage, obj.payload.info?.total_token_usage);
  }
  const value = { stamp, events, maxTimestamp, invalidTimestamp, lastModel: currentCodexModel(attribution), lastServiceTier,
    modelAttributionState: snapshotCodexModelAttributionState(attribution),
    lastTotal: usageState.lastTotal, tokenUsageBaselines: snapshotUsageBaselines(usageState) };
  cache.delete(file); cache.set(file, value);
  while (cache.size > 64) cache.delete(cache.keys().next().value);
  return value;
}
function createForkReplayResolver(inventory) {
  const index = new Map();
  for (const file of files.dedupeSiblings([...new Set(inventory)])) {
    const ids = files.rolloutIds(file);
    if (!ids) continue;
    for (const id of new Set([ids.thread, ids.rollout])) {
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(file);
    }
  }
  const resolve = async (meta, timestamp, childFiles = [], previous = null) => {
    const lineage = forkReplayMetadata(meta);
    if (!lineage) return null;
    const parents = [...new Set(Object.values(lineage).filter(Boolean))];
    if (parents.length !== 1) throw deferred("Conflicting Codex parent identities.");
    const [parent] = parents;
    const candidates = (index.get(String(parent).toLowerCase()) || []).filter((file) => !childFiles.includes(file));
    // Nonstandard legacy exports lack stable UUID filenames. Keep their old
    // fallback; native rollouts wait for a missing parent without billing replay.
    if (!candidates.length) {
      if (childFiles.some((file) => files.rolloutIds(file))) throw deferred("Codex parent rollout is unavailable.");
      return null;
    }
    const cutoff = Date.parse(timestamp);
    if (!Number.isFinite(cutoff)) throw deferred("Codex fork metadata has no valid timestamp.");
    const segments = new Map();
    for (const candidate of candidates.sort((a, b) => path.basename(a).localeCompare(path.basename(b)))) {
      let value;
      try { value = await timeline(candidate); } catch { throw deferred("Codex parent rollout could not be read."); }
      if (value.invalidTimestamp) throw deferred("Codex parent usage has no valid timestamp.");
      const id = files.rolloutIds(candidate).rollout;
      const signatures = value.events.filter((row) => row.ms <= cutoff).map((row) => row.signature);
      const existing = segments.get(id);
      if (existing) {
        if (JSON.stringify(existing.signatures) !== JSON.stringify(signatures)) throw deferred("Codex parent rollout copies disagree.");
        existing.maxTimestamp = Math.min(existing.maxTimestamp ?? 0, value.maxTimestamp ?? 0);
      } else segments.set(id, { signatures, maxTimestamp: value.maxTimestamp });
    }
    if (Math.max(...[...segments.values()].map((row) => row.maxTimestamp ?? 0)) < cutoff) throw deferred("Codex parent rollout has not reached the fork time.");
    const signatures = [...segments.values()].flatMap((row) => row.signatures);
    let offset = previous?.offset || 0;
    let active = previous?.active !== false;
    return {
      skip(info) {
        if (!active) return false;
        const signature = tokenSignature(info);
        if (!signature) return false;
        const match = signatures.indexOf(signature, offset);
        if (match < 0) { active = false; return false; }
        offset = match + 1;
        return true;
      },
      snapshot() { return { offset, active }; },
    };
  };
  resolve.dependencies = (parent) => index.get(String(parent || "").toLowerCase()) || [];
  resolve.pageState = async (file) => {
    const ids = files.rolloutIds(file);
    if (!ids?.paginated) return null;
    const previous = (index.get(ids.thread) || []).filter((candidate) =>
      files.rolloutIds(candidate).rollout !== ids.rollout && path.basename(candidate) < path.basename(file))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    let state = null;
    for (const candidate of previous) state = await timeline(candidate, state);
    return state;
  };
  return resolve;
}
module.exports = { createForkReplayResolver, forkReplayMetadata, tokenSignature };
