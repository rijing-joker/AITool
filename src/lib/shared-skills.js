"use strict";
// Explicit shared-skill handover, inspired by Magpie da8039368 (MIT).
// Every operation is synchronous at the fresh-registry commit checkpoint.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const root = () => path.join(os.homedir(), ".agents", "skills");
const stat = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
function safeName(name) { if (typeof name !== "string" || !name || name.startsWith(".") || /[/\\\0]/.test(name)) throw new Error("Invalid shared skill name"); return name; }
function treeHash(directory) {
  const hash = crypto.createHash("sha256"); let bytes = 0, count = 0;
  const walk = (dir, relative) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), info = fs.lstatSync(file), key = `${relative}/${name}`;
      if (++count > 10000 || info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("Shared skill contains unsupported links or special files");
      hash.update(`${key}\0${info.isDirectory() ? "dir" : info.mode & 0o111}\0`);
      if (info.isDirectory()) walk(file, key);
      else { bytes += info.size; if (bytes > 64 * 1024 * 1024) throw new Error("Shared skill exceeds 64 MiB"); hash.update(fs.readFileSync(file)); }
      hash.update("\0");
    }
  };
  walk(directory, ""); return hash.digest("hex");
}
function privateParents(directory, create = true) {
  const home = os.homedir(), relative = path.relative(home, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Shared skill path is outside this home directory: ${directory}`);
  let file = home;
  for (const name of relative.split(path.sep).filter(Boolean)) {
    file = path.join(file, name); const info = stat(file);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("Shared skill parent directory is redirected");
    if (!info && create) fs.mkdirSync(file, { mode: 0o700 });
  }
}
function sharedInfo(directory) {
  let name; try { name = safeName(directory); } catch { return null; }
  const shared = path.join(root(), name), info = stat(shared);
  return info && (info.isDirectory() || info.isSymbolicLink()) ? { path: shared, link: info.isSymbolicLink(), scope: "shared" } : null;
}
function projectionReceipt(file) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink()) return { kind: "link", identity: JSON.stringify([info.dev, info.ino, info.ctimeMs, fs.readlinkSync(file)]) };
  if (info.isDirectory()) return { kind: "copy", identity: JSON.stringify([info.dev, info.ino, info.birthtimeMs]), hash: treeHash(file) };
  throw new Error("Shared skill projection is not a directory or link");
}
function createController(runtime) {
  const { saveRegistry, dataDir, ssotDir, TARGETS, targetDirs, metadata } = runtime;
  const equal = require("node:util").isDeepStrictEqual;
  const readRegistry = () => {
    if (runtime.registryPath) {
      const file = runtime.registryPath(); privateParents(path.dirname(file));
      if (stat(file)) {
        if (!stat(file).isFile() || stat(file).isSymbolicLink()) throw new Error("Skill registry is redirected");
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!raw || !Array.isArray(raw.skills) || !Array.isArray(raw.repos)) throw new Error("Skill registry is invalid; it was kept");
      }
    }
    const registry = runtime.readRegistry(), ids = new Set();
    for (const row of registry.skills) {
      const relative = typeof row?.directory === "string" ? row.directory.replace(/\\/g, "/") : "";
      if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id) || !relative || path.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === "..") || relative.includes("\0")
        || !Array.isArray(row.targets) || row.targets.some(id => !TARGETS[id])) throw new Error("Skill registry is invalid; it was kept");
      ids.add(row.id);
    }
    return registry;
  };
  const receiptRoot = () => path.join(dataDir(), "handover");
  const write = (file, doc) => { const temp = `${file}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(temp, file); };
  const handOver = names => {
    const results = [];
    for (const name of names) try { results.push(move(safeName(name))); } catch (error) { results.push({ directory: name, ok: false, error: error.message }); }
    return { results };
  };
  function move(name) {
    const shared = sharedInfo(name); if (!shared) throw new Error("Shared skill is missing");
    privateParents(root()); privateParents(ssotDir()); privateParents(receiptRoot());
    const source = fs.realpathSync(shared.path), expected = treeHash(source);
    const registry = readRegistry(), existing = registry.skills.find(row => row.directory.toLowerCase() === name.toLowerCase());
    const destination = path.join(ssotDir(), name);
    if (stat(destination) && treeHash(fs.realpathSync(destination)) !== expected) throw new Error("Shared and managed skills have different contents; both were kept");
    const selected = new Set([...(existing?.targets || []).filter(id => id !== "agents"), ...["codex", "gemini", "opencode"].filter(id => TARGETS[id])]);
    const targets = [];
    for (const [id, target] of Object.entries(TARGETS)) {
      if (id === "agents" || target.manageable === false) continue;
      for (const dir of targetDirs(target)) {
        const file = path.join(dir, name), info = stat(file);
        if (info && fs.realpathSync(file) === source) selected.add(id);
      }
    }
    for (const id of selected) for (const dir of targetDirs(TARGETS[id])) {
      const file = path.join(dir, name), info = stat(file);
      if (info && treeHash(fs.realpathSync(file)) !== expected) throw new Error(`${id}: existing skill has different contents; nothing was moved`);
      targets.push({ id, file, existed: Boolean(info), linkText: info?.isSymbolicLink() ? fs.readlinkSync(file) : null });
    }
    const recovery = path.join(receiptRoot(), crypto.randomUUID()); privateParents(recovery);
    const manifestFile = path.join(recovery, "manifest.json"), staged = path.join(recovery, "staged");
    fs.cpSync(source, staged, { recursive: true, dereference: false, ...(process.platform === "win32" ? { filter: () => true } : {}) });
    if (treeHash(staged) !== expected || treeHash(source) !== expected) throw new Error("Skill changed while creating the verified recovery copy");
    const manifest = { version: 1, directory: name, status: "prepared", hash: expected, source: shared.path, destination, targets, previousSkill: existing || null, createdAt: Date.now() };
    write(manifestFile, manifest);
    const oldManaged = path.join(recovery, "managed-before"), original = path.join(recovery, "shared-before");
    try {
      if (stat(destination)) fs.renameSync(destination, oldManaged);
      fs.renameSync(staged, destination);
      if (treeHash(source) !== expected) throw new Error("Shared skill changed before handover");
      fs.renameSync(shared.path, original);
      for (const [index, target] of targets.entries()) {
        privateParents(path.dirname(target.file));
        if (target.existed) { if (target.linkText !== null ? !stat(target.file)?.isSymbolicLink() || fs.readlinkSync(target.file) !== target.linkText : treeHash(fs.realpathSync(target.file)) !== expected) throw new Error("Target skill changed before handover"); fs.renameSync(target.file, path.join(recovery, `target-${index}`)); }
        try { fs.symlinkSync(destination, target.file, "dir"); }
        catch { fs.cpSync(destination, target.file, { recursive: true }); }
        target.projection = projectionReceipt(target.file);
        target.written = true; write(manifestFile, manifest);
      }
      const fresh = readRegistry();
      const row = fresh.skills.find(item => item.directory.toLowerCase() === name.toLowerCase());
      // Never carry a pre-download registry snapshot into this checkpoint.
      if (!equal(row || null, existing || null)) throw new Error("Skill registry changed during handover");
      const details = metadata(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"), name);
      const value = { ...row, id: row?.id || `local:${name}`, key: row?.key || `local:${name}`, directory: name, name: details.name, description: details.description, targets: [...selected], installedAt: row?.installedAt || Date.now(), sharedHandover: recovery };
      manifest.desiredSkill = value; write(manifestFile, manifest);
      fresh.skills = [...fresh.skills.filter(item => item.id !== value.id), value]; saveRegistry(fresh);
      manifest.status = "complete"; write(manifestFile, manifest);
      return { directory: name, ok: true, recoveryPath: recovery, targets: [...selected] };
    } catch (error) {
      manifest.status = "recovery-required"; write(manifestFile, manifest);
      try { recover(path.basename(recovery)); }
      catch (recoveryError) { throw new Error(`${error.message}; ${recoveryError.message}; recovery receipt: ${path.basename(recovery)}`); }
      throw error;
    }
  }
  const handBack = id => {
    const registry = readRegistry(), row = registry.skills.find(item => item.id === id);
    if (!row?.sharedHandover) throw new Error("This skill has no shared handover receipt");
    const name = safeName(row.directory), shared = path.join(root(), name), destination = path.join(ssotDir(), name);
    if (stat(shared)) throw new Error("A shared skill already exists; both copies were kept");
    privateParents(root()); privateParents(ssotDir());
    const expected = treeHash(fs.realpathSync(destination));
    const recovery = path.join(receiptRoot(), crypto.randomUUID()); privateParents(recovery);
    const manifestFile = path.join(recovery, "manifest.json");
    const manifest = { version: 1, directory: name, skillId: row.id, previousSkill: row, status: "prepared", direction: "hand-back", hash: expected, source: destination, destination: shared, createdAt: Date.now() }; write(manifestFile, manifest);
    // Preserve the current managed content, including edits since handover.
    if (stat(destination).isSymbolicLink()) throw new Error("Managed skill is redirected; handback kept both locations");
    fs.renameSync(destination, shared);
    try { fs.symlinkSync(shared, destination, "dir"); } catch (error) { fs.renameSync(shared, destination); manifest.status = "rolled-back"; write(manifestFile, manifest); throw error; }
    const fresh = readRegistry(), latest = fresh.skills.find(item => item.id === id);
    if (!equal(latest, row)) throw new Error("Skill registry changed during handback; the receipt was kept");
    latest.targets = [...new Set([...(latest.targets || []), "agents"])]; latest.sharedHandover = null; saveRegistry(fresh);
    manifest.status = "complete"; write(manifestFile, manifest); return { ok: true, directory: name, recoveryPath: recovery };
  };
  const recover = recoveryId => {
    if (typeof recoveryId !== "string" || !/^[a-f0-9-]{36}$/.test(recoveryId)) throw new Error("Invalid shared skill recovery id");
    const recovery = path.join(receiptRoot(), recoveryId); privateParents(recovery);
    const file = path.join(recovery, "manifest.json"); if (stat(file)?.isSymbolicLink()) throw new Error("Shared skill receipt is redirected");
    const value = JSON.parse(fs.readFileSync(file, "utf8")); const name = safeName(value.directory);
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.hash)) throw new Error("Shared skill receipt is invalid");
    if (["complete", "rolled-back"].includes(value.status)) return { ok: true, changed: false };
    const shared = path.join(root(), name), managed = path.join(ssotDir(), name);
    privateParents(root()); privateParents(ssotDir());
    if (value.direction === "hand-back") {
      if (value.source !== managed || value.destination !== shared || !stat(shared) || treeHash(fs.realpathSync(shared)) !== value.hash || (stat(managed) && (!stat(managed).isSymbolicLink() || fs.realpathSync(managed) !== fs.realpathSync(shared)))) throw new Error("Skill changed during handback; both locations were kept");
      if (!stat(managed)) fs.symlinkSync(shared, managed, "dir");
      const fresh = readRegistry(), row = fresh.skills.find(item => item.id === value.skillId);
      if (!row || (value.previousSkill && !equal(row, value.previousSkill) && row.sharedHandover !== null)) throw new Error("Skill registry changed during handback; the receipt was kept");
      row.sharedHandover = null; row.targets = [...new Set([...(row.targets || []), "agents"])]; saveRegistry(fresh); value.status = "complete";
    } else {
      if (value.source !== shared || value.destination !== managed || !Array.isArray(value.targets)) throw new Error("Invalid skill recovery paths");
      for (const target of value.targets) if (!TARGETS[target.id] || !targetDirs(TARGETS[target.id]).some(dir => target.file === path.join(dir, name))) throw new Error("Invalid skill recovery target");
      const fresh = readRegistry(), current = fresh.skills.find(row => row.directory === name);
      if (current?.sharedHandover === recovery && value.desiredSkill && !equal(current, value.desiredSkill)) throw new Error("Skill registry changed after handover; recovery kept it");
      if (current && current.sharedHandover !== recovery && !equal(current, value.previousSkill)) throw new Error("Skill registry changed during handover; recovery kept it");
      const original = path.join(recovery, "shared-before"), oldManaged = path.join(recovery, "managed-before");
      if (stat(shared) && treeHash(fs.realpathSync(shared)) !== value.hash) throw new Error("Shared skill changed during recovery; it was kept");
      if (stat(managed) && treeHash(fs.realpathSync(managed)) !== value.hash) throw new Error("Managed skill changed during recovery; it was kept");
      // Check every target before restoring any path, so an outside edit
      // leaves the whole receipt available for a later recovery.
      for (const [index, target] of value.targets.entries()) {
        const info = stat(target.file);
        if (!info) continue;
        if (info.isSymbolicLink() && target.existed && !stat(path.join(recovery, `target-${index}`)) && fs.readlinkSync(target.file) === target.linkText) continue;
        if (treeHash(fs.realpathSync(target.file)) !== value.hash) throw new Error("Target skill changed; recovery kept it");
      }
      if (stat(original) && !stat(shared)) fs.renameSync(original, shared);
      for (const [index, target] of value.targets.entries()) {
        privateParents(path.dirname(target.file)); const backup = path.join(recovery, `target-${index}`);
        if (stat(backup)) {
          if (stat(target.file)) { if (treeHash(fs.realpathSync(target.file)) !== value.hash) throw new Error("Target skill changed; recovery kept it"); fs.rmSync(target.file, { recursive: true, force: true }); }
          fs.renameSync(backup, target.file);
        } else if (!target.existed && stat(target.file)) {
          if (treeHash(fs.realpathSync(target.file)) !== value.hash) throw new Error("Target skill changed; recovery kept it"); fs.rmSync(target.file, { recursive: true, force: true });
        }
      }
      if (stat(oldManaged)) { if (stat(managed)) fs.rmSync(managed, { recursive: true, force: true }); fs.renameSync(oldManaged, managed); }
      else if (!value.previousSkill && stat(managed)) fs.rmSync(managed, { recursive: true, force: true });
      fresh.skills = fresh.skills.filter(row => row.sharedHandover !== recovery);
      if (value.previousSkill && !fresh.skills.some(row => row.id === value.previousSkill.id)) fresh.skills.push(value.previousSkill); saveRegistry(fresh); value.status = "rolled-back";
    }
    write(file, value); return { ok: true, changed: true };
  };
  const listRecovery = () => {
    privateParents(receiptRoot(), false);
    if (!stat(receiptRoot())) return [];
    return fs.readdirSync(receiptRoot()).filter(id => /^[a-f0-9-]{36}$/.test(id)).flatMap(id => {
      const directory = path.join(receiptRoot(), id), file = path.join(directory, "manifest.json");
      privateParents(directory, false);
      if (!stat(file) || !stat(file).isFile() || stat(file).isSymbolicLink()) return [];
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (["complete", "rolled-back"].includes(value.status)) return [];
      return [{ id, directory: safeName(value.directory), direction: value.direction || "hand-over", status: value.status }];
    });
  };
  const ownsTarget = (directory, targetPath) => {
    const name = safeName(directory), row = readRegistry().skills.find(item => item.directory === name && !item.trashedAt);
    if (!row?.sharedHandover) return false;
    const recovery = row.sharedHandover;
    if (typeof recovery !== "string" || path.dirname(recovery) !== receiptRoot() || !/^[a-f0-9-]{36}$/.test(path.basename(recovery))) throw new Error("Invalid shared skill handover receipt");
    privateParents(recovery, false);
    const file = path.join(recovery, "manifest.json"), info = stat(file);
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error("Shared skill handover receipt is missing or redirected");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    if (manifest.version !== 1 || manifest.status !== "complete" || manifest.directory !== name || manifest.destination !== path.join(ssotDir(), name) || !Array.isArray(manifest.targets)) return false;
    const target = manifest.targets.find(item => item.file === targetPath);
    if (!target?.written || !target.projection || !TARGETS[target.id] || !targetDirs(TARGETS[target.id]).some(dir => targetPath === path.join(dir, name)) || !stat(targetPath)) return false;
    // Matching contents or a symlink destination alone cannot establish
    // ownership: a user can replace either after the verified handover.
    return equal(projectionReceipt(targetPath), target.projection);
  };
  return { handOver, handBack, recover, listRecovery, ownsTarget };
}
module.exports = { createController, sharedInfo, treeHash };
