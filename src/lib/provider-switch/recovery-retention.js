"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const paths = require("./paths");

// Keep recent completed attempts, active attempts, and copies still referenced
// by a distribution receipt. Never follow user symlinks while pruning.
async function pruneRecovery(kind, keepPath, { now = Date.now(), maxEntries = 20, maxAgeMs = 30 * 86400000 } = {}) {
  if (!["profile-recovery", "distribution-backups"].includes(kind)) throw new Error("Unknown recovery directory");
  const root = path.join(paths.providerSwitchRoot(), kind);
  const stat = await fs.lstat(root).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  let distribution;
  try { distribution = JSON.parse(await fs.readFile(path.join(paths.providerSwitchRoot(), "distribution.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") return; }
  const references = Object.values(distribution?.owned || {}).map(row => row.backup).filter(value => typeof value === "string");
  const completed = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (target === keepPath || references.some(file => file.startsWith(target + path.sep))) continue;
    try {
      const manifestPath = path.join(target, "manifest.json");
      if (!(await fs.lstat(manifestPath)).isFile()) continue;
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const at = Date.parse(manifest.createdAt);
      const finished = kind === "profile-recovery"
        ? Array.isArray(manifest.apps) && Array.isArray(manifest.results) && manifest.apps.length === manifest.results.length && manifest.results.every(row => ["applied", "partial", "failed"].includes(row.status))
        : Array.isArray(manifest.files) && manifest.files.every(row => ["applied", "failed", "skipped"].includes(row.status));
      if (manifest.version === 1 && finished && Number.isFinite(at)) completed.push({ target, at });
    } catch { /* Uncertain recovery copies stay available for manual review. */ }
  }
  completed.sort((a, b) => b.at - a.at);
  for (const [index, entry] of completed.entries()) {
    if (index >= Math.max(0, maxEntries - (keepPath ? 1 : 0)) || now - entry.at > maxAgeMs) {
      await fs.rm(entry.target, { recursive: true, force: true });
    }
  }
}

module.exports = { pruneRecovery };
