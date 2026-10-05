"use strict";

// Tests for the prompt management layer (cc-switch prompt module port): the
// per-app SSOT lists, the enable/import/backup semantics around the live
// instruction files (CLAUDE.md / AGENTS.md / GEMINI.md / SOUL.md), and the
// /api/provider-switch/prompts/* HTTP surface.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");

let tmpHome;
let prevHome;
let prevUserProfile;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-prompts-home-"));
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
// HTTP harness (same shape as provider-switch-mcp.test.js)
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

function get(url) {
  return call(handler(), { method: "GET", url });
}

function post(url, body) {
  return call(handler(), { method: "POST", url, body: JSON.stringify(body) });
}

function homePath(...parts) {
  return path.join(tmpHome, ...parts);
}

function prompts() {
  return require("../src/lib/provider-switch/prompts");
}

// ---------------------------------------------------------------------------
// promptFilePath mapping (cc-switch prompt_files.rs)
// ---------------------------------------------------------------------------

test("prompts: per-app instruction file mapping", () => {
  const mapping = prompts().promptFilePath;
  assert.equal(mapping("claude"), homePath(".claude", "CLAUDE.md"));
  assert.equal(mapping("codex"), homePath(".codex", "AGENTS.md"));
  assert.equal(mapping("gemini"), homePath(".gemini", "GEMINI.md"));
  assert.equal(mapping("grokbuild"), homePath(".grok", "AGENTS.md"));
  assert.equal(mapping("opencode"), homePath(".config", "opencode", "AGENTS.md"));
  assert.equal(mapping("openclaw"), homePath(".openclaw", "AGENTS.md"));
  assert.equal(mapping("hermes"), homePath(".hermes", "SOUL.md"));
  assert.equal(mapping("pi"), homePath(".pi", "agent", "AGENTS.md"));
  assert.equal(mapping("mcode"), homePath(".minimax", "AGENTS.md"));
  assert.throws(() => mapping("openclaw-nope"), /not supported/i);
});

// ---------------------------------------------------------------------------
// Enable semantics: live backfill + projection
// ---------------------------------------------------------------------------

test("prompts: enabling the first prompt captures a hand-written file as a disabled backup", async () => {
  const claudeMd = homePath(".claude", "CLAUDE.md");
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  fs.writeFileSync(claudeMd, "# my rules\nalways answer in Chinese\n");

  const res = await post("/api/provider-switch/prompts", {
    app: "claude",
    prompt: { id: "terse", name: "Terse", content: "answer tersely", enabled: true },
  });
  assert.equal(res.status, 200);

  // The prompt content is live; the original file was captured, not lost.
  assert.equal(fs.readFileSync(claudeMd, "utf8"), "answer tersely");
  const store = JSON.parse(fs.readFileSync(homePath(".aitool", "provider-switch", "prompts.json"), "utf8"));
  const list = store.apps.claude;
  assert.equal(list.length, 2);
  const backup = list.find((entry) => entry.id.startsWith("backup-"));
  assert.ok(backup, "expected a backup entry");
  assert.equal(backup.enabled, false);
  assert.match(backup.content, /always answer in Chinese/);
  assert.equal(list.find((entry) => entry.id === "terse").enabled, true);
});

test("prompts: enabling refreshes the currently-enabled prompt with live content", async () => {
  const claudeMd = homePath(".claude", "CLAUDE.md");
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  await post("/api/provider-switch/prompts", {
    app: "claude",
    prompt: { id: "a", name: "A", content: "first", enabled: true },
  });
  await post("/api/provider-switch/prompts", {
    app: "claude",
    prompt: { id: "b", name: "B", content: "second", enabled: false },
  });
  // The user edited CLAUDE.md outside of the app.
  fs.writeFileSync(claudeMd, "first (hand edited)");

  const res = await post("/api/provider-switch/prompts/enable", { app: "claude", id: "b" });
  assert.equal(res.status, 200);
  assert.equal(fs.readFileSync(claudeMd, "utf8"), "second");
  const store = JSON.parse(fs.readFileSync(homePath(".aitool", "provider-switch", "prompts.json"), "utf8"));
  const a = store.apps.claude.find((entry) => entry.id === "a");
  const b = store.apps.claude.find((entry) => entry.id === "b");
  assert.equal(a.enabled, false);
  assert.equal(a.content, "first (hand edited)", "the live edit should have been backfilled into the previously-enabled prompt");
  assert.equal(b.enabled, true);
});

test("prompts: listing backfills external edits into the enabled prompt", async () => {
  const geminiMd = homePath(".gemini", "GEMINI.md");
  fs.mkdirSync(path.dirname(geminiMd), { recursive: true });
  await post("/api/provider-switch/prompts", {
    app: "gemini",
    prompt: { id: "g", name: "G", content: "original", enabled: true },
  });
  fs.writeFileSync(geminiMd, "edited on disk");

  const res = await get("/api/provider-switch/prompts?app=gemini");
  assert.equal(res.status, 200);
  assert.equal(res.body.prompts.find((entry) => entry.id === "g").content, "edited on disk");
  const store = JSON.parse(fs.readFileSync(homePath(".aitool", "provider-switch", "prompts.json"), "utf8"));
  assert.equal(store.apps.gemini.find((entry) => entry.id === "g").content, "edited on disk");
});

// ---------------------------------------------------------------------------
// Disable/delete semantics: the live file is only cleared when the store
// previously owned its content
// ---------------------------------------------------------------------------

test("prompts: disabling the last enabled prompt clears the live file; disabled upserts never touch it", async () => {
  const codexMd = homePath(".codex", "AGENTS.md");
  fs.mkdirSync(path.dirname(codexMd), { recursive: true });
  await post("/api/provider-switch/prompts", {
    app: "codex",
    prompt: { id: "p1", name: "P1", content: "v1", enabled: true },
  });
  assert.equal(fs.readFileSync(codexMd, "utf8"), "v1");

  // Re-save the enabled prompt as disabled → file cleared.
  await post("/api/provider-switch/prompts", {
    app: "codex",
    prompt: { id: "p1", name: "P1", content: "v1", enabled: false },
  });
  assert.equal(fs.readFileSync(codexMd, "utf8"), "");

  // A fresh disabled entry over a hand-written file must NOT clear it.
  fs.writeFileSync(codexMd, "# hand written");
  await post("/api/provider-switch/prompts", {
    app: "codex",
    prompt: { id: "imported-123", name: "Imported", content: "stuff", enabled: false },
  });
  assert.equal(fs.readFileSync(codexMd, "utf8"), "# hand written");
});

test("prompts: deleting an enabled prompt is refused; disabled ones delete fine", async () => {
  await post("/api/provider-switch/prompts", {
    app: "hermes",
    prompt: { id: "soul-a", name: "A", content: "a", enabled: true },
  });
  await post("/api/provider-switch/prompts", {
    app: "hermes",
    prompt: { id: "soul-b", name: "B", content: "b", enabled: false },
  });

  const refused = await post("/api/provider-switch/prompts/delete", { app: "hermes", id: "soul-a" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /已启用/);

  const ok = await post("/api/provider-switch/prompts/delete", { app: "hermes", id: "soul-b" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.prompts.length, 1);
});

// ---------------------------------------------------------------------------
// Import + sync projection
// ---------------------------------------------------------------------------

test("prompts: import captures the live file as a disabled prompt without writing it", async () => {
  const soulMd = homePath(".hermes", "SOUL.md");
  fs.mkdirSync(path.dirname(soulMd), { recursive: true });
  fs.writeFileSync(soulMd, "# persona\nbe concise\n");

  const res = await post("/api/provider-switch/prompts/import", { app: "hermes" });
  assert.equal(res.status, 200);
  assert.equal(fs.readFileSync(soulMd, "utf8"), "# persona\nbe concise\n");
  const imported = res.body.prompts.find((entry) => entry.id.startsWith("imported-"));
  assert.ok(imported);
  assert.equal(imported.enabled, false);
  assert.match(imported.content, /be concise/);

  // Missing file → clean error.
  const missing = await post("/api/provider-switch/prompts/import", { app: "pi" });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /不存在/);
});

test("prompts: sync projects the first enabled prompt per app and leaves no-enabled files alone", async () => {
  const claudeMd = homePath(".claude", "CLAUDE.md");
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  fs.writeFileSync(claudeMd, "# untouched user content");
  await post("/api/provider-switch/prompts", {
    app: "claude",
    prompt: { id: "x", name: "X", content: "x-content", enabled: true },
  });
  // Simulate external drift.
  fs.writeFileSync(claudeMd, "drifted");

  const res = await post("/api/provider-switch/prompts/sync", {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.failures, []);
  assert.equal(fs.readFileSync(claudeMd, "utf8"), "x-content");

  // No enabled prompts → file untouched.
  fs.writeFileSync(claudeMd, "user owns this");
  const store = JSON.parse(fs.readFileSync(homePath(".aitool", "provider-switch", "prompts.json"), "utf8"));
  for (const prompt of store.apps.mcode) prompt.enabled = false;
  fs.writeFileSync(homePath(".aitool", "provider-switch", "prompts.json"), JSON.stringify(store));
  const res2 = await post("/api/provider-switch/prompts/sync", { apps: ["mcode"] });
  assert.equal(res2.status, 200);
  assert.equal(fs.existsSync(homePath(".minimax", "AGENTS.md")), false);
});

test("prompts: sync with two enabled prompts projects the first in insertion order and warns", async () => {
  const opencodeMd = homePath(".config", "opencode", "AGENTS.md");
  fs.mkdirSync(homePath(".aitool", "provider-switch"), { recursive: true });
  fs.mkdirSync(path.dirname(opencodeMd), { recursive: true });
  // Hand-write the store into the dual-enabled state (only reachable outside
  // the API, which keeps exactly one enabled per app).
  const store = { version: 1, apps: { opencode: [
    { id: "first", name: "First", content: "first-content", description: "", enabled: true, createdAt: "", updatedAt: "" },
    { id: "second", name: "Second", content: "second-content", description: "", enabled: true, createdAt: "", updatedAt: "" },
  ] } };
  fs.writeFileSync(homePath(".aitool", "provider-switch", "prompts.json"), JSON.stringify(store));

  const res = await post("/api/provider-switch/prompts/sync", { apps: ["opencode"] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.failures, []);
  assert.equal(fs.readFileSync(opencodeMd, "utf8"), "first-content");
  assert.equal(res.body.warnings.length, 1);
  assert.match(res.body.warnings[0], /first, second/);
});

test("prompts: upsert-enable turns off the previously enabled prompt instead of double-enabling", async () => {
  const grokMd = homePath(".grok", "AGENTS.md");
  fs.mkdirSync(path.dirname(grokMd), { recursive: true });
  await post("/api/provider-switch/prompts", {
    app: "grokbuild",
    prompt: { id: "a", name: "A", content: "a-content", enabled: true },
  });
  await post("/api/provider-switch/prompts", {
    app: "grokbuild",
    prompt: { id: "b", name: "B", content: "b-content", enabled: true },
  });
  assert.equal(fs.readFileSync(grokMd, "utf8"), "b-content");
  const res = await get("/api/provider-switch/prompts?app=grokbuild");
  assert.equal(res.body.prompts.filter((entry) => entry.enabled).length, 1);
  assert.equal(res.body.prompts.find((entry) => entry.id === "a").content, "a-content", "the older prompt's stored template must survive the switch");
});

test("prompts: upsert-enable refuses an oversized live file instead of overwriting blind", async () => {
  const piMd = homePath(".pi", "agent", "AGENTS.md");
  fs.mkdirSync(path.dirname(piMd), { recursive: true });
  fs.writeFileSync(piMd, "y".repeat(1024 * 1024 + 1));
  const res = await post("/api/provider-switch/prompts", {
    app: "pi",
    prompt: { id: "big", name: "Big", content: "small", enabled: true },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /1 MiB/);
  assert.equal(fs.readFileSync(piMd, "utf8").length, 1024 * 1024 + 1, "the oversized file must survive");
});

// ---------------------------------------------------------------------------
// Validation + guards
// ---------------------------------------------------------------------------

test("prompts: mcode content is capped at 32 KiB (utf8 bytes), other apps at 1 MiB", async () => {
  const big = "中".repeat(10923) + "a"; // 32770 utf8 bytes, one over the cap
  const mcode = await post("/api/provider-switch/prompts", {
    app: "mcode",
    prompt: { id: "big", name: "Big", content: big, enabled: false },
  });
  assert.equal(mcode.status, 400);
  assert.match(mcode.body.error, /32 KiB/);

  const ok = await post("/api/provider-switch/prompts", {
    app: "claude",
    prompt: { id: "same-size", name: "Same", content: big, enabled: false },
  });
  assert.equal(ok.status, 200);
});

test("prompts: unsupported apps and bad ids are rejected", async () => {
  const badApp = await get("/api/provider-switch/prompts?app=ios");
  assert.equal(badApp.status, 400);

  const badId = await post("/api/provider-switch/prompts", {
    app: "claude",
    prompt: { id: "../escape", name: "X", content: "x" },
  });
  assert.equal(badId.status, 400);
  assert.match(badId.body.error, /letters, digits/);
});

test("prompts: oversized live files refuse enable instead of overwriting blind", async () => {
  const claudeMd = homePath(".claude", "CLAUDE.md");
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  fs.writeFileSync(claudeMd, "x".repeat(1024 * 1024 + 1));
  await post("/api/provider-switch/prompts", {
    app: "claude",
    prompt: { id: "y", name: "Y", content: "y", enabled: false },
  });
  const res = await post("/api/provider-switch/prompts/enable", { app: "claude", id: "y" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /1 MiB/);
  assert.equal(fs.readFileSync(claudeMd, "utf8").length, 1024 * 1024 + 1, "the oversized file must survive");
});
