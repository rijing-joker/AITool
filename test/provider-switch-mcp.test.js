"use strict";

// Tests for the MCP management layer (cc-switch mcp module port): the SSOT
// store, per-app projections (codex/grokbuild TOML, claude/gemini/opencode/
// mcode JSON, hermes YAML), imports from live configs, and the
// /api/provider-switch/mcp/* HTTP surface.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");
const { parse: tomlParse } = require("smol-toml");
const YAML = require("yaml");

let tmpHome;
let prevHome;
let prevUserProfile;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-mcp-home-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// HTTP harness (same shape as provider-switch.test.js)
// ---------------------------------------------------------------------------

function makeReq({ method = "GET", url, headers = {}, body } = {}) {
  const base = Readable.from(body != null ? [Buffer.from(body)] : []);
  base.method = method;
  base.url = url;
  base.headers = { host: "localhost", ...headers };
  return base;
}

function makeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload ? String(payload) : "";
    },
  };
  return res;
}

async function call(handler, options) {
  const req = makeReq(options);
  const res = makeRes();
  await handler(req, res, new URL(`http://localhost${options.url}`), {
    isAuthorizedLocalMutation: () => true,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

function handler() {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  return handleProviderSwitchApiRequest;
}

function post(url, body) {
  return call(handler(), { method: "POST", url, body: JSON.stringify(body) });
}

function homePath(...parts) {
  return path.join(tmpHome, ...parts);
}

const stdioSpec = { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"] };
const httpSpec = { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t0k3n" } };

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

test("mcp: codex projection writes [mcp_servers.<id>] without type, preserving unrelated TOML", async () => {
  fs.mkdirSync(homePath(".codex"), { recursive: true });
  const configPath = homePath(".codex", "config.toml");
  fs.writeFileSync(configPath, [
    "# user comment",
    "model = \"gpt-5\"",
    "",
    "[model_providers.custom]",
    "name = \"relay\"",
    "base_url = \"https://relay.example.com\"",
    "",
  ].join("\n"));

  const res = await post("/api/provider-switch/mcp", {
    server: { id: "fetch", name: "Fetch", server: stdioSpec, apps: { codex: true } },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.failures, []);

  const text = fs.readFileSync(configPath, "utf8");
  assert.match(text, /# user comment/);
  assert.match(text, /\[model_providers\.custom\]/);
  assert.match(text, /\[mcp_servers\.fetch\]/);
  const doc = tomlParse(text);
  assert.equal(doc.mcp_servers.fetch.command, "npx");
  assert.deepEqual(doc.mcp_servers.fetch.args, ["-y", "@modelcontextprotocol/server-fetch"]);
  assert.equal(doc.mcp_servers.fetch.type, undefined);
  assert.equal(doc.model, "gpt-5");

  // SSOT row exists with the codex flag on.
  const store = JSON.parse(fs.readFileSync(homePath(".aitool", "provider-switch", "mcp-servers.json"), "utf8"));
  assert.equal(store.servers.length, 1);
  assert.equal(store.servers[0].apps.codex, true);
});

test("mcp: http server projects url + headers (codex http_headers) and infers transport from url-only specs", async () => {
  fs.mkdirSync(homePath(".codex"), { recursive: true });
  const configPath = homePath(".codex", "config.toml");
  fs.writeFileSync(configPath, "model = \"gpt-5\"\n");

  const res = await post("/api/provider-switch/mcp", {
    server: { id: "remote", server: httpSpec, apps: { codex: true, grokbuild: true } },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.failures, []);

  const codex = tomlParse(fs.readFileSync(configPath, "utf8"));
  assert.equal(codex.mcp_servers.remote.url, "https://mcp.example.com/mcp");
  assert.equal(codex.mcp_servers.remote.type, undefined);
  assert.equal(codex.mcp_servers.remote.http_headers.Authorization, "Bearer t0k3n");
  assert.equal(codex.mcp_servers.remote.headers, undefined);

  // grokbuild uses plain `headers`; the dir does not exist so the write is
  // skipped silently (guard).
  assert.equal(fs.existsSync(homePath(".grok", "config.toml")), false);

  // A url-only spec (no explicit type) is treated as http.
  fs.mkdirSync(homePath(".grok"), { recursive: true });
  fs.writeFileSync(homePath(".grok", "config.toml"), "");
  const res2 = await post("/api/provider-switch/mcp", {
    server: { id: "url-only", server: { url: "https://x.example.com/sse" }, apps: { grokbuild: true } },
  });
  assert.equal(res2.status, 200);
  const grok = tomlParse(fs.readFileSync(homePath(".grok", "config.toml"), "utf8"));
  assert.equal(grok.mcp_servers["url-only"].url, "https://x.example.com/sse");
  assert.equal(grok.mcp_servers["url-only"].type, undefined);
});

test("mcp: toggle off removes the projection but keeps unrelated content", async () => {
  fs.mkdirSync(homePath(".codex"), { recursive: true });
  const configPath = homePath(".codex", "config.toml");
  fs.writeFileSync(configPath, "model = \"gpt-5\"\n");
  await post("/api/provider-switch/mcp", {
    server: { id: "fetch", server: stdioSpec, apps: { codex: true } },
  });

  const res = await post("/api/provider-switch/mcp/toggle", { id: "fetch", app: "codex", enabled: false });
  assert.equal(res.status, 200);
  const text = fs.readFileSync(configPath, "utf8");
  assert.ok(!text.includes("mcp_servers.fetch"));
  assert.match(text, /model = "gpt-5"/);
  const store = JSON.parse(fs.readFileSync(homePath(".aitool", "provider-switch", "mcp-servers.json"), "utf8"));
  assert.equal(store.servers[0].apps.codex, false);
});

test("mcp: claude and gemini JSON maps, guard skipped when dirs missing", async () => {
  fs.mkdirSync(homePath(".claude"), { recursive: true });
  fs.mkdirSync(homePath(".gemini"), { recursive: true });
  const claudeJson = homePath(".claude.json");
  fs.writeFileSync(claudeJson, JSON.stringify({ userID: "u1", mcpServers: { mine: { type: "stdio", command: "own" } } }));

  const res = await post("/api/provider-switch/mcp", {
    server: { id: "fetch", server: stdioSpec, apps: { claude: true, gemini: true } },
  });
  assert.equal(res.status, 200);

  const claude = JSON.parse(fs.readFileSync(claudeJson, "utf8"));
  assert.equal(claude.userID, "u1");
  assert.equal(claude.mcpServers.fetch.command, "npx");
  assert.equal(claude.mcpServers.mine.command, "own");
  const gemini = JSON.parse(fs.readFileSync(homePath(".gemini", "settings.json"), "utf8"));
  assert.equal(gemini.mcpServers.fetch.command, "npx");

  // Gemini dir removed → projection skipped silently, no file created.
  fs.rmSync(homePath(".gemini"), { recursive: true, force: true });
  await post("/api/provider-switch/mcp/toggle", { id: "fetch", app: "gemini", enabled: false });
  await post("/api/provider-switch/mcp/toggle", { id: "fetch", app: "gemini", enabled: true });
  assert.equal(fs.existsSync(homePath(".gemini", "settings.json")), false);
});

test("mcp: opencode converts to local/remote shape and preserves user entries", async () => {
  fs.mkdirSync(homePath(".config", "opencode"), { recursive: true });
  const configPath = homePath(".config", "opencode", "opencode.json");
  fs.writeFileSync(configPath, JSON.stringify({
    theme: "dark",
    mcp: { userown: { type: "remote", url: "https://own.example.com", enabled: true } },
  }));

  const res = await post("/api/provider-switch/mcp", {
    server: {
      id: "fetch",
      server: stdioSpec,
      apps: { opencode: true },
    },
  });
  assert.equal(res.status, 200);
  const doc = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(doc.theme, "dark");
  assert.deepEqual(doc.mcp.fetch.command, ["npx", "-y", "@modelcontextprotocol/server-fetch"]);
  assert.equal(doc.mcp.fetch.type, "local");
  assert.equal(doc.mcp.fetch.enabled, true);
  assert.equal(doc.mcp.userown.url, "https://own.example.com");
});

test("mcp: hermes YAML merges over existing entries keeping Hermes-owned fields", async () => {
  fs.mkdirSync(homePath(".hermes"), { recursive: true });
  const configPath = homePath(".hermes", "config.yaml");
  fs.writeFileSync(configPath, [
    "model:",
    "  default: kimi-k3",
    "mcp_servers:",
    "  existing:",
    "    command: own-cmd",
    "    timeout: 30",
  ].join("\n"));

  const res = await post("/api/provider-switch/mcp", {
    server: { id: "existing", server: { type: "stdio", command: "new-cmd", args: ["--x"] }, apps: { hermes: true } },
  });
  assert.equal(res.status, 200);
  const text = fs.readFileSync(configPath, "utf8");
  assert.match(text, /default: kimi-k3/);
  assert.match(text, /command: new-cmd/);
  assert.match(text, /timeout: 30/);
});

test("mcode: entries carry enabled inline, unknown fields survive, projection never removes unmanaged", async () => {
  fs.mkdirSync(homePath(".minimax"), { recursive: true });
  const mcpJson = homePath(".minimax", "mcp.json");
  fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: { unmanaged: { type: "stdio", command: "keep-me" } } }));

  const res = await post("/api/provider-switch/mcp", {
    server: { id: "fetch", server: stdioSpec, apps: { mcode: true } },
  });
  assert.equal(res.status, 200);
  let doc = JSON.parse(fs.readFileSync(mcpJson, "utf8"));
  assert.equal(doc.mcpServers.fetch.enabled, true);
  assert.equal(doc.mcpServers.fetch.command, "npx");
  assert.equal(doc.mcpServers.unmanaged.command, "keep-me");

  // Toggle off is an explicit operation: the mcode entry is removed, but
  // pre-existing unmanaged entries stay (batch syncs never touch them).
  await post("/api/provider-switch/mcp/toggle", { id: "fetch", app: "mcode", enabled: false });
  doc = JSON.parse(fs.readFileSync(mcpJson, "utf8"));
  assert.equal(doc.mcpServers.fetch, undefined);
  assert.equal(doc.mcpServers.unmanaged.command, "keep-me");
  const store = JSON.parse(fs.readFileSync(homePath(".aitool", "provider-switch", "mcp-servers.json"), "utf8"));
  assert.equal(store.servers[0].apps.mcode, false);

  // A batch sync must not re-add or remove mcode entries for disabled
  // servers (the false flag also covers unmanaged ones).
  await post("/api/provider-switch/mcp/sync", { apps: ["mcode"] });
  doc = JSON.parse(fs.readFileSync(mcpJson, "utf8"));
  assert.equal(doc.mcpServers.fetch, undefined);
  assert.equal(doc.mcpServers.unmanaged.command, "keep-me");

  // Re-enable rewrites the entry with enabled:true.
  await post("/api/provider-switch/mcp/toggle", { id: "fetch", app: "mcode", enabled: true });
  doc = JSON.parse(fs.readFileSync(mcpJson, "utf8"));
  assert.equal(doc.mcpServers.fetch.command, "npx");
  assert.equal(doc.mcpServers.fetch.enabled, true);

  // Delete removes it for real.
  await post("/api/provider-switch/mcp/delete", { id: "fetch" });
  doc = JSON.parse(fs.readFileSync(mcpJson, "utf8"));
  assert.equal(doc.mcpServers.fetch, undefined);
  assert.equal(doc.mcpServers.unmanaged.command, "keep-me");
});

test("mcp: an inline [mcp_servers] entry is migrated, never defined twice", async () => {
  // A hand-written config may keep entries inline under [mcp_servers]. Writing
  // a [mcp_servers.fetch] block next to `fetch = { … }` defines the same table
  // twice, which makes the whole config.toml unloadable for Codex.
  fs.mkdirSync(homePath(".codex"), { recursive: true });
  const configPath = homePath(".codex", "config.toml");
  fs.writeFileSync(configPath, [
    "model = \"gpt-5\"",
    "",
    "[mcp_servers]",
    "fetch = { command = \"uvx\", args = [\"mcp-server-fetch\"] }",
    "keep = { command = \"stay\" }",
    "",
    "[tui]",
    "theme = \"dark\"",
    "",
  ].join("\n"));

  const res = await post("/api/provider-switch/mcp", {
    server: { id: "fetch", server: stdioSpec, apps: { codex: true } },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.failures, []);

  const text = fs.readFileSync(configPath, "utf8");
  const doc = tomlParse(text); // throws on a redefined table
  assert.equal(doc.mcp_servers.fetch.command, "npx");
  assert.deepEqual(doc.mcp_servers.fetch.args, ["-y", "@modelcontextprotocol/server-fetch"]);
  assert.equal(doc.mcp_servers.keep.command, "stay", "sibling inline entries survive");
  assert.equal(doc.model, "gpt-5");
  assert.equal(doc.tui.theme, "dark");

  // Disabling must clear the inline form too, or the server stays live in
  // Codex while the dashboard shows it off.
  const off = await post("/api/provider-switch/mcp/toggle", { id: "fetch", app: "codex", enabled: false });
  assert.deepEqual(off.body.failures, []);
  const after = tomlParse(fs.readFileSync(configPath, "utf8"));
  assert.equal(after.mcp_servers.fetch, undefined);
  assert.equal(after.mcp_servers.keep.command, "stay");
});

test("mcp: a dotted top-level mcp_servers.<id> key is migrated to a block", async () => {
  fs.mkdirSync(homePath(".grok"), { recursive: true });
  const configPath = homePath(".grok", "config.toml");
  fs.writeFileSync(configPath, "mcp_servers.fetch = { command = \"old\" }\nmodel = \"grok\"\n");

  const res = await post("/api/provider-switch/mcp", {
    server: { id: "fetch", server: stdioSpec, apps: { grokbuild: true } },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.failures, []);
  const doc = tomlParse(fs.readFileSync(configPath, "utf8"));
  assert.equal(doc.mcp_servers.fetch.command, "npx");
  assert.equal(doc.model, "grok");
});

test("mcp: url-only specs project as remote, not a local entry with an empty command", async () => {
  fs.mkdirSync(homePath(".config", "opencode"), { recursive: true });
  fs.mkdirSync(homePath(".hermes"), { recursive: true });
  const opencodePath = homePath(".config", "opencode", "opencode.json");
  fs.writeFileSync(opencodePath, JSON.stringify({ mcp: {} }));

  // No `type`, url only — validateServerSpec accepts it as http, so every
  // projection has to infer the same transport.
  const res = await post("/api/provider-switch/mcp", {
    server: {
      id: "remote",
      server: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t" } },
      apps: { opencode: true, hermes: true },
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.failures, []);

  const doc = JSON.parse(fs.readFileSync(opencodePath, "utf8"));
  assert.equal(doc.mcp.remote.type, "remote");
  assert.equal(doc.mcp.remote.url, "https://mcp.example.com/mcp");
  assert.equal(doc.mcp.remote.command, undefined);
  assert.equal(doc.mcp.remote.headers.Authorization, "Bearer t");

  const hermes = YAML.parse(fs.readFileSync(homePath(".hermes", "config.yaml"), "utf8"));
  assert.equal(hermes.mcp_servers.remote.url, "https://mcp.example.com/mcp");
  assert.equal(hermes.mcp_servers.remote.command, undefined);
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

test("mcp: import from claude and codex live configs merges into the SSOT", async () => {
  fs.mkdirSync(homePath(".claude"), { recursive: true });
  fs.mkdirSync(homePath(".codex"), { recursive: true });
  fs.writeFileSync(homePath(".claude.json"), JSON.stringify({
    mcpServers: {
      good: { type: "stdio", command: "node", args: ["srv.js"] },
      broken: { type: "stdio", command: "  " },
    },
  }));
  fs.writeFileSync(homePath(".codex", "config.toml"), [
    "[mcp_servers.remote]",
    "url = \"https://m.example.com\"",
    "[mcp_servers.remote.http_headers]",
    "Authorization = \"Bearer z\"",
  ].join("\n"));

  const res = await post("/api/provider-switch/mcp/import", {});
  assert.equal(res.status, 200);
  assert.ok(res.body.changed >= 2);
  const servers = res.body.servers;
  const good = servers.find((s) => s.id === "good");
  assert.equal(good.apps.claude, true);
  assert.deepEqual(good.server.args, ["srv.js"]);
  const remote = servers.find((s) => s.id === "remote");
  assert.equal(remote.apps.codex, true);
  assert.equal(remote.server.type, "http");
  assert.equal(remote.server.headers.Authorization, "Bearer z");
  assert.ok(res.body.skipped.some((line) => line.includes("claude/broken")));
});

for (const [app, dir] of [["codex", ".codex"], ["grokbuild", ".grok"]]) {
  test(`mcp: imported disabled ${app} servers can be toggled on`, async () => {
    const configPath = homePath(dir, "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '[mcp_servers.fetch]\ncommand = "fetch"\nenabled = false\ntool_timeout_sec = 42\n');
    const mcp = require("../src/lib/provider-switch/mcp");
    const imported = await mcp.importFromApps([app]);
    assert.deepEqual(imported.skipped, []);
    assert.equal(imported.servers[0].apps[app], false);
    assert.equal(imported.servers[0].server.enabled, undefined);
    assert.equal(imported.servers[0].server.tool_timeout_sec, 42);

    await mcp.toggleServerApp("fetch", app, true);
    let live = tomlParse(fs.readFileSync(configPath, "utf8"));
    assert.equal(live.mcp_servers.fetch.command, "fetch");
    assert.notEqual(live.mcp_servers.fetch.enabled, false);
    await mcp.toggleServerApp("fetch", app, false);
    live = tomlParse(fs.readFileSync(configPath, "utf8"));
    assert.equal(live.mcp_servers?.fetch, undefined);

    // Old imports kept enabled:false in the shared spec; their toggles must
    // work too, without requiring users to delete and import the row again.
    const storePath = homePath(".aitool", "provider-switch", "mcp-servers.json");
    const saved = JSON.parse(fs.readFileSync(storePath, "utf8"));
    saved.servers[0].server.enabled = false;
    fs.writeFileSync(storePath, JSON.stringify(saved));
    await mcp.toggleServerApp("fetch", app, true);
    live = tomlParse(fs.readFileSync(configPath, "utf8"));
    assert.notEqual(live.mcp_servers.fetch.enabled, false);
    assert.equal(live.mcp_servers.fetch.tool_timeout_sec, 42);
  });
}

test("mcp: import from opencode converts local/remote back to stdio/sse", async () => {
  fs.mkdirSync(homePath(".config", "opencode"), { recursive: true });
  fs.writeFileSync(homePath(".config", "opencode", "opencode.json"), JSON.stringify({
    mcp: {
      local: { type: "local", command: ["deno", "run", "srv.ts"], enabled: true },
      far: { type: "remote", url: "https://far.example.com", enabled: true },
    },
  }));
  const res = await post("/api/provider-switch/mcp/import", { apps: ["opencode"] });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, 2);
  const local = res.body.servers.find((s) => s.id === "local");
  assert.equal(local.server.type, "stdio");
  assert.equal(local.server.command, "deno");
  assert.deepEqual(local.server.args, ["run", "srv.ts"]);
  const far = res.body.servers.find((s) => s.id === "far");
  assert.equal(far.server.type, "sse");
});

test("mcp: re-importing an existing server only flips the app flag", async () => {
  fs.mkdirSync(homePath(".config", "opencode"), { recursive: true });
  fs.writeFileSync(homePath(".config", "opencode", "opencode.json"), JSON.stringify({
    mcp: { fetch: { type: "local", command: ["npx", "thing"], enabled: true } },
  }));
  await post("/api/provider-switch/mcp", {
    server: { id: "fetch", server: { type: "stdio", command: "custom" }, apps: { codex: true } },
  });
  const res = await post("/api/provider-switch/mcp/import", { apps: ["opencode"] });
  assert.equal(res.body.changed, 1);
  const fetchServer = res.body.servers.find((s) => s.id === "fetch");
  assert.equal(fetchServer.server.command, "custom");
  assert.equal(fetchServer.server.codexStyle, undefined);
  assert.equal(fetchServer.apps.codex, true);
  assert.equal(fetchServer.apps.opencode, true);
});

test("mcp: import keeps a live entry's disabled state instead of enabling it", async () => {
  fs.mkdirSync(homePath(".minimax"), { recursive: true });
  fs.mkdirSync(homePath(".hermes"), { recursive: true });
  fs.mkdirSync(homePath(".config", "opencode"), { recursive: true });
  fs.writeFileSync(homePath(".minimax", "mcp.json"), JSON.stringify({
    mcpServers: {
      on: { type: "stdio", command: "a" },
      off: { type: "stdio", command: "b", enabled: false },
    },
  }));
  fs.writeFileSync(homePath(".config", "opencode", "opencode.json"), JSON.stringify({
    mcp: { ocoff: { type: "local", command: ["d"], enabled: false } },
  }));
  fs.writeFileSync(homePath(".hermes", "config.yaml"), [
    "mcp_servers:",
    "  hoff:",
    "    command: c",
    "    enabled: false",
  ].join("\n"));

  const res = await post("/api/provider-switch/mcp/import", { apps: ["mcode", "hermes", "opencode"] });
  assert.equal(res.status, 200);
  const byId = (id) => res.body.servers.find((s) => s.id === id);
  assert.equal(byId("on").apps.mcode, true);
  assert.equal(byId("off").apps.mcode, false, "a disabled entry must not import as enabled");
  assert.equal(byId("hoff").apps.hermes, false);
  assert.equal(byId("ocoff").apps.opencode, false);

  // A later batch sync must not flip the import back on. mcode keeps the
  // entry with its inline enabled:false; everywhere else "disabled" means
  // absent, exactly as the dashboard's own toggle-off projects it.
  await post("/api/provider-switch/mcp/sync", { apps: ["mcode", "hermes"] });
  const mcode = JSON.parse(fs.readFileSync(homePath(".minimax", "mcp.json"), "utf8"));
  assert.equal(mcode.mcpServers.off.enabled, false);
  assert.equal(mcode.mcpServers.on.enabled, true);
  const hermes = YAML.parse(fs.readFileSync(homePath(".hermes", "config.yaml"), "utf8"));
  assert.notEqual(hermes.mcp_servers.hoff?.enabled, true, "sync never re-enables an imported-off server");
});

test("mcp: a backup of an MCP-only live file can be restored", async () => {
  // claude's MCP registry is ~/.claude.json, which is not a provider-switch
  // target file — the restore route has to resolve it anyway.
  fs.mkdirSync(homePath(".claude"), { recursive: true });
  fs.writeFileSync(homePath(".claude.json"), JSON.stringify({ userID: "u1", mcpServers: {} }));
  await post("/api/provider-switch/mcp", {
    server: { id: "fetch", server: stdioSpec, apps: { claude: true } },
  });

  const listed = await call(handler(), { url: "/api/provider-switch/backups?app=claude" });
  assert.equal(listed.status, 200);
  const entry = listed.body.backups.find((b) => b.name.startsWith(".claude.json."));
  assert.ok(entry, "the MCP projection's backup is listed");

  const restore = await post("/api/provider-switch/backups/restore", { app: "claude", backup: entry.name });
  assert.equal(restore.status, 200);
  const doc = JSON.parse(fs.readFileSync(homePath(".claude.json"), "utf8"));
  assert.equal(doc.userID, "u1");
  assert.equal(doc.mcpServers.fetch, undefined, "restore brings back the pre-projection file");
});

// ---------------------------------------------------------------------------
// Validation + failure aggregation
// ---------------------------------------------------------------------------

test("mcp: invalid payloads are rejected with 400", async () => {
  const cases = [
    { server: { id: "bad type!", server: stdioSpec } },
    { server: { id: "x", server: { type: "websocket", url: "https://x" } } },
    { server: { id: "x", server: { type: "stdio" } } },
    { server: { id: "x", server: { type: "http" } } },
    { server: { id: "x", server: "nope" } },
  ];
  for (const body of cases) {
    const res = await post("/api/provider-switch/mcp", body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test("mcp: one app's broken live file fails soft while the others project", async () => {
  fs.mkdirSync(homePath(".codex"), { recursive: true });
  fs.writeFileSync(homePath(".codex", "config.toml"), "model = \"gpt-5\"\n");
  fs.mkdirSync(homePath(".claude"), { recursive: true });
  fs.writeFileSync(homePath(".claude.json"), "{not json");

  const res = await post("/api/provider-switch/mcp", {
    server: { id: "fetch", server: stdioSpec, apps: { codex: true, claude: true } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.failures.length, 1);
  assert.match(res.body.failures[0], /^claude\/fetch:/);
  const codex = tomlParse(fs.readFileSync(homePath(".codex", "config.toml"), "utf8"));
  assert.equal(codex.mcp_servers.fetch.command, "npx");
});

test("mcp: sync re-projects enabled servers (used after external rewrites)", async () => {
  fs.mkdirSync(homePath(".claude"), { recursive: true });
  await post("/api/provider-switch/mcp", {
    server: { id: "fetch", server: stdioSpec, apps: { claude: true } },
  });
  fs.rmSync(homePath(".claude.json"), { force: true });
  const res = await post("/api/provider-switch/mcp/sync", { apps: ["claude"] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.failures, []);
  const claude = JSON.parse(fs.readFileSync(homePath(".claude.json"), "utf8"));
  assert.equal(claude.mcpServers.fetch.command, "npx");
});

test("mcp: delete removes the SSOT row and all projections", async () => {
  fs.mkdirSync(homePath(".claude"), { recursive: true });
  fs.mkdirSync(homePath(".codex"), { recursive: true });
  fs.writeFileSync(homePath(".codex", "config.toml"), "model = \"gpt-5\"\n");
  await post("/api/provider-switch/mcp", {
    server: { id: "fetch", server: stdioSpec, apps: { claude: true, codex: true } },
  });
  const res = await post("/api/provider-switch/mcp/delete", { id: "fetch" });
  assert.equal(res.status, 200);
  assert.equal(res.body.servers.length, 0);
  assert.ok(!fs.readFileSync(homePath(".codex", "config.toml"), "utf8").includes("mcp_servers.fetch"));
  assert.equal(JSON.parse(fs.readFileSync(homePath(".claude.json"), "utf8")).mcpServers.fetch, undefined);
});

test("mcp: mutations require local auth", async () => {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  const req = makeReq({ method: "POST", url: "/api/provider-switch/mcp", body: "{}" });
  const res = makeRes();
  await handleProviderSwitchApiRequest(req, res, new URL("http://localhost/api/provider-switch/mcp"), {
    isAuthorizedLocalMutation: () => false,
  });
  assert.equal(res.statusCode, 401);
});
