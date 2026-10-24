"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const YAML = require("yaml");
const jsonc = require("jsonc-parser");
const paths = require("./paths");
const { withFileLock, writeFileAtomic } = require("../fs");
const mcp = require("./mcp");
const skills = require("./skills");
const envrefs = require("./mcp-envrefs");
const ROLE_APPS = ["claude", "codex", "gemini", "opencode", "grokbuild"];
const PROJECT_APPS = ["claude", "codex", "gemini", "opencode", "grokbuild", "pi", "agy"];
const PROJECT_MCP_APPS = ["claude", "gemini", "opencode"];
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const file = () => path.join(paths.providerSwitchRoot(), "distribution.json");
async function read(filePath) { try { return await fs.readFile(filePath, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function load() { const raw = await read(file()); if (!raw) return { subagents: [], projects: [], owned: {} }; try { const doc = JSON.parse(raw); if (!Array.isArray(doc.subagents) || !Array.isArray(doc.projects) || !doc.owned) throw new Error(); return doc; } catch { throw new Error("Library distribution state is unreadable"); } }
async function list() { return { ...await load(), roleApps: ROLE_APPS, projectApps: PROJECT_APPS, projectMcpApps: PROJECT_MCP_APPS, mcp: await mcp.listServers(), skills: await skills.listSkills() }; }
function name(value) { if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(value) || ["main", "default", "system", "user", "tool", "config", "self", "model"].includes(value)) throw new Error("Use a unique lowercase subagent name, 2–50 letters, digits or hyphens"); return value; }
function selected(value, supported) { if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(id => !supported.includes(id))) throw new Error("Invalid distribution client selection"); return value; }
function rolePath(app, id) {
  const home = os.homedir(), roots = { claude: ".claude", codex: ".codex", gemini: ".gemini", opencode: ".config/opencode", grokbuild: ".grok" };
  return path.join(home, roots[app], "agents", `${id}.${app === "codex" ? "toml" : "md"}`);
}
function role(row, app) {
  if (app === "codex") return require("smol-toml").stringify({ name: row.name, description: row.description, developer_instructions: row.prompt });
  const data = app === "opencode" ? { description: row.description, mode: "subagent" } : { name: row.name, description: row.description };
  if (app === "claude") { if (row.skills.length) data.skills = row.skills; if (row.mcp.length) data.mcpServers = row.mcp; }
  return `---\n${YAML.stringify(data)}---\n\n${row.prompt.trimEnd()}\n`;
}
async function boundary(target, root) {
  const physical = await fs.realpath(root);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Distribution path escaped its root");
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (stat?.isSymbolicLink()) throw new Error("Distribution target uses a user symlink; kept unchanged");
    if (stat) {
      const real = await fs.realpath(current), rel = path.relative(physical, real);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Distribution target escaped its physical root");
    }
  }
}
async function skillFiles(source) {
  const root = await fs.realpath(source), out = [];
  let bytes = 0;
  async function walk(dir, depth = 0) {
    if (depth > 30) throw new Error("Skill directory nesting exceeds distribution limits");
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (/[\x00-\x1f\x7f]/.test(entry.name)) throw new Error("Skill filenames contain unsafe control characters");
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Project skill copies cannot contain symlinks");
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else if (entry.isFile()) {
        const stat = await fs.stat(absolute); bytes += stat.size;
        if (bytes > 16 * 1024 * 1024 || out.length >= 500) throw new Error("Skill exceeds project distribution limits");
        const data = await fs.readFile(absolute);
        out.push({ path: path.relative(root, absolute), data: data.toString("base64"), hash: hash(data), mode: 0o600 | (stat.mode & 0o111) });
      } else throw new Error("Skill contains a special file");
    }
  }
  await walk(root);
  if (!out.some(row => row.path === "SKILL.md")) throw new Error("Skill has no SKILL.md");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
async function preview(input) {
  const store = await load(), row = structuredClone(input.row || {}), changes = [], errors = [];
  if (!["subagent", "project"].includes(input.kind)) throw new Error("Unknown distribution kind");
  row.apps = selected(row.apps, input.kind === "subagent" ? ROLE_APPS : PROJECT_APPS);
  row.skills = selected(row.skills || [], (await skills.listSkills()).map(item => item.id));
  row.mcp = selected(row.mcp || [], (await mcp.listServers()).map(item => item.id));
  let id, root;
  if (input.kind === "subagent") {
    row.name = name(row.name); id = `role:${row.name}`; root = os.homedir();
    if (typeof row.description !== "string" || !row.description.trim() || row.description.length > 1000 || typeof row.prompt !== "string" || !row.prompt.trim() || row.prompt.length > 100000) throw new Error("Subagent requires a description and prompt within size limits");
    for (const app of row.apps) changes.push({ path: rolePath(app, row.name), next: role(row, app), app });
  } else {
    if (typeof row.dir !== "string" || !path.isAbsolute(row.dir)) throw new Error("Select an absolute project directory");
    row.dir = await fs.realpath(row.dir); root = row.dir; id = `project:${row.dir}`;
    if (!(await fs.stat(root)).isDirectory() || root === path.parse(root).root || root === os.homedir()) throw new Error("Select a specific project directory");
    const catalog = await skills.listSkills();
    for (const skillId of row.skills) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(skillId)) throw new Error("Unsafe skill directory name");
      const skill = catalog.find(item => item.id === skillId), files = await skillFiles(skill.sourceDir);
      const dirs = new Set(row.apps.map(app => app === "claude" ? ".claude/skills" : ".agents/skills"));
      for (const dir of dirs) for (const entry of files) changes.push({ path: path.join(root, dir, skillId, entry.path), next: entry.data, binary: true, sourceHash: entry.hash, mode: entry.mode, app: [...row.apps].join(",") });
    }
    const servers = await mcp.listServers();
    const mappings = { claude: [".mcp.json", "mcpServers"], gemini: [".gemini/settings.json", "mcpServers"], opencode: ["opencode.json", "mcp"] };
    for (const app of row.apps.filter(app => PROJECT_MCP_APPS.includes(app))) {
      const [relative, mapKey] = mappings[app], target = path.join(root, relative), before = await read(target);
      const parseErrors = [], doc = jsonc.parse(before || "{}", parseErrors, { allowTrailingComma: true });
      if (parseErrors.length || !doc || typeof doc !== "object" || Array.isArray(doc) || (doc[mapKey] && (typeof doc[mapKey] !== "object" || Array.isArray(doc[mapKey])))) throw new Error("Invalid project MCP configuration");
      const tree = jsonc.parseTree(before || "{}");
      function unique(node) {
        if (node?.type === "object") {
          const keys = node.children.map(child => child.children[0].value);
          if (new Set(keys).size !== keys.length) throw new Error("Duplicate project MCP configuration fields");
        }
        for (const child of node?.children || []) unique(child);
      }
      unique(tree);
      const receipt = store.owned[target];
      const original = receipt?.pendingHash === hash(before || "") ? receipt.pendingEntries || {} : receipt?.entries || {};
      let next = before || "{}\n", entries = {};
      for (const [serverId, expected] of Object.entries(original)) {
        if (JSON.stringify(doc[mapKey]?.[serverId]) !== JSON.stringify(expected)) errors.push(`${app}/${serverId}: user changed the managed MCP entry`);
        if (!row.mcp.includes(serverId)) next = jsonc.applyEdits(next, jsonc.modify(next, [mapKey, serverId], undefined, {}));
      }
      for (const serverId of row.mcp) {
        if (doc[mapKey]?.[serverId] !== undefined && !Object.hasOwn(original, serverId)) { errors.push(`${app}/${serverId}: user MCP entry already exists`); continue; }
        const selectedServer = servers.find(server => server.id === serverId);
        if (selectedServer.disabledTools?.[app]?.length) throw new Error("Project MCP cannot project this client's per-tool restrictions yet; keep it in the global scope");
        const spec = envrefs.projectReferences(app, selectedServer.server);
        const native = app === "opencode" ? mcp.toOpencodeSpec(spec) : spec;
        entries[serverId] = native;
        next = jsonc.applyEdits(next, jsonc.modify(next, [mapKey, serverId], native, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      }
      if (row.mcp.length || Object.keys(original).length) changes.push({ path: target, next, app, entries, partial: true });
    }
    if (row.mcp.length && row.apps.some(app => !PROJECT_MCP_APPS.includes(app))) errors.push("Selected clients without project MCP support can receive skills only; remove MCP selection or choose supported clients");
    const target = path.join(root, ".gitignore"), before = await read(target);
    const begin = "# >>> AiTool project distribution >>>", end = "# <<< AiTool project distribution <<<";
    const managed = (before || "").match(/# >>> AiTool project distribution >>>\n[\s\S]*?# <<< AiTool project distribution <<</);
    if ((before || "").includes(begin) && !managed) throw new Error("Invalid AiTool gitignore block; review it first");
    const ignored = new Set(changes.map(change => path.relative(root, change.path).split(path.sep).join("/")));
    const lines = [...ignored].sort().map(relative => `/${relative.replace(/([*?\[\]\\ !#])/g, "\\$1")}`);
    const block = lines.length ? `${begin}\n${lines.join("\n")}\n${end}` : "";
    const next = managed ? before.replace(managed[0], block) : `${before || ""}${before && !before.endsWith("\n") ? "\n" : ""}${block}${block ? "\n" : ""}`;
    if (managed || lines.length) changes.push({ path: target, next, app: "git", ignoreBlock: block, partial: true });
  }
  const desired = new Set(changes.map(item => item.path));
  for (const [target, receipt] of Object.entries(store.owned)) if (receipt.owner === id && !desired.has(target)) {
    if (receipt.ignoreBlock !== undefined || receipt.pendingIgnoreBlock !== undefined) {
      const before = await read(target);
      const block = (before || "").match(/# >>> AiTool project distribution >>>\n[\s\S]*?# <<< AiTool project distribution <<</)?.[0];
      if (block && ![receipt.ignoreBlock, receipt.pendingIgnoreBlock].includes(block)) errors.push("git: user changed the managed gitignore block");
      changes.push({ path: target, next: block ? before.replace(block, "") : before, app: receipt.app, partial: true, ignoreBlock: "", release: !block });
    } else if (receipt.entries && !Object.keys(receipt.entries).length && !receipt.pendingEntries) {
      changes.push({ path: target, next: await read(target), app: receipt.app, partial: true, release: true });
    } else changes.push({ path: target, next: null, app: receipt.app });
  }
  const unique = new Map();
  for (const change of changes) unique.set(change.path, change);
  const ordered = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const change of ordered) {
    try {
      await boundary(change.path, root);
      const stat = await fs.lstat(change.path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (stat && !stat.isFile()) throw new Error("Target is not a regular file");
      if (stat?.size > 16 * 1024 * 1024) throw new Error("Target file is too large");
      const before = stat ? await fs.readFile(change.path) : null;
      change.beforeHash = before ? hash(before) : null;
      change.beforeMode = stat ? stat.mode & 0o777 : null;
      const receipt = store.owned[change.path];
      if (receipt && receipt.owner !== id) throw new Error("Target belongs to another library item");
      if (change.ignoreBlock !== undefined) {
        const original = before?.toString().match(/# >>> AiTool project distribution >>>\n[\s\S]*?# <<< AiTool project distribution <<</)?.[0];
        if (original && ![receipt?.ignoreBlock, receipt?.pendingIgnoreBlock].includes(original)) throw new Error("User gitignore block exists or was edited");
      }
      if (before && !change.partial && (!receipt || ![receipt.hash, receipt.pendingHash].includes(change.beforeHash))) throw new Error("User file already exists or was edited; kept unchanged");
      if (change.next === null && receipt?.entries && !change.release) throw new Error("Remove project MCP selections while retaining their app first; whole user config will not be removed");
    } catch (error) { errors.push(`${change.app}: ${error.message}`); }
  }
  const revision = hash(JSON.stringify({ store, input: { kind: input.kind, row }, ordered }));
  return { kind: input.kind, row, id, root, changes: ordered, errors, revision };
}
async function apply(input) {
  return withFileLock(file(), async () => {
    const plan = await preview(input);
    if (plan.errors.length) throw new Error(plan.errors.join("\n"));
    if (!input.revision || input.revision !== plan.revision) throw Object.assign(new Error("Distribution preview changed; preview again"), { status: 409 });
    const store = await load(), results = [], recovery = path.join(paths.providerSwitchRoot(), "distribution-backups", crypto.randomUUID());
    await fs.mkdir(recovery, { recursive: true, mode: 0o700 });
    const manifest = { version: 1, owner: plan.id, createdAt: new Date().toISOString(), files: plan.changes.map((change, index) => ({ target: change.path, beforeHash: change.beforeHash, beforeMode: change.beforeMode, existed: change.beforeHash !== null, backup: change.beforeHash !== null ? `${index}.bak` : null, status: "skipped" })) };
    await stateSave();
    for (const change of plan.changes) {
      const entry = manifest.files[results.length];
      try {
        await withFileLock(change.path, async () => {
          await boundary(change.path, plan.root);
          const before = await fs.readFile(change.path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
          const beforeMode = before ? (await fs.stat(change.path)).mode & 0o777 : null;
          if ((before ? hash(before) : null) !== change.beforeHash || beforeMode !== change.beforeMode) throw new Error("File changed since preview");
          if (before) await writeFileAtomic(path.join(recovery, `${results.length}.bak`), before, { mode: 0o600 });
          const next = change.next === null ? null : change.binary ? Buffer.from(change.next, "base64") : Buffer.from(change.next);
          const previous = store.owned[change.path];
          entry.status = "pending"; await stateSave();
          store.owned[change.path] = { ...previous, owner: plan.id, app: change.app, pendingHash: next ? hash(next) : null, hash: previous?.hash || null, pendingEntries: change.entries, pendingIgnoreBlock: change.ignoreBlock, backup: before ? path.join(recovery, `${results.length}.bak`) : null };
          await writeFileAtomic(file(), JSON.stringify(store, null, 2), { mode: 0o600 });
          if (!change.release) {
            if (next) {
              await writeFileAtomic(change.path, next, { mode: change.mode ?? 0o600 });
              if (change.mode !== undefined) await fs.chmod(change.path, change.mode);
            } else await fs.rm(change.path, { force: true });
          }
          if (next && !change.release && change.ignoreBlock !== "") store.owned[change.path] = { ...store.owned[change.path], hash: hash(next), pendingHash: undefined, entries: change.entries, ignoreBlock: change.ignoreBlock, pendingEntries: undefined, pendingIgnoreBlock: undefined };
          else delete store.owned[change.path];
          await writeFileAtomic(file(), JSON.stringify(store, null, 2), { mode: 0o600 });
        });
        results.push({ path: change.path, status: "applied" });
        entry.status = "applied"; await stateSave();
      } catch (error) { entry.status = "failed"; entry.error = error.message; results.push({ path: change.path, status: "failed", error: error.message }); await stateSave(); break; }
    }
    for (const entry of manifest.files.filter(row => row.status === "skipped")) results.push({ path: entry.target, status: "skipped" });
    const collection = plan.kind === "subagent" ? "subagents" : "projects", identity = plan.kind === "subagent" ? "name" : "dir";
    store[collection] = [...store[collection].filter(row => row[identity] !== plan.row[identity]), { ...plan.row, partial: results.some(row => row.status === "failed") }];
    await writeFileAtomic(file(), JSON.stringify(store, null, 2), { mode: 0o600 });
    await require("./recovery-retention").pruneRecovery("distribution-backups", recovery).catch(() => {});
    return { results, recoveryPath: recovery };
    async function stateSave() { await writeFileAtomic(path.join(recovery, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 }); }
  });
}
module.exports = { list, preview, apply, role, rolePath, skillFiles, ROLE_APPS, PROJECT_APPS, PROJECT_MCP_APPS };
