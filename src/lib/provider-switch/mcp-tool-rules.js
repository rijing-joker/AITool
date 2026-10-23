"use strict";

const path = require("node:path");
const { readJson, updateJsonLocked, ensureDir, writeFileAtomic, chmod600IfPossible, withFileLock } = require("../fs");
const paths = require("./paths");
const backup = require("./backup");
const APPS = ["claude", "codex", "gemini", "opencode", "hermes"];
const receiptPath = () => path.join(paths.providerSwitchRoot(), "mcp-tool-rules.json");

function mergeRuleList(current, owned, desired) {
  if (current !== undefined && current !== null && (!Array.isArray(current) || current.some(rule => typeof rule !== "string"))) {
    throw new Error("Native MCP tool rules must be a list of names; the existing value was kept");
  }
  const source = Array.isArray(current) ? current : [];
  const keep = source.filter(rule => !owned.includes(rule));
  const nextOwned = desired.filter(rule => !keep.includes(rule));
  return { value: [...new Set([...keep, ...desired])], owned: nextOwned };
}

function nativeRules(app, id, tools) {
  const normalized = name => name.replace(/[^A-Za-z0-9_-]/g, "_");
  if (app === "claude") return tools.map(tool => `mcp__${id}__${normalized(tool)}`);
  if (app === "opencode") return tools.map(tool => `${id}_${normalized(tool)}`);
  return tools;
}

async function receipt(app, id) {
  return (await readJson(receiptPath()))?.[app]?.[id] || [];
}

// Called inside the live-file lock. The receipt contains only exact rules
// added by AiTool; an existing user's deny is never claimed or removed.
async function commit(app, id, owned) {
  await ensureDir(paths.providerSwitchRoot());
  await updateJsonLocked(receiptPath(), current => ({ ...current, [app]: { ...current?.[app], [id]: owned } }));
}

async function projectInSpec(app, id, spec, live) {
  if (!["codex", "gemini", "hermes"].includes(app)) return { spec, owned: null };
  const server = (await require("./mcp").listServers()).find(row => row.id === id);
  const desired = server?.apps?.[app] ? server.disabledTools?.[app] || [] : [];
  const previous = await receipt(app, id);
  if (app === "hermes") {
    for (const tools of [live?.tools, spec.tools]) {
      if (tools != null && (typeof tools !== "object" || Array.isArray(tools))) throw new Error("Hermes tools is not an object; the existing value was kept");
    }
  }
  const current = app === "codex" ? live?.disabled_tools : app === "gemini" ? live?.excludeTools : live?.tools?.exclude;
  // Explicit native filters in the edited unified spec remain user-owned.
  const supplied = app === "codex" ? spec.disabled_tools : app === "gemini" ? spec.excludeTools : spec.tools?.exclude;
  for (const list of [current, supplied]) mergeRuleList(list, [], []);
  const merged = mergeRuleList([...new Set([...(Array.isArray(current) ? current : []), ...(Array.isArray(supplied) ? supplied : [])])], previous, desired);
  const out = { ...spec };
  if (app === "codex") { if (merged.value.length) out.disabled_tools = merged.value; else delete out.disabled_tools; }
  else if (app === "gemini") { if (merged.value.length) out.excludeTools = merged.value; else delete out.excludeTools; }
  else {
    out.tools = { ...live?.tools, ...spec.tools };
    if (merged.value.length) out.tools.exclude = merged.value; else delete out.tools.exclude;
    // Keep an empty object through the native merge to clear our last rule.
  }
  return { spec: out, owned: merged.owned };
}

async function projectExternal(app, id, enabled) {
  if (!["claude", "opencode"].includes(app)) return;
  const file = app === "claude" ? paths.targetFiles("claude")[0].path : require("./mcp").mcpLiveFiles().opencode.path;
  await withFileLock(file, async () => {
    const store = await require("./mcp").listServers();
    const server = store.find(row => row.id === id);
    const desired = nativeRules(app, id, enabled && server?.apps?.[app] ? server.disabledTools?.[app] || [] : []);
    const previous = await receipt(app, id);
    if (!desired.length && !previous.length) return;
    let doc = await readJson(file);
    if (!doc) {
      // readJson suppresses parse errors; refuse to overwrite unreadable files.
      const fs = require("node:fs/promises");
      const raw = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; });
      doc = JSON.parse(raw);
    }
    if (app === "claude") {
      if (doc.permissions != null && (typeof doc.permissions !== "object" || Array.isArray(doc.permissions))) throw new Error("Claude permissions is not an object; the existing value was kept");
      const merged = mergeRuleList(doc.permissions?.deny, previous, desired);
      doc.permissions = { ...doc.permissions, deny: merged.value };
      await write(doc); await commit(app, id, merged.owned);
    } else {
      if (doc.tools != null && (typeof doc.tools !== "object" || Array.isArray(doc.tools))) throw new Error("OpenCode tools is not an object; the existing value was kept");
      const tools = { ...doc.tools };
      for (const rule of previous) if (tools[rule] === false && !desired.includes(rule)) delete tools[rule];
      const owned = [];
      for (const rule of desired) {
        if (tools[rule] === undefined) { tools[rule] = false; owned.push(rule); }
        else if (tools[rule] === false && previous.includes(rule)) owned.push(rule);
        // A user-owned explicit true is a conflict, never overwritten.
        else if (tools[rule] === true) throw new Error(`OpenCode tool rule changed outside AiTool: ${rule}`);
      }
      doc.tools = tools; await write(doc); await commit(app, id, owned);
    }
    async function write(value) {
      await backup.createBackup(app, file); await ensureDir(path.dirname(file));
      await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`); await chmod600IfPossible(file);
    }
  });
}

module.exports = { APPS, projectInSpec, projectExternal, commit, mergeRuleList, nativeRules };
