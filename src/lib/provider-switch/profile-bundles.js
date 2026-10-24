"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const YAML = require("yaml");
const { parse } = require("smol-toml");
const { writeFileAtomic, withFileLock } = require("../fs");
const paths = require("./paths");
const store = require("./store");
const profiles = require("./profiles");
const mcp = require("./mcp");
const skills = require("./skills");
const prompts = require("./prompts");
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function readSnapshot(app) {
  const files = [...paths.targetFiles(app), { id: "mcp", ...mcp.mcpLiveFiles()[app] }, { id: "prompt", path: prompts.promptFilePath(app), format: "text" }];
  if (app === "codex") files.push({ id: "catalog", path: paths.codexModelCatalogPath(), format: "json" });
  const seen = new Set(), live = [];
  for (const file of files) {
    if (!file.path || seen.has(file.path)) continue; seen.add(file.path);
    let content = null;
    try { content = await fs.readFile(file.path, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (content?.trim()) {
      const format = file.format || (file.path.endsWith(".toml") ? "toml" : file.path.endsWith(".yaml") ? "yaml" : "json");
      if (format === "json") JSON.parse(content);
      else if (format === "toml") parse(content);
      else if (format === "yaml") YAML.parse(content);
    }
    live.push({ path: file.path, content });
  }
  const [providers, servers, allSkills, appPrompts] = await Promise.all([store.listProviders(app), mcp.listServers(), skills.listSkills(), prompts.listPrompts(app)]);
  const links = [];
  for (const skill of allSkills) {
    const target = path.join(skills.appSkillsDir(app), skill.id);
    try {
      const stat = await fs.lstat(target);
      if (!stat.isSymbolicLink() && !stat.isDirectory()) throw new Error("Skill target is not a directory or link");
      const files = stat.isDirectory() ? (await require("./library-distribution").skillFiles(target)).map(({ path, hash }) => ({ path, hash })) : undefined;
      links.push({ id: skill.id, target, type: stat.isSymbolicLink() ? "link" : "directory", identity: stat.isSymbolicLink() ? await fs.readlink(target) : [stat.dev, stat.ino, stat.mtimeMs], files });
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { live, links, providers, servers: servers.map(row => ({ id: row.id, server: row.server, enabled: row.apps?.[app] === true, disabledTools: row.disabledTools?.[app] })),
    skills: allSkills.map(row => ({ id: row.id, sourceDir: row.sourceDir, enabled: row.apps?.[app] === true })), prompts: appPrompts };
}

async function preview({ id, apps }) {
  const selected = profiles.validateApps(apps);
  const profile = (await profiles.listProfiles()).profiles.find(row => row.id === id);
  if (!profile) throw new Error("Profile not found");
  const states = {}, results = [];
  for (const app of selected) {
    const captured = profiles.scopeCaptured(profile, app);
    const errors = [];
    if (!captured) errors.push("No configuration captured for this app");
    let snapshot;
    try {
      snapshot = await readSnapshot(app); states[app] = snapshot;
      const payload = profile.payload;
      const providerId = payload.providers[app];
      if (providerId && !snapshot.providers.providers.some(row => row.id === providerId)) errors.push(`Provider not found: ${providerId}`);
      for (const serverId of payload.mcp[app] || []) if (!snapshot.servers.some(row => row.id === serverId)) errors.push(`MCP server not found: ${serverId}`);
      for (const skillId of payload.skills[app] || []) {
        const skill = snapshot.skills.find(row => row.id === skillId);
        if (!skill) errors.push(`Skill not found: ${skillId}`);
        else { try { await fs.access(path.join(skill.sourceDir, "SKILL.md")); } catch { errors.push(`Skill source is missing: ${skillId}`); } }
      }
      const promptId = payload.prompts[app];
      if (promptId && !snapshot.prompts.some(row => row.id === promptId)) errors.push(`Prompt not found: ${promptId}`);
    } catch (error) { errors.push(error.message); }
    results.push({ app, ready: !errors.length, errors, providerId: profile.payload.providers[app],
      mcpCount: profile.payload.mcp[app]?.length ?? null, skillCount: profile.payload.skills[app]?.length ?? null, promptId: profile.payload.prompts[app] });
  }
  return { profile, apps: selected, states, results, revision: digest([profile, selected, states]) };
}

async function apply({ id, apps, revision, applyProvider }) {
  return withFileLock(path.join(paths.providerSwitchRoot(), "profile-bundle.projection"), async () => {
    const plan = await preview({ id, apps });
    if (!revision || revision !== plan.revision) throw Object.assign(new Error("Profile or configuration changed; reload the preview"), { status: 409 });
    if (plan.results.some(row => !row.ready)) throw new Error("Fix the profile references before applying");
    const recoveryPath = path.join(paths.providerSwitchRoot(), "profile-recovery", crypto.randomUUID());
    await fs.mkdir(recoveryPath, { recursive: true, mode: 0o700 });
    let applicationStarted = false;
    try {
      const manifest = { version: 1, profileId: id, apps: plan.apps, createdAt: new Date().toISOString(), files: [], links: [], results: [] };
      // Capture every affected config and store before the first application.
      const allFiles = new Map();
      for (const snapshot of Object.values(plan.states)) for (const file of snapshot.live) allFiles.set(file.path, file.content);
      for (const file of [paths.storePath(), paths.mcpStorePath(), paths.promptsStorePath(), paths.profilesStorePath(), paths.codexAuthStashPath(),
        path.join(paths.providerSwitchRoot(), "skills.json"), path.join(paths.providerSwitchRoot(), "mcp-tool-rules.json"), path.join(paths.providerSwitchRoot(), "projection-receipts.json")]) {
        try { allFiles.set(file, await fs.readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; allFiles.set(file, null); }
      }
      for (const [target, content] of allFiles) {
        const backup = content === null ? null : `${manifest.files.length}.txt`;
        if (backup) await writeFileAtomic(path.join(recoveryPath, backup), content, { mode: 0o600 });
        manifest.files.push({ target, backup, existed: content !== null });
      }
      for (const state of Object.values(plan.states)) for (const link of state.links) {
        const entry = { ...link };
        if (link.type === "directory") {
          const files = await require("./library-distribution").skillFiles(link.target);
          if (digest(files.map(({ path, hash }) => ({ path, hash }))) !== digest(link.files)) throw new Error("Skill changed while creating recovery copies");
          entry.backup = `skills/${manifest.links.length}`;
          for (const item of files) await writeFileAtomic(path.join(recoveryPath, entry.backup, item.path), Buffer.from(item.data, "base64"), { mode: 0o600 });
        }
        manifest.links.push(entry);
      }
      await save();
      if ((await preview({ id, apps })).revision !== plan.revision) throw Object.assign(new Error("Profile or configuration changed while creating recovery copies; reload the preview"), { status: 409 });
      applicationStarted = true;
      for (const app of plan.apps) {
        let result;
        try {
          // Earlier applications can legitimately change the shared stores.
          // Recheck this app's files against its original preflight snapshot.
          const fresh = await readSnapshot(app);
          if (digest(fresh) !== digest(plan.states[app])) throw new Error("Live configuration or profile references changed during profile application");
          result = await profiles.applyProfile({ id, app, applyProvider });
          // Partial configuration belongs to neither the old nor new profile.
          // Clearing the marker also prevents autosave from corrupting either.
          if (result.warnings.length) await profiles.restoreCurrentMarker(app, null);
          manifest.results.push({ app, status: result.warnings.length ? "partial" : "applied", warnings: result.warnings });
        } catch (error) { await profiles.restoreCurrentMarker(app, null); manifest.results.push({ app, status: "failed", warnings: [error.message] }); }
        await save();
      }
      await require("./recovery-retention").pruneRecovery("profile-recovery", recoveryPath).catch(() => {});
      return { ok: true, results: manifest.results, recoveryPath };
      async function save() { await writeFileAtomic(path.join(recoveryPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); }
    } finally {
      // A rejected second preflight has not written any live state.
      if (!applicationStarted) await fs.rm(recoveryPath, { recursive: true, force: true });
    }
  });
}

module.exports = { preview, apply };
