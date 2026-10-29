"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { writeFileAtomic, withFileLock } = require("../fs");
const floor = require("./floor");
const { readJson, hash, withNativeLock, assertLocks } = require("./claude-account-runtime");
const equal = require("node:util").isDeepStrictEqual;
function stripSettings(doc) {
  const next = {};
  for (const [key, value] of Object.entries(doc || {})) {
    if (floor.isClaudeFloorTop(key)) continue;
    if (key === "env") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Claude environment settings must be an object");
      const env = Object.fromEntries(Object.entries(value || {}).filter(([name]) => !floor.isClaudeProjectedEnv(name) && !["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"].includes(name)));
      if (Object.keys(env).length) next.env = env;
    } else next[key] = value;
  }
  return next;
}
function mergeSettings(shared, current, previous) {
  current = stripSettings(current);
  const result = structuredClone(shared);
  for (const [key, value] of Object.entries(current)) {
    if (key === "cleanupPeriodDays") continue;
    if (previous ? !equal(value, previous[key]) : !Object.hasOwn(shared, key)) result[key] = value;
  }
  for (const key of Object.keys(previous || {})) if (key !== "cleanupPeriodDays" && !Object.hasOwn(current, key)) delete result[key];
  return result;
}
async function sync(runtime, slot) {
  await runtime.validateSlot(slot);
  const stateFile = path.join(path.dirname(slot.dir), ".mirror-state.json");
  await runtime.validateSlot(runtime.defaultSlot);
  return withFileLock(stateFile, async () => {
  const state = await readJson(stateFile, {});
  const defaults = runtime.defaultSlot.dir;
  for (const name of ["skills", "commands", "agents", "output-styles", "plugins", "rules", "workflows", "projects", "file-history", "todos", "plans"]) {
    const target = path.join(defaults, name), link = path.join(slot.dir, name);
    await fs.mkdir(target, { recursive: true });
    const stat = await fs.lstat(link).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (stat) {
      if (stat.isSymbolicLink()) { if (await fs.realpath(link) !== await fs.realpath(target)) throw new Error("Claude shared customization path conflicts with an existing link"); continue; }
      if (!stat.isDirectory() || (await fs.readdir(link)).length) continue;
      await fs.rmdir(link);
    }
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  }
  const instructions = path.join(slot.dir, "CLAUDE.md");
  try { await fs.writeFile(instructions, `@${path.join(defaults, "CLAUDE.md")}\n`, { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const shared = stripSettings(await readJson(path.join(defaults, "settings.json"), {}));
  const file = path.join(slot.dir, "settings.json");
  await withNativeLock(file + ".lock", 10000, async () => {
    const before = await readJson(file, {}), after = mergeSettings(shared, before, state.settings);
    if (!equal(before, after)) { await assertLocks(); if (!equal(await readJson(file, {}), before)) throw new Error("Claude settings changed while sharing; they were kept"); await writeFileAtomic(file, JSON.stringify(after, null, 2) + "\n", { mode: 0o600 }); }
  });
  state.settings = shared;
  const profileFile = await runtime.profilePath(slot);
  if (await fs.stat(profileFile).catch(error => { if (error.code === "ENOENT") return null; throw error; })) {
    await withNativeLock(profileFile + ".lock", 10000, async () => {
      const profile = await runtime.readProfile(slot), before = structuredClone(profile);
      const defaultProfile = await runtime.readProfile(runtime.defaultSlot);
      const servers = defaultProfile.mcpServers || {};
      profile.mcpServers ||= {};
      for (const map of [servers, profile.mcpServers, state.mcp || {}]) if (typeof map !== "object" || Array.isArray(map)) throw new Error("Claude MCP settings must be an object");
      for (const [name, fingerprint] of Object.entries(state.mcp || {})) if (!Object.hasOwn(servers, name) && hash(profile.mcpServers[name]) === fingerprint) delete profile.mcpServers[name];
      for (const [name, spec] of Object.entries(servers)) if (!Object.hasOwn(profile.mcpServers, name) || hash(profile.mcpServers[name]) === state.mcp?.[name]) profile.mcpServers[name] = spec;
      for (const key of ["hasCompletedOnboarding", "theme"]) if (profile[key] == null && defaultProfile[key] != null) profile[key] = defaultProfile[key];
      if (!equal(before, profile)) { if (!equal(await runtime.readProfile(slot), before)) throw new Error("Claude profile changed while sharing; it was kept"); await runtime.writeProfile(slot, profile); }
      state.mcp = Object.fromEntries(Object.entries(servers).map(([name, spec]) => [name, hash(spec)]));
    });
  }
  await writeFileAtomic(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  });
}
module.exports = { sync, stripSettings, mergeSettings };
