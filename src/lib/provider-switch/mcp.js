const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const YAML = require("yaml");
const { parse: tomlParse } = require("smol-toml");
const { readJson, updateJsonLocked, ensureDir, writeFileAtomic, chmod600IfPossible } = require("../fs");
const paths = require("./paths");
const toml = require("./toml");
const backup = require("./backup");

// MCP server management, ported from cc-switch's mcp module (services/mcp.rs
// + mcp/*.rs). One SSOT list of server specs (mcp-servers.json) is projected
// into each tool's native MCP config:
//
//   claude     ~/.claude.json                 top-level `mcpServers` map
//   codex      ~/.codex/config.toml           [mcp_servers.<id>] tables
//   gemini     ~/.gemini/settings.json        `mcpServers` map
//   grokbuild  ~/.grok/config.toml            [mcp_servers.<id>] tables
//   opencode   ~/.config/opencode/opencode.json  `mcp` map (local/remote shape)
//   hermes     ~/.hermes/config.yaml          `mcp_servers` map
//   mcode      ~/.minimax/mcp.json            `mcpServers` map with per-entry
//                                             `enabled` flags (MiniMax's own
//                                             format — pre-existing unmanaged
//                                             entries are never removed by
//                                             projections, only by explicit
//                                             disable/delete)
//
// openclaw and pi have no MCP registry (cc-switch: OpenClaw support is WIP,
// pi core has none) and are excluded, matching their additive specs.
//
// Codex's `[mcp_servers.*]` entries deliberately never get a `type` key —
// Codex infers the transport from `command` (stdio) vs `url` (streamable
// HTTP) and warns on unknown fields since 0.158 (cc-switch #7735). The SSOT
// spec keeps `type` so one spec serves every app. Transport-only fields of
// the other transport (url/headers vs command/args/env) are dropped on the
// TOML projection so a spec that carries both never writes a mixed entry
// (cc-switch 27e5282). Projection failures are collected per server, never
// abort the batch — live files are independent, and the caller sees every
// failure aggregated (cc-switch 81c0ff2).

const MCP_APPS = ["claude", "codex", "gemini", "grokbuild", "opencode", "hermes", "mcode"];

// The unified spec allows stdio/http/sse. Transport resolution follows
// cc-switch's spec_transport_type: an explicit type wins, and a spec with a
// url but no command is http (url-only entries are a real-world shape).
function validateServerSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("MCP server spec must be an object");
  }
  const type = specTransportType(spec);
  if (type !== "stdio" && type !== "http" && type !== "sse") {
    throw new Error("MCP server type must be 'stdio', 'http' or 'sse' (or omit it for stdio)");
  }
  if (type === "stdio" && !String(spec.command || "").trim()) {
    throw new Error("stdio MCP server requires a command");
  }
  if ((type === "http" || type === "sse") && !String(spec.url || "").trim()) {
    throw new Error(`${type} MCP server requires a url`);
  }
  return spec;
}

// cc-switch spec_transport_type: an explicit type wins; a spec that carries a
// url but no command is HTTP even when type is absent or "stdio".
function specTransportType(spec) {
  const has = (key) => typeof spec?.[key] === "string" && spec[key].trim() !== "";
  const explicit = typeof spec?.type === "string" ? spec.type : null;
  if ((explicit === null || explicit === "stdio") && !has("command") && has("url")) return "http";
  return explicit || "stdio";
}

// ---------------------------------------------------------------------------
// SSOT store (mcp-servers.json)
// ---------------------------------------------------------------------------

function emptyStore() {
  return { version: 1, servers: [] };
}

function normalizeStore(current) {
  const store = current && Array.isArray(current.servers) ? current : emptyStore();
  const servers = store.servers.filter((s) => s && typeof s === "object" && typeof s.id === "string");
  return { version: 1, servers };
}

function defaultApps() {
  const apps = {};
  for (const app of MCP_APPS) apps[app] = false;
  return apps;
}

function normalizeApps(value) {
  const apps = defaultApps();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const app of MCP_APPS) apps[app] = value[app] === true;
  }
  return apps;
}

function sanitizeServerId(id) {
  const trimmed = String(id || "").trim();
  if (!trimmed) throw new Error("MCP server id is required");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) {
    throw new Error("MCP server id may only contain letters, digits, '_' and '-' (max 64)");
  }
  return trimmed;
}

function sanitizeSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("MCP server spec must be an object");
  }
  if (JSON.stringify(spec).length > 16 * 1024) throw new Error("MCP server spec is too large");
  const clone = JSON.parse(JSON.stringify(spec));
  validateServerSpec(clone);
  return clone;
}

function sanitizeServerInput(input) {
  if (!input || typeof input !== "object") throw new Error("MCP server payload required");
  const id = sanitizeServerId(input.id);
  const name = String(input.name || id).trim().slice(0, 100) || id;
  return {
    id,
    name,
    server: sanitizeSpec(input.server),
    apps: normalizeApps(input.apps),
    description: String(input.description || "").slice(0, 500),
    homepage: String(input.homepage || "").slice(0, 300),
    docs: String(input.docs || "").slice(0, 300),
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim().slice(0, 32)).filter(Boolean).slice(0, 12) : [],
  };
}

async function readMcpStore() {
  const store = await readJson(paths.mcpStorePath());
  return normalizeStore(store);
}

async function mutateMcpStore(update) {
  await ensureDir(path.dirname(paths.mcpStorePath()));
  return updateJsonLocked(paths.mcpStorePath(), (current) => {
    const store = normalizeStore(current);
    const next = update(store);
    return next === undefined ? store : normalizeStore(next);
  });
}

async function listServers() {
  return (await readMcpStore()).servers;
}

// Insertion-ordered upsert (cc-switch keeps an IndexMap; the array order is
// this port's insertion order).
async function saveServer(clean, { createdAt }) {
  await mutateMcpStore((store) => {
    const index = store.servers.findIndex((s) => s.id === clean.id);
    const now = new Date().toISOString();
    if (index === -1) {
      store.servers.push({ ...clean, createdAt: createdAt || now, updatedAt: now });
    } else {
      const existing = store.servers[index];
      store.servers[index] = { ...existing, ...clean, createdAt: existing.createdAt, updatedAt: now };
    }
    return store;
  });
}

// ---------------------------------------------------------------------------
// Live-file helpers
// ---------------------------------------------------------------------------

async function readText(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

// Read a JSON document, returning {} when missing. Throws on corrupt JSON —
// projections must not blind-overwrite a file they cannot parse.
async function readJsonDoc(filePath) {
  const text = await readText(filePath);
  if (text === null || text.trim() === "") return {};
  return JSON.parse(text);
}

async function writeOwnedFile(app, filePath, content) {
  await backup.createBackup(app, filePath);
  await ensureDir(path.dirname(filePath));
  await writeFileAtomic(filePath, content);
  await chmod600IfPossible(filePath);
}

async function updateJsonFile(app, filePath, mutate) {
  const doc = await readJsonDoc(filePath);
  const result = mutate(doc);
  await writeOwnedFile(app, filePath, `${JSON.stringify(doc, null, 2)}\n`);
  return result;
}

async function updateYamlFile(app, filePath, mutate) {
  const text = await readText(filePath);
  const doc = (text === null || text.trim() === "") ? {} : YAML.parse(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`Unexpected YAML structure in ${filePath}`);
  }
  const result = mutate(doc);
  await writeOwnedFile(app, filePath, YAML.stringify(doc));
  return result;
}

function jsonMapGet(doc, key) {
  const map = doc[key];
  return map && typeof map === "object" && !Array.isArray(map) ? map : null;
}

async function upsertJsonMap(app, filePath, mapKey, id, value) {
  await updateJsonFile(app, filePath, (doc) => {
    const map = jsonMapGet(doc, mapKey);
    if (map) map[id] = value;
    else doc[mapKey] = { [id]: value };
  });
}

async function removeFromJsonMap(app, filePath, mapKey, id) {
  await updateJsonFile(app, filePath, (doc) => {
    const map = jsonMapGet(doc, mapKey);
    if (map && Object.prototype.hasOwnProperty.call(map, id)) delete map[id];
  });
}

// ---------------------------------------------------------------------------
// Per-app spec conversions
// ---------------------------------------------------------------------------

// OpenCode: stdio → {type:"local", command:[cmd, ...args], environment?},
// http/sse → {type:"remote", url, headers?}; always enabled:true.
function toOpencodeSpec(spec) {
  const type = typeof spec.type === "string" ? spec.type : "stdio";
  if (type === "stdio") {
    const out = { type: "local", command: [String(spec.command || "")] };
    for (const arg of Array.isArray(spec.args) ? spec.args : []) out.command.push(arg);
    if (spec.env && typeof spec.env === "object" && !Array.isArray(spec.env) && Object.keys(spec.env).length) {
      out.environment = spec.env;
    }
    out.enabled = true;
    return out;
  }
  if (type === "http" || type === "sse") {
    const out = { type: "remote", url: String(spec.url || "") };
    if (spec.headers && typeof spec.headers === "object" && !Array.isArray(spec.headers) && Object.keys(spec.headers).length) {
      out.headers = spec.headers;
    }
    out.enabled = true;
    return out;
  }
  throw new Error(`Unknown MCP type: ${type}`);
}

function fromOpencodeSpec(id, spec) {
  if (!spec || typeof spec !== "object") throw new Error("OpenCode MCP entry must be an object");
  const type = typeof spec.type === "string" ? spec.type : "local";
  if (type === "local") {
    const command = Array.isArray(spec.command) ? spec.command.map(String) : [];
    if (!command.length) throw new Error(`OpenCode MCP server '${id}' has no command`);
    const out = { type: "stdio", command: command[0] };
    if (command.length > 1) out.args = command.slice(1);
    if (spec.environment && typeof spec.environment === "object" && !Array.isArray(spec.environment) && Object.keys(spec.environment).length) {
      out.env = spec.environment;
    }
    return out;
  }
  if (type === "remote") {
    if (!String(spec.url || "").trim()) throw new Error(`OpenCode MCP server '${id}' has no url`);
    const out = { type: "sse", url: String(spec.url) };
    if (spec.headers && typeof spec.headers === "object" && !Array.isArray(spec.headers) && Object.keys(spec.headers).length) {
      out.headers = spec.headers;
    }
    return out;
  }
  throw new Error(`Unknown OpenCode MCP type: ${type}`);
}

// Hermes: plain {command, args?, env?, enabled:true} / {url, headers?,
// enabled:true}; extra Hermes-side fields (timeout, tools, auth, …) survive
// updates via mergeHermesSpec.
const HERMES_EXTRA_FIELDS = ["enabled", "timeout", "connect_timeout", "tools", "sampling", "roots", "auth"];

function toHermesSpec(spec) {
  const type = typeof spec.type === "string" ? spec.type : "stdio";
  const out = {};
  if (type === "stdio") {
    out.command = String(spec.command || "");
    if (Array.isArray(spec.args) && spec.args.length) out.args = spec.args;
    if (spec.env && typeof spec.env === "object" && !Array.isArray(spec.env) && Object.keys(spec.env).length) out.env = spec.env;
  } else if (type === "http" || type === "sse") {
    out.url = String(spec.url || "");
    if (spec.headers && typeof spec.headers === "object" && !Array.isArray(spec.headers) && Object.keys(spec.headers).length) out.headers = spec.headers;
  } else {
    throw new Error(`Unknown MCP type: ${type}`);
  }
  out.enabled = true;
  return out;
}

function mergeHermesSpec(existing, next) {
  const result = {};
  if (existing && typeof existing === "object") {
    for (const [key, value] of Object.entries(existing)) {
      if (HERMES_EXTRA_FIELDS.includes(key)) result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(next)) result[key] = value;
  return result;
}

function fromHermesSpec(id, spec) {
  if (!spec || typeof spec !== "object") throw new Error("Hermes MCP entry must be an object");
  if (typeof spec.command === "string" && spec.command.trim()) {
    const out = { type: "stdio", command: spec.command };
    if (Array.isArray(spec.args) && spec.args.length) out.args = spec.args;
    if (spec.env && typeof spec.env === "object" && !Array.isArray(spec.env) && Object.keys(spec.env).length) out.env = spec.env;
    return out;
  }
  if (typeof spec.url === "string" && spec.url.trim()) {
    const out = { type: "sse", url: spec.url };
    if (spec.headers && typeof spec.headers === "object" && !Array.isArray(spec.headers) && Object.keys(spec.headers).length) out.headers = spec.headers;
    return out;
  }
  throw new Error(`Hermes MCP server '${id}' has neither 'command' nor 'url' field`);
}

// MiniMax mcp.json entries: {type, command/args/env | url/headers, enabled,
// …unknown fields preserved}. streamable-http and url-only entries normalize
// to http; command-only entries to stdio (cc-switch unified_spec).
function mcodeUnifiedSpec(native) {
  const spec = JSON.parse(JSON.stringify(native));
  if (spec.type === "streamable-http" || (typeof spec.type !== "string" && spec.url != null)) spec.type = "http";
  else if (typeof spec.type !== "string" && spec.command != null) spec.type = "stdio";
  return spec;
}

const MCODE_TRANSPORT_FIELDS = ["command", "args", "env", "url", "headers", "type"];

// ---------------------------------------------------------------------------
// TOML projection (codex + grokbuild)
// ---------------------------------------------------------------------------

// Scalars, homogeneous scalar arrays and string-only objects become TOML
// values; anything richer (null, mixed/nested arrays) is dropped — same rule
// as cc-switch's json_value_to_toml_item.
function jsonValueToToml(value) {
  if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return value;
  }
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return value.every((item) => typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))
      ? value
      : null;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length || !entries.every(([, item]) => typeof item === "string")) return null;
    return Object.fromEntries(entries);
  }
  return null;
}

// Codex's known passthrough knobs (timeout, shell, proxy, …); they need no
// special handling — anything the transport match above didn't consume is
// written through as a custom field, exactly like cc-switch.

// Unified spec → flat entries for toml.setTable (the env/headers maps ride
// along as inline tables, which is valid TOML Codex accepts).
function specToTomlEntries(spec, { codexStyle }) {
  const type = specTransportType(spec);
  const skipped = new Set(type === "stdio"
    ? ["type", "command", "args", "env", "cwd", "url", "headers", "http_headers", "env_http_headers", "http_headers_helper", "bearer_token_env_var", "oauth_resource"]
    : ["type", "url", "headers", "http_headers", "command", "args", "env", "env_vars", "cwd"]);
  const entries = {};
  if (type === "stdio") {
    entries.command = String(spec.command || "");
    if (Array.isArray(spec.args) && spec.args.length) entries.args = spec.args.filter((arg) => typeof arg === "string");
    if (typeof spec.cwd === "string" && spec.cwd.trim()) entries.cwd = spec.cwd;
    if (spec.env && typeof spec.env === "object" && !Array.isArray(spec.env) && Object.keys(spec.env).length) {
      entries.env = spec.env;
    }
  } else if (type === "http" || type === "sse") {
    entries.url = String(spec.url || "");
    const headers = spec.headers && typeof spec.headers === "object" && !Array.isArray(spec.headers) ? spec.headers : null;
    if (headers && Object.keys(headers).length) {
      // Codex expects `http_headers`; Grok Build uses plain `headers`.
      if (codexStyle) entries.http_headers = headers;
      else entries.headers = headers;
    }
  }
  for (const [key, value] of Object.entries(spec)) {
    if (skipped.has(key)) continue;
    const tomlValue = jsonValueToToml(value);
    if (tomlValue !== null) entries[key] = tomlValue;
  }
  return entries;
}

// Live TOML entry → unified spec (imports). Explicit type wins; a url with no
// command is http; otherwise stdio. Core fields are read strictly, extra
// fields pass through as scalars/string-maps.
function tomlEntryToSpec(entry, { codexStyle }) {
  if (!entry || typeof entry !== "object") throw new Error("MCP entry must be a table");
  let type = typeof entry.type === "string" ? entry.type : null;
  if (type === null && entry.url != null) type = "http";
  if (type === null) type = "stdio";
  const spec = type === "stdio" ? { type: "stdio" } : { type };
  if (type === "stdio") {
    if (typeof entry.command === "string") spec.command = entry.command;
    if (Array.isArray(entry.args)) spec.args = entry.args.map(String);
    if (typeof entry.cwd === "string" && entry.cwd.trim()) spec.cwd = entry.cwd;
    if (entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)) {
      const env = Object.fromEntries(Object.entries(entry.env).filter(([, value]) => typeof value === "string"));
      if (Object.keys(env).length) spec.env = env;
    }
  } else if (type === "http" || type === "sse") {
    if (typeof entry.url === "string") spec.url = entry.url;
    const headers = entry.http_headers && typeof entry.http_headers === "object" && !Array.isArray(entry.http_headers)
      ? entry.http_headers
      : entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)
        ? entry.headers
        : null;
    if (headers) {
      const clean = Object.fromEntries(Object.entries(headers).filter(([, value]) => typeof value === "string"));
      if (Object.keys(clean).length) spec.headers = clean;
    }
  }
  const core = type === "stdio"
    ? ["type", "command", "args", "cwd", "env"]
    : ["type", "url", codexStyle ? "http_headers" : "headers", "headers"];
  for (const [key, value] of Object.entries(entry)) {
    if (core.includes(key)) continue;
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      spec[key] = value;
    } else if (Array.isArray(value)) {
      const filtered = value.filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
      if (filtered.length) spec[key] = filtered;
    } else if (value !== null && typeof value === "object") {
      const filtered = Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string"));
      if (Object.keys(filtered).length) spec[key] = filtered;
    }
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function shouldSyncDir(homeSubdir) {
  try {
    return fs.existsSync(path.join(require("node:os").homedir(), homeSubdir));
  } catch {
    return false;
  }
}

const HOME_SUBDIRS = {
  claude: ".claude",
  codex: ".codex",
  gemini: ".gemini",
  grokbuild: ".grok",
  opencode: ".config/opencode",
  hermes: ".hermes",
  mcode: ".minimax",
};

function mcpLiveFiles() {
  const os = require("node:os");
  const home = os.homedir();
  return {
    claude: { path: path.join(home, ".claude.json"), mapKey: "mcpServers" },
    codex: { path: path.join(home, ".codex", "config.toml"), mapKey: "mcp_servers" },
    gemini: { path: path.join(home, ".gemini", "settings.json"), mapKey: "mcpServers" },
    grokbuild: { path: path.join(home, ".grok", "config.toml"), mapKey: "mcp_servers" },
    opencode: { path: path.join(home, ".config", "opencode", "opencode.json"), mapKey: "mcp" },
    hermes: { path: path.join(home, ".hermes", "config.yaml"), mapKey: "mcp_servers" },
    mcode: { path: path.join(home, ".minimax", "mcp.json"), mapKey: "mcpServers" },
  };
}

async function upsertServerInApp(app, id, spec) {
  const file = mcpLiveFiles()[app];
  if (app !== "mcode" && !shouldSyncDir(HOME_SUBDIRS[app])) return;
  if (app === "claude" || app === "gemini") {
    await upsertJsonMap(app, file.path, file.mapKey, id, spec);
    return;
  }
  if (app === "opencode") {
    await upsertJsonMap(app, file.path, file.mapKey, id, toOpencodeSpec(spec));
    return;
  }
  if (app === "mcode") {
    // Merge the transport spec over the existing entry so MiniMax-owned
    // fields (and anything unknown) survive; entries carry `enabled` inline.
    await updateJsonFile(app, file.path, (doc) => {
      const map = jsonMapGet(doc, file.mapKey);
      if (!map) doc[file.mapKey] = { [id]: {} };
      const servers = jsonMapGet(doc, file.mapKey);
      const merged = servers[id] && typeof servers[id] === "object" && !Array.isArray(servers[id]) ? servers[id] : {};
      for (const field of MCODE_TRANSPORT_FIELDS) delete merged[field];
      Object.assign(merged, JSON.parse(JSON.stringify(spec)));
      merged.enabled = true;
      servers[id] = merged;
    });
    return;
  }
  if (app === "hermes") {
    await updateYamlFile(app, file.path, (doc) => {
      const servers = jsonMapGet(doc, "mcp_servers");
      if (!servers) doc.mcp_servers = { [id]: {} };
      const map = jsonMapGet(doc, "mcp_servers");
      const existing = map[id];
      map[id] = mergeHermesSpec(existing, toHermesSpec(spec));
    });
    return;
  }
  // codex + grokbuild: line-preserving [mcp_servers.<id>] tables.
  const text = (await readText(file.path)) ?? "";
  const entries = specToTomlEntries(spec, { codexStyle: app === "codex" });
  const next = toml.setTable(text, `mcp_servers.${id}`, entries);
  await writeOwnedFile(app, file.path, next);
}

async function removeServerFromApp(app, id) {
  const file = mcpLiveFiles()[app];
  if (app !== "mcode" && !shouldSyncDir(HOME_SUBDIRS[app])) return;
  if (app === "claude" || app === "gemini" || app === "opencode") {
    await removeFromJsonMap(app, file.path, file.mapKey, id);
    return;
  }
  if (app === "mcode") {
    const text = await readText(file.path);
    if (text === null) return;
    await removeFromJsonMap(app, file.path, file.mapKey, id);
    return;
  }
  if (app === "hermes") {
    await updateYamlFile(app, file.path, (doc) => {
      const map = jsonMapGet(doc, "mcp_servers");
      if (map) delete map[id];
    });
    return;
  }
  const text = await readText(file.path);
  if (text === null || !text.trim()) return;
  const next = toml.setTable(text, `mcp_servers.${id}`, null);
  await writeOwnedFile(app, file.path, next);
}

// Project every SSOT server into one app's live config (cc-switch's
// project_servers_to_app): enabled servers are upserted, disabled ones are
// removed — except mcode, whose pre-existing unmanaged entries may only be
// removed by an explicit disable/delete. Per-server failures are aggregated
// instead of aborting the batch.
async function projectServersToApp(app, servers) {
  const failures = [];
  for (const server of servers) {
    const enabled = server.apps?.[app] === true;
    if (!enabled && app === "mcode") continue;
    try {
      if (enabled) await upsertServerInApp(app, server.id, server.server);
      else await removeServerFromApp(app, server.id);
    } catch (error) {
      failures.push(`${app}/${server.id}: ${error?.message || String(error)}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Operations (used by the API layer)
// ---------------------------------------------------------------------------

async function upsertServer(input) {
  const clean = sanitizeServerInput(input);
  const existing = await readMcpStore();
  const prev = existing.servers.find((s) => s.id === clean.id);
  const prevApps = prev ? normalizeApps(prev.apps) : defaultApps();
  await saveServer(clean, {});
  const failures = [];
  for (const app of MCP_APPS) {
    const enabled = clean.apps[app];
    if (!enabled && !prevApps[app]) continue;
    try {
      if (enabled) await upsertServerInApp(app, clean.id, clean.server);
      else await removeServerFromApp(app, clean.id);
    } catch (error) {
      failures.push(`${app}/${clean.id}: ${error?.message || String(error)}`);
    }
  }
  return { servers: await listServers(), failures };
}

async function deleteServer(id) {
  const cleanId = sanitizeServerId(id);
  const store = await readMcpStore();
  const server = store.servers.find((s) => s.id === cleanId);
  await mutateMcpStore((current) => {
    current.servers = current.servers.filter((s) => s.id !== cleanId);
    return current;
  });
  const failures = [];
  if (server) {
    for (const app of MCP_APPS) {
      if (server.apps?.[app] !== true) continue;
      try {
        await removeServerFromApp(app, cleanId);
      } catch (error) {
        failures.push(`${app}/${cleanId}: ${error?.message || String(error)}`);
      }
    }
  }
  return { servers: await listServers(), failures };
}

async function toggleServerApp(id, app, enabled) {
  if (!MCP_APPS.includes(app)) throw new Error(`MCP is not supported for app: ${app}`);
  const cleanId = sanitizeServerId(id);
  const before = await readMcpStore();
  if (!before.servers.some((s) => s.id === cleanId)) throw new Error(`MCP server not found: ${cleanId}`);
  let server = null;
  await mutateMcpStore((store) => {
    const index = store.servers.findIndex((s) => s.id === cleanId);
    if (index !== -1) {
      store.servers[index].apps = { ...store.servers[index].apps, [app]: enabled === true };
      store.servers[index].updatedAt = new Date().toISOString();
      server = store.servers[index];
    }
    return store;
  });
  const failures = [];
  if (server) {
    try {
      if (enabled) await upsertServerInApp(app, cleanId, server.server);
      else await removeServerFromApp(app, cleanId);
    } catch (error) {
      failures.push(`${app}/${cleanId}: ${error?.message || String(error)}`);
    }
  }
  return { servers: await listServers(), failures };
}

// Import MCP entries from one app's live config (or all apps) into the SSOT.
// Existing servers only get the app flag flipped on; their spec stays
// user-owned. Returns the change count and the per-entry skip reasons.
async function importFromApps(apps) {
  const targets = Array.isArray(apps) && apps.length ? apps.filter((app) => MCP_APPS.includes(app)) : MCP_APPS.slice();
  let changed = 0;
  const skipped = [];
  for (const app of targets) {
    try {
      const result = await importFromApp(app);
      changed += result.changed;
      skipped.push(...result.skipped);
    } catch (error) {
      skipped.push(`${app}: ${error?.message || String(error)}`);
    }
  }
  return { changed, skipped, servers: await listServers() };
}

async function importFromApp(app) {
  const file = mcpLiveFiles()[app];
  let entries = null;
  if (app === "claude" || app === "gemini" || app === "opencode" || app === "mcode") {
    const doc = await readJsonDoc(file.path).catch(() => null);
    const map = doc ? jsonMapGet(doc, file.mapKey) : null;
    if (!map) return { changed: 0, skipped: [] };
    entries = Object.entries(map).map(([id, value]) => ({ id, value, enabled: app === "mcode" ? value?.enabled !== false : true }));
  } else if (app === "hermes") {
    const text = await readText(file.path);
    if (text === null || !text.trim()) return { changed: 0, skipped: [] };
    const doc = YAML.parse(text);
    const map = doc && typeof doc === "object" ? jsonMapGet(doc, "mcp_servers") : null;
    if (!map) return { changed: 0, skipped: [] };
    entries = Object.entries(map).map(([id, value]) => ({ id, value, enabled: value?.enabled !== false }));
  } else {
    const text = await readText(file.path);
    if (text === null || !text.trim()) return { changed: 0, skipped: [] };
    let doc;
    try {
      doc = tomlParse(text);
    } catch (error) {
      throw new Error(`Parsing ${file.path} failed: ${error?.message || String(error)}`);
    }
    const map = jsonMapGet(doc, "mcp_servers");
    if (!map) return { changed: 0, skipped: [] };
    entries = Object.entries(map).map(([id, value]) => ({ id, value, enabled: true }));
  }

  let changed = 0;
  const skipped = [];
  const store = await readMcpStore();
  for (const { id, value, enabled } of entries) {
    let spec = null;
    try {
      if (app === "claude" || app === "gemini") spec = value;
      else if (app === "opencode") spec = fromOpencodeSpec(id, value);
      else if (app === "hermes") spec = fromHermesSpec(id, value);
      else if (app === "mcode") spec = mcodeUnifiedSpec(value);
      else spec = tomlEntryToSpec(value, { codexStyle: app === "codex" });
      spec = JSON.parse(JSON.stringify(spec));
      if (app === "mcode") delete spec.enabled;
      validateServerSpec(spec);
    } catch (error) {
      skipped.push(`${app}/${id}: ${error?.message || String(error)}`);
      continue;
    }
    const existing = store.servers.find((s) => s.id === id);
    if (existing) {
      if (existing.apps?.[app] !== true) {
        await mutateMcpStore((current) => {
          const index = current.servers.findIndex((s) => s.id === id);
          if (index !== -1) {
            current.servers[index].apps = { ...normalizeApps(current.servers[index].apps), [app]: true };
            current.servers[index].updatedAt = new Date().toISOString();
          }
          return current;
        });
        changed += 1;
      }
    } else {
      const now = new Date().toISOString();
      await mutateMcpStore((current) => {
        current.servers.push({
          id,
          name: id,
          server: spec,
          apps: { ...defaultApps(), [app]: true },
          description: "",
          homepage: "",
          docs: "",
          tags: [],
          createdAt: now,
          updatedAt: now,
        });
        return current;
      });
      changed += 1;
    }
  }
  return { changed, skipped };
}

// Re-project every enabled server (one app or all). Used after external
// rewrites of a live config.
async function syncServers(apps) {
  const targets = Array.isArray(apps) && apps.length ? apps.filter((app) => MCP_APPS.includes(app)) : MCP_APPS.slice();
  const servers = await listServers();
  const failures = [];
  for (const app of targets) {
    failures.push(...await projectServersToApp(app, servers));
  }
  return { failures };
}

module.exports = {
  MCP_APPS,
  validateServerSpec,
  specTransportType,
  listServers,
  upsertServer,
  deleteServer,
  toggleServerApp,
  importFromApps,
  syncServers,
  // exported for tests
  toOpencodeSpec,
  fromOpencodeSpec,
  toHermesSpec,
  fromHermesSpec,
  mcodeUnifiedSpec,
  specToTomlEntries,
  tomlEntryToSpec,
  mcpLiveFiles,
};
