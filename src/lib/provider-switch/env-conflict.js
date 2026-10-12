const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { withFileLock } = require("../fs");

// Env-conflict detection, ported from cc-switch's services/env_checker.rs +
// services/env_manager.rs. Shell profiles and the process environment can
// carry connection variables (ANTHROPIC_BASE_URL, OPENAI_API_KEY, …) that
// override what the switcher writes into the live config files — the banner
// lists them so they can be removed (file sources) with an automatic backup.

// Exact names and prefixes that count as conflicts per app (cc-switch
// get_keywords_for_app; only the switch-mode apps are checkable).
const APP_ENV_KEYWORDS = {
  claude: [{ prefix: "ANTHROPIC_" }],
  codex: [{ prefix: "OPENAI_" }],
  gemini: [{ prefix: "GEMINI_" }, { prefix: "GOOGLE_GEMINI_" }],
  grokbuild: [{ exact: "XAI_API_KEY" }, { exact: "GROK_DEFAULT_MODEL" }],
};

function keywordsForApp(app) {
  return APP_ENV_KEYWORDS[app] || [];
}

function matchesKeyword(name, keywords) {
  const upper = String(name || "").toUpperCase();
  return keywords.some((keyword) =>
    keyword.exact ? upper === keyword.exact : upper.startsWith(keyword.prefix),
  );
}

function shellConfigFiles(home) {
  return [
    path.join(home, ".bashrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".zshrc"),
    path.join(home, ".zprofile"),
    path.join(home, ".profile"),
    "/etc/profile",
    "/etc/bashrc",
  ];
}

// Parse `export VAR=value` / `VAR=value` lines. Comments are skipped; a line
// that merely mentions `=` inside a command does not match the anchor form.
function parseExportLine(trimmed) {
  if (trimmed.startsWith("#")) return null;
  const line = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const eq = line.indexOf("=");
  if (eq <= 0) return null;
  const name = line.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const value = line.slice(eq + 1).trim();
  return { name, value };
}

function checkAppConflicts(app) {
  const keywords = keywordsForApp(app);
  if (keywords.length === 0) return [];
  const conflicts = [];

  for (const [key, value] of Object.entries(process.env)) {
    if (matchesKeyword(key, keywords)) {
      conflicts.push({ varName: key, varValue: String(value), sourceType: "system", sourcePath: "Process Environment" });
    }
  }

  const home = os.homedir();
  for (const filePath of shellConfigFiles(home)) {
    let content = null;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const parsed = parseExportLine(lines[i].trim());
      if (parsed && matchesKeyword(parsed.name, keywords)) {
        conflicts.push({
          varName: parsed.name,
          varValue: parsed.value.replace(/^["']|["']$/g, ""),
          sourceType: "file",
          sourcePath: `${filePath}:${i + 1}`,
        });
      }
    }
  }
  return conflicts;
}

function checkAllConflicts(apps) {
  const byApp = {};
  for (const app of apps) byApp[app] = checkAppConflicts(app);
  return byApp;
}

// ---------------------------------------------------------------------------
// Delete with backup + restore (cc-switch env_manager.rs)
// ---------------------------------------------------------------------------

function backupDir() {
  return path.join(os.homedir(), ".aitool", "provider-switch", "env-backups");
}

function uniqueConflictKey(conflict) {
  return `${conflict.sourceType}|${conflict.sourcePath}|${conflict.varName}`;
}

async function deleteConflicts(conflicts) {
  const clean = Array.isArray(conflicts) ? conflicts.filter((c) => c && typeof c === "object") : [];
  if (clean.length === 0) throw new Error("No environment conflicts selected");

  let deleted = 0;
  const failed = [];
  // Group file conflicts by file so each file is read and rewritten once.
  const byFile = new Map();
  for (const conflict of clean) {
    if (conflict.sourceType !== "file") continue; // process env cannot be removed from here
    const filePath = String(conflict.sourcePath || "").split(":").slice(0, -1).join(":");
    if (!filePath) {
      failed.push(`${conflict.varName}: invalid source path`);
      continue;
    }
    if (!byFile.has(filePath)) byFile.set(filePath, new Set());
    byFile.get(filePath).add(conflict.varName);
  }
  const edits = [];
  const removed = [];
  for (const [filePath, names] of byFile) {
    try {
      const content = await fsp.readFile(filePath, "utf8");
      const entries = [];
      const kept = content.split("\n").filter((line, index) => {
        const parsed = parseExportLine(line.trim());
        if (!parsed || !names.has(parsed.name)) return true;
        // Capture the bytes being removed, not the UI's display value (which
        // strips quotes and may be stale). Keep every repeated assignment.
        entries.push({ varName: parsed.name, varValue: parsed.value,
          sourceType: "file", sourcePath: `${filePath}:${index + 1}`, originalLine: line });
        return false;
      });
      if (entries.length) {
        edits.push({ filePath, before: content, after: kept.join("\n"), count: entries.length });
        removed.push(...entries);
      }
    } catch (error) {
      failed.push(`${filePath}: ${error?.message || String(error)}`);
    }
  }

  // Exclusive creation protects earlier backups even if two operations have
  // the same timestamp. Flush the backup before changing any shell profile.
  const dir = backupDir();
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(dir, `env-backup-${stamp}-${crypto.randomUUID()}.json`);
  const backupInfo = { version: 2, backupPath, timestamp: new Date().toISOString(),
    conflicts: removed, files: edits };
  const backup = await fsp.open(backupPath, "wx", 0o600);
  try {
    await backup.writeFile(`${JSON.stringify(backupInfo, null, 2)}\n`);
    await backup.sync();
  } finally {
    await backup.close();
  }
  for (const edit of edits) {
    try {
      if (await fsp.readFile(edit.filePath, "utf8") !== edit.before) {
        throw new Error("Shell profile changed; rescan before removing variables");
      }
      await fsp.writeFile(edit.filePath, edit.after);
      deleted += edit.count;
    } catch (error) {
      failed.push(`${edit.filePath}: ${error?.message || String(error)}`);
    }
  }
  if (deleted === 0 && failed.length > 0) {
    throw new Error(`Failed to remove environment variables. Backup saved to: ${backupPath}. ${failed.join("; ")}`);
  }
  return { backupPath, deleted, failed };
}

async function restoreFromBackup(backupPath) {
  const text = await fsp.readFile(backupPath, "utf8");
  const info = JSON.parse(text);
  const conflicts = Array.isArray(info.conflicts) ? info.conflicts : [];
  let restored = 0;
  const failed = [];
  const byFile = new Map();
  for (const conflict of conflicts) {
    if (conflict.sourceType !== "file") continue;
    const filePath = String(conflict.sourcePath || "").split(":").slice(0, -1).join(":");
    if (!filePath) continue;
    if (!byFile.has(filePath)) byFile.set(filePath, []);
    byFile.get(filePath).push(conflict);
  }
  for (const [filePath, entries] of byFile) {
    try {
      const existing = await fsp.readFile(filePath, "utf8");
      const savedFile = info.version === 2 && Array.isArray(info.files)
        ? info.files.find((file) => file.filePath === filePath) : null;
      if (savedFile && typeof savedFile.before === "string" && existing === savedFile.after) {
        // Without intervening edits, preserve ordering, comments, whitespace
        // and even the original trailing newline byte-for-byte.
        await fsp.writeFile(filePath, savedFile.before);
        restored += entries.length;
        continue;
      }
      const missing = entries.filter((entry) => {
        const lines = existing.split("\n");
        return !lines.some((line) => {
          const parsed = parseExportLine(line.trim());
          return parsed && parsed.name === entry.varName;
        });
      });
      if (missing.length === 0) continue;
      const addition = missing.map((entry) => {
        if (typeof entry.originalLine === "string") return entry.originalLine;
        // Older backups lost their shell quoting. Restore the saved value as
        // a literal; never interpret '$()', '&', spaces or backticks as code.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.varName)) throw new Error("Invalid environment variable name in backup");
        const value = String(entry.varValue ?? "");
        const quoted = /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
        return `export ${entry.varName}=${quoted}`;
      }).join("\n");
      const separator = existing && !existing.endsWith("\n") ? "\n" : "";
      await fsp.writeFile(filePath, `${existing}${separator}${addition}\n`);
      restored += missing.length;
    } catch (error) {
      failed.push(`${filePath}: ${error?.message || String(error)}`);
    }
  }
  if (restored === 0 && failed.length > 0) {
    throw new Error(`Failed to restore environment variables. ${failed.join("; ")}`);
  }
  return { restored, failed };
}

module.exports = {
  APP_ENV_KEYWORDS,
  keywordsForApp,
  matchesKeyword,
  parseExportLine,
  checkAppConflicts,
  checkAllConflicts,
  backupDir,
  // Keep overlapping delete/restore operations from losing each other's edits.
  deleteConflicts: (...args) => withFileLock(path.join(backupDir(), "operations"), () => deleteConflicts(...args)),
  restoreFromBackup: (...args) => withFileLock(path.join(backupDir(), "operations"), () => restoreFromBackup(...args)),
  // exported for tests
  uniqueConflictKey,
  shellConfigFiles,
};
