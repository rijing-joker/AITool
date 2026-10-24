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

test("skills: user links survive enable, disable and missing-source sync", async () => {
  const skills = require("../src/lib/provider-switch/skills");
  const targetDir = path.join(tmpHome, ".codex", "skills");
  fs.mkdirSync(targetDir, { recursive: true });
  const sources = [];
  for (const id of ["foreign", "same-source", "dangling"]) {
    const source = makeSkill(path.join(tmpHome, ".agents", "skills"), id);
    const target = path.join(targetDir, id);
    const destination = id === "same-source" ? source : path.join(tmpHome, "user-owned", id);
    if (id === "foreign") fs.mkdirSync(destination, { recursive: true });
    fs.symlinkSync(destination, target, "dir");
    sources.push({ id, source, target, destination });
  }
  await skills.importSkills();
  for (const { id, source, target, destination } of sources) {
    await skills.toggleSkill(id, "codex", true);
    assert.equal(fs.readlinkSync(target), destination);
    await skills.toggleSkill(id, "codex", false);
    assert.equal(fs.readlinkSync(target), destination);
    fs.rmSync(source, { recursive: true });
  }
  await skills.syncSkills(["codex"]);
  for (const { target, destination } of sources) assert.equal(fs.readlinkSync(target), destination);
});

test("skills: ownership survives a reload but does not cover a replacement link", async () => {
  let skills = require("../src/lib/provider-switch/skills");
  const source = makeSkill(path.join(tmpHome, ".agents", "skills"), "demo");
  const target = path.join(tmpHome, ".gemini", "skills", "demo");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await skills.importSkills();
  await skills.toggleSkill("demo", "gemini", true);
  delete require.cache[require.resolve("../src/lib/provider-switch/skills")];
  skills = require("../src/lib/provider-switch/skills");
  await skills.toggleSkill("demo", "gemini", false);
  assert.equal(fs.existsSync(target), false);

  await skills.toggleSkill("demo", "gemini", true);
  fs.unlinkSync(target);
  const userTarget = path.join(tmpHome, "my-skill");
  fs.symlinkSync(userTarget, target, "dir");
  await skills.toggleSkill("demo", "gemini", false);
  assert.equal(fs.readlinkSync(target), userTarget);
  fs.rmSync(source, { recursive: true });
  await skills.syncSkills(["gemini"]);
  assert.equal(fs.readlinkSync(target), userTarget);
});

test("skills: missing-source cleanup removes only our recorded dangling link", async () => {
  const skills = require("../src/lib/provider-switch/skills");
  const source = makeSkill(path.join(tmpHome, ".agents", "skills"), "demo");
  const target = path.join(tmpHome, ".gemini", "skills", "demo");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await skills.importSkills();
  await skills.toggleSkill("demo", "gemini", true);
  fs.rmSync(source, { recursive: true });
  await skills.syncSkills(["gemini"]);
  assert.equal(fs.lstatSync(target, { throwIfNoEntry: false }), undefined);
});

test("skills: a user replacement pointing to the same source remains user-owned", async () => {
  const skills = require("../src/lib/provider-switch/skills");
  const source = makeSkill(path.join(tmpHome, ".agents", "skills"), "demo");
  const target = path.join(tmpHome, ".gemini", "skills", "demo");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await skills.importSkills();
  await skills.toggleSkill("demo", "gemini", true);
  // Build the replacement while the original exists so it has a distinct
  // identity even on filesystems that promptly recycle deleted inodes.
  const replacement = path.join(path.dirname(target), "replacement");
  fs.symlinkSync(source, replacement, "dir");
  fs.unlinkSync(target);
  fs.renameSync(replacement, target);
  await skills.toggleSkill("demo", "gemini", true);
  await skills.toggleSkill("demo", "gemini", false);
  assert.equal(fs.readlinkSync(target), source);
  fs.rmSync(source, { recursive: true });
  await skills.syncSkills(["gemini"]);
  assert.equal(fs.readlinkSync(target), source);
});

test("skills: copy fallback remains removable and preserves a stamped source", async (t) => {
  const skills = require("../src/lib/provider-switch/skills");
  const source = makeSkill(path.join(tmpHome, ".claude", "skills"), "demo");
  fs.writeFileSync(path.join(source, skills.COPY_STAMP_FILE), "old installation");
  fs.mkdirSync(path.join(source, "nested"));
  fs.writeFileSync(path.join(source, "nested", "helper.txt"), "nested content");
  const target = path.join(tmpHome, ".gemini", "skills", "demo");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await skills.importSkills();
  t.mock.method(require("node:fs/promises"), "symlink", async () => {
    throw Object.assign(new Error("Symlinks unavailable"), { code: "EPERM" });
  });
  const result = await skills.toggleSkill("demo", "gemini", true);
  assert.deepEqual(result.failures, []);
  assert.equal(fs.lstatSync(target).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(target, "helper.txt"), "utf8"), "x");
  assert.equal(fs.readFileSync(path.join(target, "nested", "helper.txt"), "utf8"), "nested content");
  assert.notEqual(fs.readFileSync(path.join(target, skills.COPY_STAMP_FILE), "utf8"), "old installation");
  await skills.toggleSkill("demo", "gemini", false);
  await skills.toggleSkill("demo", "claude", false);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.join(source, "SKILL.md")), true);
});
test("skills: failed fallback keeps the old projection and retries without a partial live directory", async t => {
  const skills = require("../src/lib/provider-switch/skills"), fsp = require("node:fs/promises");
  const source = makeSkill(path.join(tmpHome, ".claude/skills"), "demo");
  const target = path.join(tmpHome, ".gemini/skills/demo");
  fs.mkdirSync(path.dirname(target), { recursive: true }); await skills.importSkills();
  t.mock.method(fsp, "symlink", async () => { throw Object.assign(new Error("No symlinks"), { code: "EPERM" }); });
  assert.deepEqual((await skills.toggleSkill("demo", "gemini", true)).failures, []);
  fs.writeFileSync(path.join(source, "helper.txt"), "new");
  const copy = fsp.cp;
  const broken = t.mock.method(fsp, "cp", async (...args) => { if (args[0].endsWith("helper.txt")) throw new Error("Disk full"); return copy(...args); });
  assert.equal((await skills.syncSkills(["gemini"])).failures.length, 1);
  assert.equal(fs.readFileSync(path.join(target, "helper.txt"), "utf8"), "x");
  assert.equal(fs.readdirSync(path.dirname(target)).some(name => name.startsWith(".aitool-skill-")), false);
  broken.mock.restore();
  assert.deepEqual((await skills.syncSkills(["gemini"])).failures, []);
  assert.equal(fs.readFileSync(path.join(target, "helper.txt"), "utf8"), "new");
});

test("skills: copy fallback preserves an entry created during the symlink attempt", async (t) => {
  const skills = require("../src/lib/provider-switch/skills");
  makeSkill(path.join(tmpHome, ".claude", "skills"), "demo");
  const target = path.join(tmpHome, ".gemini", "skills", "demo");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await skills.importSkills();
  t.mock.method(require("node:fs/promises"), "symlink", async () => {
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "mine.txt"), "user content");
    throw Object.assign(new Error("Symlinks unavailable"), { code: "EPERM" });
  });
  const result = await skills.toggleSkill("demo", "gemini", true);
  assert.equal(result.failures.length, 1);
  assert.equal(fs.existsSync(path.join(target, "SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(target, skills.COPY_STAMP_FILE)), false);
  await skills.toggleSkill("demo", "gemini", false);
  assert.equal(fs.readFileSync(path.join(target, "mine.txt"), "utf8"), "user content");
});

test("skills: a concurrent disable waits for link creation and leaves the stored state applied", async (t) => {
  const skills = require("../src/lib/provider-switch/skills");
  const fsp = require("node:fs/promises");
  makeSkill(path.join(tmpHome, ".agents", "skills"), "demo");
  const target = path.join(tmpHome, ".gemini", "skills", "demo");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await skills.importSkills();
  let started, release;
  const pending = new Promise((resolve) => { started = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  const symlink = fsp.symlink;
  t.mock.method(fsp, "symlink", async (...args) => {
    started();
    await resume;
    return symlink(...args);
  });
  const enable = skills.toggleSkill("demo", "gemini", true);
  await pending;
  const disable = skills.toggleSkill("demo", "gemini", false);
  release();
  await Promise.all([enable, disable]);
  assert.equal(fs.existsSync(target), false);
  assert.equal((await skills.listSkills())[0].apps.gemini, false);
});
