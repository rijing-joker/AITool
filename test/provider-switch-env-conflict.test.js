const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");

// Env-conflict detection (cc-switch env_checker.rs + env_manager.rs):
// keyword scoping, shell-profile parsing, delete-with-backup and restore.

let tmpHome;
let prevHome;
let prevUserProfile;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-envconf-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // Deterministic process environment: seed exactly the vars each case needs.
  for (const key of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_GEMINI_|XAI_API_KEY|GROK_DEFAULT_MODEL)/.test(key)) {
      delete process.env[key];
    }
  }
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

function handler() {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  return handleProviderSwitchApiRequest;
}

async function call(handlerFn, options, { authorized = true } = {}) {
  const req = Readable.from(options.body != null ? [Buffer.from(options.body)] : []);
  req.method = options.method || "GET";
  req.url = options.url;
  req.headers = { host: "localhost" };
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
  await handlerFn(req, res, new URL(`http://localhost${options.url}`), {
    isAuthorizedLocalMutation: () => authorized,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

test("env conflicts: keyword scoping matches cc-switch env_checker", () => {
  const env = require("../src/lib/provider-switch/env-conflict");
  assert.equal(env.matchesKeyword("ANTHROPIC_BASE_URL", env.keywordsForApp("claude")), true);
  assert.equal(env.matchesKeyword("my_anthropic_key", env.keywordsForApp("claude")), false);
  assert.equal(env.matchesKeyword("OPENAI_API_KEY", env.keywordsForApp("codex")), true);
  assert.equal(env.matchesKeyword("GEMINI_API_KEY", env.keywordsForApp("gemini")), true);
  assert.equal(env.matchesKeyword("GOOGLE_GEMINI_BASE_URL", env.keywordsForApp("gemini")), true);
  assert.equal(env.matchesKeyword("XAI_API_KEY", env.keywordsForApp("grokbuild")), true);
  assert.equal(env.matchesKeyword("XAI_API_KEY_BACKUP", env.keywordsForApp("grokbuild")), false);
  assert.equal(env.matchesKeyword("GROK_BIN_DIR", env.keywordsForApp("grokbuild")), false);
  assert.deepEqual(env.keywordsForApp("opencode"), []);
});

test("env conflicts: parseExportLine handles exports, quotes and skips non-assignments", () => {
  const env = require("../src/lib/provider-switch/env-conflict");
  assert.deepEqual(env.parseExportLine("export ANTHROPIC_BASE_URL=https://a.example.com"), {
    name: "ANTHROPIC_BASE_URL",
    value: "https://a.example.com",
  });
  assert.deepEqual(env.parseExportLine('ANTHROPIC_AUTH_TOKEN="sk-1"'), { name: "ANTHROPIC_AUTH_TOKEN", value: '"sk-1"' });
  assert.equal(env.parseExportLine("# export ANTHROPIC_BASE_URL=x"), null);
  assert.equal(env.parseExportLine("echo ANTHROPIC_BASE_URL=hi"), null);
  assert.deepEqual(env.parseExportLine("PATH=/usr/bin:/bin=weird"), { name: "PATH", value: "/usr/bin:/bin=weird" }, "a second = in the value stays in the value");
  assert.equal(env.parseExportLine("1BAD=value"), null, "non-identifier names are skipped");
  assert.equal(env.parseExportLine("MY VAR=x"), null);
});

test("env conflicts: check scans process env and shell profiles per app", () => {
  process.env.ANTHROPIC_BASE_URL = "https://env.example.com";
  const zshrc = path.join(tmpHome, ".zshrc");
  fs.writeFileSync(zshrc, [
    "# comment",
    "export ANTHROPIC_AUTH_TOKEN=sk-from-zshrc",
    'export ANTHROPIC_LOG="quoted value"',
    "PATH=/usr/bin",
    "",
  ].join("\n"));

  const env = require("../src/lib/provider-switch/env-conflict");
  const conflicts = env.checkAppConflicts("claude");
  const byName = Object.fromEntries(conflicts.map((entry) => [entry.varName, entry]));
  assert.equal(byName.ANTHROPIC_BASE_URL.sourceType, "system");
  assert.equal(byName.ANTHROPIC_AUTH_TOKEN.varValue, "sk-from-zshrc");
  assert.match(byName.ANTHROPIC_AUTH_TOKEN.sourcePath, /\.zshrc:2$/);
  assert.equal(byName.ANTHROPIC_LOG.varValue, "quoted value");
  // Other apps do not see Claude's variables.
  assert.equal(env.checkAppConflicts("codex").length, 0);
});

test("env conflicts: api delete removes the lines, keeps a restorable backup", async () => {
  const zshrc = path.join(tmpHome, ".zshrc");
  fs.writeFileSync(zshrc, [
    "export ANTHROPIC_BASE_URL=https://old.example.com",
    "keep_me=1",
    "export ANTHROPIC_API_KEY=sk-old",
  ].join("\n"));
  process.env.OPENAI_API_KEY = "sk-process";

  const h = handler();
  const list = await call(h, { url: "/api/provider-switch/env-conflicts" });
  assert.equal(list.status, 200);
  const claude = list.body.conflicts.claude;
  assert.equal(claude.length, 2);
  assert.deepEqual(list.body.conflicts.codex.map((entry) => entry.varName), ["OPENAI_API_KEY"]);

  const toDelete = claude.map(({ varName, varValue, sourceType, sourcePath }) => ({ varName, varValue, sourceType, sourcePath }));
  const del = await call(h, {
    method: "POST",
    url: "/api/provider-switch/env-conflicts/delete",
    body: JSON.stringify({ conflicts: toDelete }),
  });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, 2);
  assert.equal(fs.existsSync(del.body.backupPath), true);

  const after = fs.readFileSync(zshrc, "utf8");
  assert.doesNotMatch(after, /ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY/);
  assert.match(after, /keep_me=1/);

  // The backup restores exactly what was removed.
  const restore = await call(h, {
    method: "POST",
    url: "/api/provider-switch/env-conflicts/restore",
    body: JSON.stringify({ backupPath: del.body.backupPath }),
  });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.restored, 2);
  const restored = fs.readFileSync(zshrc, "utf8");
  assert.match(restored, /export ANTHROPIC_BASE_URL=https:\/\/old\.example\.com/);
  assert.match(restored, /export ANTHROPIC_API_KEY=sk-old/);
  assert.match(restored, /keep_me=1/);
});

test("env conflicts: delete without auth is rejected and empty payloads fail clean", async () => {
  const h = handler();
  const unauth = await call(h, {
    method: "POST",
    url: "/api/provider-switch/env-conflicts/delete",
    body: JSON.stringify({ conflicts: [{ varName: "X", sourceType: "file", sourcePath: "/tmp/x:1", varValue: "" }] }),
  }, { authorized: false });
  assert.equal(unauth.status, 401, "mutations require local auth");

  const empty = await call(h, {
    method: "POST",
    url: "/api/provider-switch/env-conflicts/delete",
    body: JSON.stringify({ conflicts: [] }),
  });
  assert.equal(empty.status, 400, "an empty selection fails before touching files");

  const badPath = await call(h, {
    method: "POST",
    url: "/api/provider-switch/env-conflicts/restore",
    body: JSON.stringify({ backupPath: path.join(tmpHome, "missing-backup.json") }),
  });
  assert.equal(badPath.status, 400);
});
