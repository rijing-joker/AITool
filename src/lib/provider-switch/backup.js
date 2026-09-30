const fs = require("node:fs/promises");
const path = require("node:path");
const { ensureDir } = require("../fs");
const paths = require("./paths");

// Pre-write backups, ported from cc-switch's first-write-backup idea: before
// a live file is written for the first time by a switch (or before any
// editor save / restore), a timestamped copy lands under
// ~/.aitool/provider-switch/backups/<app>/ so the user can always get back
// to the pre-AiTool state. Older backups rotate per app.

const MAX_BACKUPS_PER_APP = 20;

// "<basename>.<stamp>.bak" where the stamp never contains dots, so even a
// basename with dots (".env") round-trips.
const BACKUP_NAME_REGEX = /^(.+)\.(\d{4}-\d{2}-\d{2}T.*Z)\.bak$/;

function backupName(filePath, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${path.basename(filePath)}.${stamp}.bak`;
}

function backupTargetBasename(name) {
  const m = name.match(BACKUP_NAME_REGEX);
  return m ? m[1] : null;
}

async function createBackup(app, filePath, { force = false } = {}) {
  let existing = null;
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    return null; // Nothing to back up yet (file does not exist).
  }
  if (!force) {
    // Only the first write needs a backup; later writes keep the original.
    const dir = paths.backupsDir(app);
    try {
      const names = await fs.readdir(dir);
      if (names.some((name) => name.startsWith(`${path.basename(filePath)}.`))) {
        return null;
      }
    } catch {
      /* dir missing — proceed to create */
    }
  }
  const dir = paths.backupsDir(app);
  await ensureDir(dir);
  const target = path.join(dir, backupName(filePath));
  await fs.writeFile(target, existing, { mode: 0o600 });
  await rotate(app);
  return target;
}

async function listBackups(app) {
  const dir = paths.backupsDir(app);
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const backups = [];
  for (const name of names.filter((n) => n.endsWith(".bak")).sort().reverse()) {
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      backups.push({
        name,
        file: full,
        createdAt: stat.mtime.toISOString(),
        size: stat.size,
        target: backupTargetBasename(name),
      });
    } catch {
      /* raced delete */
    }
  }
  return backups;
}

async function rotate(app) {
  const backups = await listBackups(app);
  for (const backup of backups.slice(MAX_BACKUPS_PER_APP)) {
    try {
      await fs.unlink(backup.file);
    } catch {
      /* ignore */
    }
  }
}

async function readBackup(app, name) {
  if (!/^[\w.-]+\.bak$/.test(name)) throw new Error(`Invalid backup name: ${name}`);
  const full = path.join(paths.backupsDir(app), name);
  return fs.readFile(full, "utf8");
}

module.exports = {
  createBackup,
  listBackups,
  readBackup,
  backupTargetBasename,
  MAX_BACKUPS_PER_APP,
};
