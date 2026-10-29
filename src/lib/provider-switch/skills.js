const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readJson, updateJsonLocked, withFileLock, ensureDir } = require("../fs");
const paths = require("./paths");

// Skills management, a v1 port of cc-switch's services/skill.rs: one SSOT
// list of skills (skills.json) discovered from the agents' skills
// directories, projected into each app's skills directory on toggle. A
// symlink is preferred and falls back to a full copy when symlinking fails
// (Windows without developer mode); a copy is marked with a
// .aitool-skill-copy stamp so disable only ever removes what we wrote and
// user-managed directories are never touched.
//
// Scope notes vs cc-switch: no repo discovery/install/update yet — this v1
// scans and projects locally present skills (import → toggle → sync).

const SKILL_APPS = ["claude", "codex", "gemini", "agy", "grokbuild", "opencode", "hermes", "pi", "mcode", "kimi", "omp", "dsh"];

const COPY_STAMP_FILE = ".aitool-skill-copy";

// Per-app skills directories (cc-switch get_app_skills_dir defaults; AiTool
// has no per-app override settings yet). Hermes honors HERMES_HOME and mcode
// MINIMAX_DATA_DIR/MAVIS_DATA_DIR like the upstream configs do.
function appSkillsDir(app) {
  const home = os.homedir();
  switch (app) {
    case "claude": return path.join(home, ".claude", "skills");
    case "codex": return path.join(home, ".codex", "skills");
    case "agy": return path.join(home, ".gemini", "config", "skills");
    case "gemini": return path.join(home, ".gemini", "skills");
    case "grokbuild": return path.join(home, ".grok", "skills");
    case "opencode": return path.join(home, ".config", "opencode", "skills");
    case "hermes": return path.join(process.env.HERMES_HOME?.trim() || path.join(home, ".hermes"), "skills");
    case "pi": return path.join(home, ".pi", "agent", "skills");
    case "mcode": {
      const custom = [process.env.MINIMAX_DATA_DIR, process.env.MAVIS_DATA_DIR].find((value) => value && value.trim());
      return path.join(custom && custom.trim() ? custom.trim() : path.join(home, ".minimax"), "skills");
    }
    case "kimi": return path.join(process.env.KIMI_CODE_HOME?.trim() || path.join(home, ".kimi-code"), "skills");
    case "omp": return path.join(require("./omp").agentDir(), "skills");
    case "dsh": return path.join(process.env.DSH_HOME?.trim() || path.join(home, ".dsh"), "skills");
    default: return null;
  }
}

function skillsStorePath() {
  return path.join(paths.providerSwitchRoot(), "skills.json");
}

function emptyStore() {
  return { version: 1, skills: [], managedLinks: {} };
}

function normalizeStore(current) {
  const store = current && Array.isArray(current.skills) ? current : emptyStore();
  const skills = store.skills.filter((s) => s && typeof s === "object" && typeof s.id === "string" && s.id);
  const managedLinks = store.managedLinks && typeof store.managedLinks === "object" && !Array.isArray(store.managedLinks)
    ? store.managedLinks : {};
  return { version: 1, skills, managedLinks };
}

async function readSkillsStore() {
  return normalizeStore(await readJson(skillsStorePath()));
}

async function mutateSkillsStore(update) {
  await ensureDir(path.dirname(skillsStorePath()));
  return updateJsonLocked(skillsStorePath(), (current) => {
    const store = normalizeStore(current);
    const next = update(store);
    return next === undefined ? store : normalizeStore(next);
  });
}

// SKILL.md frontmatter: `---` delimited YAML-ish head; name/description are
// read line-wise (no YAML dependency for two scalar fields).
function parseSkillMeta(dir, skillMd) {
  let name = null;
  let description = null;
  const head = skillMd.split(/^---\s*$/m).find((part, index) => index === 1);
  const frontmatter = typeof head === "string" ? head : "";
  for (const line of frontmatter.split("\n")) {
    const match = /^(name|description):\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (match[1] === "name" && !name) name = value;
    if (match[1] === "description" && !description) description = value;
  }
  return {
    id: path.basename(dir),
    name: name || path.basename(dir),
    description: description || "",
  };
}

async function scanSkillsDir(dir) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
    const skillDir = path.join(dir, entry.name);
    try {
      const skillMd = await fsp.readFile(path.join(skillDir, "SKILL.md"), "utf8");
      found.push({ ...parseSkillMeta(skillDir, skillMd), sourceDir: skillDir });
    } catch {
      /* no SKILL.md — not a skill directory */
    }
  }
  return found;
}

// Discover skills across the agents' skills directories and merge them into
// the SSOT (cc-switch's scan + import). Existing entries keep their app
// toggles; only metadata and sourceDir refresh.
async function importSkills() {
  const locations = [path.join(os.homedir(), ".agents", "skills"), ...SKILL_APPS.map(appSkillsDir)];
  const byId = new Map();
  for (const location of locations) {
    for (const skill of await scanSkillsDir(location)) {
      if (!byId.has(skill.id)) byId.set(skill.id, skill);
    }
  }
  const discovered = [...byId.values()];
  await mutateSkillsStore((store) => {
    for (const skill of discovered) {
      const index = store.skills.findIndex((entry) => entry.id === skill.id);
      if (index === -1) {
        store.skills.push({ ...skill, apps: {} });
      } else {
        store.skills[index] = { ...store.skills[index], name: skill.name, description: skill.description, sourceDir: skill.sourceDir };
      }
    }
    return store;
  });
  return { skills: await listSkills(), discovered: discovered.length };
}

async function listSkills() {
  // The main library can hand over a source discovered here earlier. Resolve
  // only entries carrying its handover receipt; ordinary native sources stay
  // user-owned. Listing does not mutate either registry.
  let managed = [];
  try { const raw = JSON.parse(await fsp.readFile(path.join(os.homedir(), ".tokentracker", "skills", "registry.json"), "utf8")); managed = raw.skills || []; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return (await readSkillsStore()).skills.map(skill => {
    const owner = managed.find(row => row.directory === skill.id && row.sharedHandover && !row.trashedAt);
    const sourceDir = owner ? path.join(os.homedir(), ".tokentracker", "skills", "managed", skill.id) : skill.sourceDir;
    return { ...skill, sourceDir, shared: require("../shared-skills").sharedInfo(skill.id) };
  });
}

// Enable: symlink the skill into the app's skills dir, falling back to a
// stamped copy. Link receipts identify the link we actually created, so a
// pre-existing link (even to the same source), or a user's replacement, stays
// user-owned. Older unrecorded links cannot safely be claimed retroactively.
function linkIdentity(targetPath, stat = fs.lstatSync(targetPath)) {
  return JSON.stringify([stat.dev, stat.ino, stat.ctimeMs, fs.readlinkSync(targetPath)]);
}

function isManagedLinkOrCopy(targetPath, managedLinks = {}) {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) return managedLinks[targetPath] === linkIdentity(targetPath, stat);
    if (stat.isDirectory() && fs.existsSync(path.join(targetPath, COPY_STAMP_FILE))) return true;
  } catch {
    return false;
  }
  return false;
}

async function copySkill(sourceDir, targetPath) {
  // Do not copy through a link that appeared after the symlink attempt.
  await fsp.mkdir(targetPath);
  // Reserve the root exclusively, then copy its children. Node 24 rejects an
  // existing root with errorOnExist, even when it is the directory we created.
  for (const name of await fsp.readdir(sourceDir)) {
    if (name === COPY_STAMP_FILE) continue;
    await fsp.cp(path.join(sourceDir, name), path.join(targetPath, name), {
      recursive: true, force: false, errorOnExist: true,
    });
  }
  await fsp.writeFile(path.join(targetPath, COPY_STAMP_FILE), new Date().toISOString());
}

async function projectSkill(app, skill) {
  const enabled = skill.apps?.[app] === true;
  const targetDir = appSkillsDir(app);
  if (!targetDir) return `${app}: unsupported app`;
  const targetPath = path.join(targetDir, skill.id);
  // A discovered source directory remains user-owned, even if it contains a
  // copy stamp from an older installation.
  if (skill.sourceDir && path.resolve(skill.sourceDir) === path.resolve(targetPath)) return null;
  const { managedLinks } = await readSkillsStore();
  const isManaged = () => isManagedLinkOrCopy(targetPath, managedLinks)
    || require("../skills-manager").isSharedSkillTargetOwned(skill.id, targetPath);
  const removeManaged = async () => {
    if (!isManaged()) return;
    // No await between checking ownership and unlinking the entry.
    if (fs.lstatSync(targetPath).isSymbolicLink()) fs.unlinkSync(targetPath);
    else fs.rmSync(targetPath, { recursive: true, force: true });
    await mutateSkillsStore((store) => { delete store.managedLinks[targetPath]; });
  };
  if (!skill.sourceDir || !fs.existsSync(skill.sourceDir)) {
    // Source vanished: drop our projections so nothing dangling remains.
    await removeManaged();
    return enabled ? `${app}/${skill.id}: source directory is gone` : null;
  }
  if (!enabled) {
    // Disable: remove our symlink or stamped copy; anything else (the user's
    // own directory, the skill's source location) is never touched.
    await removeManaged();
    return null;
  }
  // The skill already lives in this app's skills directory: it is live by
  // definition, and projecting it onto itself would copy a directory onto
  // itself. realpathSync resolves through symlinks, which is exactly what we
  // want here — a projection created earlier points back at the source.
  let samePlace = false;
  try {
    samePlace = fs.realpathSync(skill.sourceDir) === fs.realpathSync(targetPath);
  } catch {
    /* one of the paths may not exist yet */
  }
  if (samePlace) return null;
  // A plain directory with the same id that we did not write is the user's:
  // refuse to replace it and surface the collision instead.
  if (fs.lstatSync(targetPath, { throwIfNoEntry: false }) && !isManaged()) {
    return `${app}/${skill.id}: a user-managed entry with this name exists`;
  }
  if (!fs.existsSync(path.dirname(targetDir))) {
    // The agent itself is not installed on this machine — skip silently,
    // same guard as the other projections.
    return null;
  }
  await ensureDir(targetDir);
  // Prepare a complete replacement before moving the old projection. A
  // failed fallback must never expose an incomplete skill at its live path.
  const staging = await fsp.mkdtemp(path.join(targetDir, ".aitool-skill-"));
  const prepared = path.join(staging, "next"), previous = path.join(staging, "previous");
  let moved = false, installed = false, committed = false;
  try {
    try { await fsp.symlink(skill.sourceDir, prepared, "dir"); }
    catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error.code)) throw error;
      await copySkill(skill.sourceDir, prepared);
    }
    // Recheck after copying, with no await between ownership and replacement.
    if (fs.lstatSync(targetPath, { throwIfNoEntry: false })) {
      if (!isManaged()) throw new Error("A user-managed entry appeared during skill projection");
      fs.renameSync(targetPath, previous); moved = true;
    }
    fs.renameSync(prepared, targetPath); installed = true;
    const receipt = fs.lstatSync(targetPath).isSymbolicLink() ? linkIdentity(targetPath) : null;
    await mutateSkillsStore(store => {
      if (receipt) store.managedLinks[targetPath] = receipt;
      else delete store.managedLinks[targetPath];
    });
    committed = true;
  } catch (error) {
    if (installed) fs.rmSync(targetPath, { recursive: true, force: true });
    if (moved) {
      fs.renameSync(previous, targetPath);
      moved = false;
      if (fs.lstatSync(targetPath).isSymbolicLink()) {
        await mutateSkillsStore(store => { store.managedLinks[targetPath] = linkIdentity(targetPath); });
      }
    }
    throw error;
  } finally {
    // Keep the original in staging if a filesystem failure prevented restore.
    if (!moved || committed) await fsp.rm(staging, { recursive: true, force: true });
  }
  return null;
}

async function toggleSkill(id, app, enabled) {
  if (!SKILL_APPS.includes(app)) throw new Error(`Skills are not supported for app: ${app}`);
  let skill = null;
  await mutateSkillsStore((store) => {
    const index = store.skills.findIndex((entry) => entry.id === id);
    if (index !== -1) {
      store.skills[index].apps = { ...store.skills[index].apps, [app]: enabled === true };
      skill = store.skills[index];
    }
    return store;
  });
  if (!skill) throw new Error(`Skill not found: ${id}`);
  skill = (await listSkills()).find(row => row.id === id);
  const failures = [];
  try {
    const failure = await projectSkill(app, skill);
    if (failure) failures.push(failure);
  } catch (error) {
    failures.push(`${app}/${id}: ${error?.message || String(error)}`);
  }
  return { skills: await listSkills(), failures };
}

async function syncSkills(apps) {
  const targets = Array.isArray(apps) && apps.length ? apps.filter((app) => SKILL_APPS.includes(app)) : SKILL_APPS.slice();
  const skills = await listSkills();
  const failures = [];
  for (const app of targets) {
    for (const skill of skills) {
      try {
        const failure = await projectSkill(app, skill);
        if (failure) failures.push(failure);
      } catch (error) {
        failures.push(`${app}/${skill.id}: ${error?.message || String(error)}`);
      }
    }
  }
  return { failures };
}

module.exports = {
  SKILL_APPS,
  COPY_STAMP_FILE,
  appSkillsDir,
  skillsStorePath,
  readSkillsStore,
  parseSkillMeta,
  scanSkillsDir,
  importSkills: (...args) => withFileLock(`${skillsStorePath()}.projection`, () => importSkills(...args)),
  listSkills,
  toggleSkill: (...args) => withFileLock(`${skillsStorePath()}.projection`, () => toggleSkill(...args)),
  syncSkills: (...args) => withFileLock(`${skillsStorePath()}.projection`, () => syncSkills(...args)),
  isManagedLinkOrCopy,
};
