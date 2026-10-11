const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");

// Skills v1 (cc-switch services/skill.rs): SSOT discovery from the agents'
// skills directories, per-app projection via symlink-or-stamped-copy, and
// disable removing only what we wrote.

let tmpHome;
let prevHome;
let prevUserProfile;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-skills-home-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.HERMES_HOME;
  delete process.env.MINIMAX_DATA_DIR;
  delete process.env.MAVIS_DATA_DIR;
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

function makeSkill(dir, id, { name, description } = {}) {
  const skillDir = path.join(dir, id);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
    "---",
    `name: ${name || id}`,
    `description: ${description || "does things"}`,
    "---",
    "",
    "# body",
  ].join("\n"));
  fs.writeFileSync(path.join(skillDir, "helper.txt"), "x");
  return skillDir;
}

function handler() {
  const { handleProviderSwitchApiRequest } = require("../src/lib/provider-switch/api");
  return handleProviderSwitchApiRequest;
}

async function call(handlerFn, options) {
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
    isAuthorizedLocalMutation: () => true,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

test("skills: parseSkillMeta reads frontmatter scalars and falls back to the dir name", () => {
  const skills = require("../src/lib/provider-switch/skills");
  const meta = skills.parseSkillMeta("/x/pdf", "---\nname: PDF Tools\ndescription: \"Reads PDFs\"\n---\nbody");
  assert.deepEqual(meta, { id: "pdf", name: "PDF Tools", description: "Reads PDFs" });
  const bare = skills.parseSkillMeta("/x/bare", "no frontmatter here");
  assert.equal(bare.name, "bare");
});

test("skills: import discovers from the agents dirs, toggle symlinks, disable removes only ours", async () => {
  const skills = require("../src/lib/provider-switch/skills");
  const claudeDir = path.join(tmpHome, ".claude", "skills");
  const geminiDir = path.join(tmpHome, ".gemini", "skills");
  const agentsDir = path.join(tmpHome, ".agents", "skills");
  fs.mkdirSync(geminiDir, { recursive: true }); // gemini is installed
  makeSkill(claudeDir, "pdf-tools", { name: "PDF Tools" });
  makeSkill(agentsDir, "shared-skill");
  // A directory without SKILL.md is not a skill.
  fs.mkdirSync(path.join(claudeDir, "not-a-skill"), { recursive: true });

  const h = handler();
  const imported = await call(h, { method: "POST", url: "/api/provider-switch/skills/import", body: "{}" });
  assert.equal(imported.status, 200);
  const byId = Object.fromEntries(imported.body.skills.map((skill) => [skill.id, skill]));
  assert.equal(byId["pdf-tools"].name, "PDF Tools");
  assert.equal(byId["shared-skill"].sourceDir, path.join(agentsDir, "shared-skill"));
  assert.equal(byId["not-a-skill"], undefined);

  // Toggling on for the app the skill was discovered in is a no-op: it is
  // already live there, and projecting a directory onto itself is an error.
  const toggled = await call(h, {
    method: "POST",
    url: "/api/provider-switch/skills/toggle",
    body: JSON.stringify({ id: "pdf-tools", app: "claude", enabled: true }),
  });
  assert.equal(toggled.status, 200);
  assert.deepEqual(toggled.body.failures, []);
  assert.equal(fs.existsSync(path.join(claudeDir, "pdf-tools", "SKILL.md")), true, "still the user's own directory");

  // The same toggle for gemini links the skill into gemini's dir.
  await call(h, {
    method: "POST",
    url: "/api/provider-switch/skills/toggle",
    body: JSON.stringify({ id: "pdf-tools", app: "gemini", enabled: true }),
  });
  const geminiTarget = path.join(geminiDir, "pdf-tools");
  assert.equal(fs.lstatSync(geminiTarget).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(geminiTarget, "SKILL.md")), true);

  // Toggling off removes the projection but keeps the source.
  await call(h, {
    method: "POST",
    url: "/api/provider-switch/skills/toggle",
    body: JSON.stringify({ id: "pdf-tools", app: "gemini", enabled: false }),
  });
  assert.equal(fs.existsSync(geminiTarget), false);
  assert.equal(fs.existsSync(path.join(claudeDir, "pdf-tools", "SKILL.md")), true, "the source is untouched");
  // Disable in the source app is also a no-op (it never deletes the user's
  // only copy).
  await call(h, {
    method: "POST",
    url: "/api/provider-switch/skills/toggle",
    body: JSON.stringify({ id: "pdf-tools", app: "claude", enabled: false }),
  });
  assert.equal(fs.existsSync(path.join(claudeDir, "pdf-tools", "SKILL.md")), true);

  // A user-owned directory with the same id is never removed or replaced:
  // enabling reports the collision instead.
  const userDir = path.join(claudeDir, "shared-skill");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "SKILL.md"), "---\nname: mine\n---\n");
  const collision = await call(h, {
    method: "POST",
    url: "/api/provider-switch/skills/toggle",
    body: JSON.stringify({ id: "shared-skill", app: "claude", enabled: true }),
  });
  assert.ok(collision.body.failures.some((line) => line.startsWith("claude/shared-skill:")), JSON.stringify(collision.body.failures));
  assert.equal(fs.lstatSync(userDir).isSymbolicLink(), false, "the user directory stays a plain directory");
  assert.equal(fs.existsSync(path.join(userDir, "SKILL.md")), true);
});
