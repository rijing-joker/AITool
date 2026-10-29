"use strict";
// DeepSeek Harness web profile, cc-switch 9403960f (MIT). Other plugin
// overrides remain native-owned. API keys can be inline or native env refs.
const YAML = require("yaml");
function entries(text) {
  const value = YAML.parse(text || "[]", { logLevel: "silent" }) || [];
  if (!Array.isArray(value)) throw new Error("DSH profile must be a YAML sequence");
  if (value.filter(row => row?.id === "llm-pi-ai").length > 1) throw new Error("Duplicate DSH llm-pi-ai overrides");
  return value;
}
function parse(text) {
  const rows = entries(text);
  const config = rows.find(row => row?.id === "llm-pi-ai")?.config || { providers: {} };
  if (!config || typeof config !== "object" || Array.isArray(config) || (config.providers && (typeof config.providers !== "object" || Array.isArray(config.providers)))) throw new Error("DSH providers must be an object");
  return config;
}
function serialize(text, config) {
  const before = entries(text), next = structuredClone(before), index = next.findIndex(row => row?.id === "llm-pi-ai");
  if (index >= 0) { next[index].config = config; return require("./yaml-text").patch(text || "[]", next); }
  if (!Array.isArray(config.providers) && !Object.keys(config.providers || {}).length) return text || "[]\n";
  const row = { id: "llm-pi-ai", config };
  if (!before.length) return (text.match(/^\s*(?:#[^\n]*\n)*/)?.[0] || "") + YAML.stringify([row]);
  const result = text.trimEnd() + "\n" + YAML.stringify([row]);
  if (!require("node:util").isDeepStrictEqual(YAML.parse(result, { logLevel: "silent" }), [...before, row])) throw new Error("Use block-style YAML for this DSH profile");
  return result;
}
function stage(profileText, credentialsText, config, previous) {
  const next = structuredClone(config);
  const credentials = credentialDocument(credentialsText);
  const native = parse(profileText);
  if (typeof credentials !== "object" || Array.isArray(credentials)) throw new Error("Invalid DSH credentials YAML");
  credentials.refs ||= {};
  if (typeof credentials.refs !== "object" || Array.isArray(credentials.refs)) throw new Error("Invalid DSH credential refs");
  for (const [slot, provider] of Object.entries(next.providers || {})) {
    if (typeof provider.apiKey !== "string" || !provider.apiKey.trim()) { delete provider.apiKey; continue; }
    const key = provider.apiKey.trim(); delete provider.apiKey;
    const existingRef = provider.apiKeyEnv || native.providers?.[slot]?.apiKeyEnv;
    if (existingRef && (credentials.refs[existingRef] === key || process.env[existingRef] === key)) { provider.apiKeyEnv = existingRef; continue; }
    const ref = `AITOOL_DSH_${slot.replaceAll("-", "_").toUpperCase()}`;
    const previousKey = previous?.settingsConfig?.slotKey === slot ? previous.settingsConfig.provider?.apiKey : null;
    if (credentials.refs[ref] && credentials.refs[ref] !== key && credentials.refs[ref] !== previousKey) throw new Error("DSH credential reference changed outside AiTool; it was kept");
    credentials.refs[ref] = key; provider.apiKeyEnv = ref;
  }
  const slot = previous?.settingsConfig?.slotKey;
  const ref = slot && `AITOOL_DSH_${slot.replaceAll("-", "_").toUpperCase()}`;
  const oldKey = previous?.settingsConfig?.provider?.apiKey;
  if (ref && oldKey && credentials.refs[ref] === oldKey && !Object.values(next.providers || {}).some(provider => provider.apiKeyEnv === ref)) delete credentials.refs[ref];
  return { profileText: serialize(profileText, next), credentialsText: require("./yaml-text").patch(credentialsText || "", credentials) };
}
function credentialDocument(text) {
  if (!text.trim()) return { version: 1, refs: {}, records: {} };
  const doc = YAML.parse(text, { logLevel: "silent" });
  if (!doc || doc.version !== 1 || (doc.refs != null && (typeof doc.refs !== "object" || Array.isArray(doc.refs)))) throw new Error("Unsupported DSH credential document; migrate it in DSH first");
  return doc;
}
function hydrate(config, credentialsText, env = process.env) {
  const result = structuredClone(config), credentials = credentialDocument(credentialsText);
  for (const provider of Object.values(result.providers || {})) {
    const key = credentials.refs?.[provider.apiKeyEnv] ?? env[provider.apiKeyEnv];
    if (typeof key === "string" && key) provider.apiKey = key;
  }
  return result;
}
function sameProvider(a, b) {
  const normalize = value => { const next = structuredClone(value); if (next?.apiKey) delete next.apiKeyEnv; return next; };
  return require("node:util").isDeepStrictEqual(normalize(a), normalize(b));
}
function mcpEntries(text) {
  return entries(text).flatMap(row => row?.insert ? row.insert : [row]).filter(row => row?.name === "@deepseek-ai/dsh-mcp-client");
}
function projectMcp(text, id, spec) {
  if (spec && require("./mcp").specTransportType(spec) === "sse") throw new Error("DSH supports stdio and Streamable HTTP; use HTTP instead of SSE");
  if (spec && id.length > 32) throw new Error("DSH MCP names must have at most 32 characters");
  const before = entries(text), next = structuredClone(before), locations = [];
  next.forEach((patch, index) => {
    (patch?.insert || [patch]).forEach((row, inner) => {
      if (row?.name === "@deepseek-ai/dsh-mcp-client" && row?.config?.serverName === id) locations.push({ index, inner: patch.insert ? inner : null, row });
    });
  });
  if (locations.length > 1) throw new Error("Duplicate DSH MCP overrides");
  const found = locations[0];
  if (!spec && !found) return text;
  const pluginId = `aitool-mcp-${id}`;
  if (!found && next.flatMap(row => row.insert || [row]).some(row => row.id === pluginId)) throw new Error("DSH plugin id conflicts with a native entry");
  if (spec) {
    const config = { ...(found?.row.config || {}) };
    for (const field of ["command", "args", "env", "cwd", "url", "headers", "type", "transport"]) delete config[field];
    Object.assign(config, spec, { serverName: id, transport: require("./mcp").specTransportType(spec) === "stdio" ? "stdio" : "streamable-http" });
    delete config.type;
    const row = { ...(found?.row || { id: pluginId, name: "@deepseek-ai/dsh-mcp-client" }), config };
    delete row.disabled;
    if (!found) next.push({ insert: [row] });
    else if (found.inner == null) next[found.index] = row;
    else next[found.index].insert[found.inner] = row;
  } else if (found.inner == null) next.splice(found.index, 1);
  else {
    next[found.index].insert.splice(found.inner, 1);
    if (!next[found.index].insert.length) next.splice(found.index, 1);
  }
  if (!before.length) return (text.match(/^\s*(?:#[^\n]*\n)*/)?.[0] || "") + YAML.stringify(next);
  return require("./yaml-text").patch(text, next);
}
async function mcp(id, spec) {
  const file = require("./paths").targetFiles("dsh")[0].path;
  return require("../fs").withFileLock(file, async () => {
    const fs = require("node:fs/promises");
    const text = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return "[]\n"; throw error; });
    const result = projectMcp(text, id, spec);
    if (result === text) return;
    await require("./backup").createBackup("dsh", file);
    await require("../fs").ensureDir(require("node:path").dirname(file));
    await require("../fs").writeFileAtomic(file, result, { mode: 0o600 });
  });
}
module.exports = { parse, serialize, stage, hydrate, sameProvider, credentialDocument, mcp, entries, mcpEntries, projectMcp };
