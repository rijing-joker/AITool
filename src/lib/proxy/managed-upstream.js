"use strict";
// Narrow, revision-aware transactions for optional AiTool upstream groups.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeFileAtomic, withFileLock } = require("../fs");
const ROUTE = "/v8/management/config/api-keys/openai-compatibility";
function canonical(value, inKey = false) {
  if (Array.isArray(value)) return value.map(row => canonical(row, inKey));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !(inKey && key === "auth_index")).map(key => [key, canonical(value[key], key === "keys")]));
}
// The core adds runtime credential indices and reorders JSON fields. Those
// fields do not confer ownership; every user-controlled value still matches.
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const root = options => options.root || path.join(require("./paths").proxyRoot, "extensions");
async function read(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw new Error("Optional upstream state is unreadable"); }
}
async function write(file, value) { return writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); }
async function configure(name, group, options = {}) {
  if (!/^aitool-[a-z0-9-]+$/.test(name)) throw new Error("Invalid managed upstream name");
  const file = path.join(root(options), `${name}.json`);
  return withFileLock(file, async () => {
    const request = options.request || require("./management").request;
    const saved = await read(file);
    const result = await request("GET", ROUTE);
    if (!result.ok || typeof result.etag !== "string" || !/^"[^"\r\n]+"$/.test(result.etag)) throw new Error("PROXY_CONFIG_REVISION_REQUIRED");
    const groups = Array.isArray(result.data) ? result.data : result.data?.data;
    if (!Array.isArray(groups)) throw new Error("Invalid native upstream group list");
    const existing = groups.filter(row => row.name === name);
    if (existing.length > 1 || (existing.length && (!saved || ![saved.applied, saved.pending].some(row => equal(row, existing[0]))))) throw new Error("Managed upstream was changed outside AiTool; review the group first");
    const next = group ? { ...group, name } : null;
    const updated = existing.length ? groups.flatMap(row => row.name === name ? next ? [next] : [] : [row]) : next ? [...groups, next] : groups;
    if (equal(groups, updated)) return { changed: false };
    await write(file, { applied: saved?.applied, pending: next });
    const response = await request("PUT", ROUTE, { body: updated, ifMatch: result.etag });
    if (!response.ok) {
      // A network error may follow a successful core commit. Keep the
      // write-ahead record unless a definite HTTP rejection was received.
      if (response.status >= 400) { if (saved) await write(file, saved); else await fs.rm(file, { force: true }); }
      const error = new Error([409, 412].includes(response.status) ? "PROXY_CONFIG_CONFLICT" : "Could not save optional upstream group");
      error.status = response.status || 400; throw error;
    }
    await write(file, { applied: next });
    return { changed: true };
  });
}
async function settings(options = {}) { return read(path.join(root(options), "settings.json"), { enabled: {}, port: 0 }); }
async function saveSettings(update, options = {}) {
  const file = path.join(root(options), "settings.json");
  return withFileLock(file, async () => {
    const previous = await settings(options);
    const next = await update(previous);
    next.token ||= crypto.randomBytes(32).toString("hex");
    await write(file, next); return next;
  });
}
module.exports = { configure, root, read, write, settings, saveSettings };
