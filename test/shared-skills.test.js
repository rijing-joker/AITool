"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-shared-skills-")), old = process.env.HOME, oldCodex = process.env.CODEX_HOME; process.env.HOME = home; process.env.CODEX_HOME = path.join(home, ".codex");
  t.after(() => { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex; fs.rmSync(home, { recursive: true, force: true }); });
  const shared = path.join(home, ".agents", "skills", "研究"); fs.mkdirSync(shared, { recursive: true }); fs.writeFileSync(path.join(shared, "SKILL.md"), "---\nname: Research\n---\nLocal instructions\n");
  return { home, shared, skills: require("../src/lib/skills-manager") };
}
test("Shared skills retain their effective shared scope until explicit verified handover and can be handed back", t => {
  const x = fixture(t);
  assert.equal(x.skills.listInstalledSkills().find(row => row.directory === "研究").shared.scope, "shared");
  const imported = x.skills.importLocalSkill("研究", ["codex"]);
  assert.equal(fs.lstatSync(x.shared).isDirectory(), true);
  x.skills.setSkillTargets(imported.id, []); assert.ok(fs.existsSync(path.join(x.shared, "SKILL.md")));
  const result = x.skills.handOverSharedSkills(["研究"]); assert.equal(result.results[0].ok, true);
  assert.equal(fs.existsSync(x.shared), false);
  let row = x.skills.listInstalledSkills().find(row => row.directory === "研究"); assert.equal(row.shared, null); assert.ok(row.targets.includes("codex"));
  x.skills.setSkillTargets(row.id, ["gemini"]); assert.equal(fs.existsSync(path.join(x.home, ".codex", "skills", "研究")), false);
  const returned = x.skills.handBackSharedSkill(row.id); assert.equal(returned.ok, true); assert.ok(fs.existsSync(path.join(x.shared, "SKILL.md")));
  row = x.skills.listInstalledSkills().find(row => row.directory === "研究"); assert.equal(row.shared.scope, "shared");
});
test("Shared symlink handover preserves its external directory and migrates user links", t => {
  const x = fixture(t), external = path.join(x.home, "custom"); fs.renameSync(x.shared, external); fs.symlinkSync(external, x.shared, "dir");
  const native = path.join(x.home, ".claude", "skills", "研究"); fs.mkdirSync(path.dirname(native), { recursive: true }); fs.symlinkSync(x.shared, native, "dir");
  const result = x.skills.handOverSharedSkills(["研究"]); assert.equal(result.results[0].ok, true); assert.ok(fs.existsSync(path.join(external, "SKILL.md"))); assert.equal(fs.existsSync(x.shared), false); assert.ok(fs.existsSync(path.join(native, "SKILL.md")));
});
test("Handover fails before moving source on divergent target content or a redirected parent", t => {
  const x = fixture(t), native = path.join(x.home, ".codex", "skills", "研究"); fs.mkdirSync(native, { recursive: true }); fs.writeFileSync(path.join(native, "SKILL.md"), "User customization");
  const result = x.skills.handOverSharedSkills(["研究"]); assert.equal(result.results[0].ok, false); assert.match(result.results[0].error, /different/); assert.ok(fs.existsSync(x.shared)); assert.equal(fs.readFileSync(path.join(native, "SKILL.md"), "utf8"), "User customization");
  fs.rmSync(native, { recursive: true }); fs.rmSync(path.join(x.home, ".tokentracker"), { recursive: true, force: true }); const outside = path.join(x.home, "outside"); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(x.home, ".tokentracker"), "dir");
  assert.match(x.skills.handOverSharedSkills(["研究"]).results[0].error, /redirected/); assert.ok(fs.existsSync(x.shared));
});

test("an interrupted handover rolls back from its durable receipt and preserves outside edits", t => {
  const x = fixture(t), result = x.skills.handOverSharedSkills(["研究"]).results[0];
  assert.equal(result.ok, true);
  const manifestFile = path.join(result.recoveryPath, "manifest.json"), manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.status = "recovery-required"; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const target = path.join(x.home, ".codex", "skills", "研究");
  fs.unlinkSync(target); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "SKILL.md"), "outside edit");
  assert.throws(() => x.skills.recoverSharedSkill(path.basename(result.recoveryPath)), /changed/);
  assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), "outside edit");
  assert.equal(fs.existsSync(x.shared), false);
  fs.rmSync(target, { recursive: true });
  fs.symlinkSync(manifest.destination, target, "dir");
  x.skills.recoverSharedSkill(path.basename(result.recoveryPath));
  assert.ok(fs.existsSync(path.join(x.shared, "SKILL.md")));
  assert.equal(x.skills.listSharedSkillRecovery().length, 0);
});

test("a crash after handback moves content can finish without stale registry writes", t => {
  const x = fixture(t); x.skills.handOverSharedSkills(["研究"]);
  const row = x.skills.listInstalledSkills().find(item => item.directory === "研究");
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => { if (String(file).endsWith("registry.json")) throw new Error("fixture registry interruption"); return write(file, ...args); };
  try { assert.throws(() => x.skills.handBackSharedSkill(row.id), /interruption/); }
  finally { fs.writeFileSync = write; }
  const receipts = x.skills.listSharedSkillRecovery(); assert.equal(receipts.length, 1);
  assert.equal(receipts[0].direction, "hand-back");
  x.skills.recoverSharedSkill(receipts[0].id);
  assert.equal(x.skills.listSharedSkillRecovery().length, 0);
  assert.equal(x.skills.listInstalledSkills().find(item => item.id === row.id).shared.scope, "shared");
});

test("shared handover keeps an unreadable registry intact", t => {
  const x = fixture(t), registry = path.join(x.home, ".tokentracker", "skills", "registry.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true }); fs.writeFileSync(registry, "{broken");
  assert.equal(x.skills.handOverSharedSkills(["研究"]).results[0].ok, false);
  assert.equal(fs.readFileSync(registry, "utf8"), "{broken"); assert.ok(fs.existsSync(x.shared));
});

test("provider-switch resolves the managed source after shared library handover", async t => {
  const x = fixture(t), native = require("../src/lib/provider-switch/skills");
  await native.importSkills();
  const result = x.skills.handOverSharedSkills(["研究"]).results[0]; assert.equal(result.ok, true);
  const listed = (await native.listSkills()).find(row => row.id === "研究");
  assert.equal(listed.sourceDir, path.join(x.home, ".tokentracker", "skills", "managed", "研究"));
  assert.equal(listed.shared, null);
  assert.deepEqual((await native.toggleSkill("研究", "codex", true)).failures, []);
  assert.ok(fs.existsSync(path.join(x.home, ".codex", "skills", "研究", "SKILL.md")));
  assert.deepEqual((await native.toggleSkill("研究", "codex", false)).failures, []);
  assert.equal(fs.existsSync(path.join(x.home, ".codex", "skills", "研究")), false);
  assert.deepEqual((await native.toggleSkill("研究", "codex", true)).failures, []);
  assert.ok(fs.existsSync(path.join(x.home, ".codex", "skills", "研究", "SKILL.md")));
  assert.deepEqual((await native.syncSkills(["codex"])).failures, []);
  assert.ok(fs.existsSync(path.join(x.home, ".codex", "skills", "研究", "SKILL.md")));
});

test("provider-switch preserves a user replacement of a handed-over link even when it points to the same source", async t => {
  const x = fixture(t), native = require("../src/lib/provider-switch/skills");
  await native.importSkills();
  const result = x.skills.handOverSharedSkills(["研究"]).results[0]; assert.equal(result.ok, true);
  const target = path.join(x.home, ".codex", "skills", "研究"), source = fs.readlinkSync(target);
  // Retain the original inode so the replacement cannot reuse it.
  fs.renameSync(target, path.join(x.home, "original-link")); fs.symlinkSync(source, target, "dir");
  assert.deepEqual((await native.toggleSkill("研究", "codex", false)).failures, []);
  assert.equal(fs.readlinkSync(target), source);
  assert.ok(fs.existsSync(path.join(target, "SKILL.md")));
});

test("provider-switch removes verified handover copies and preserves copies edited outside AiTool", async t => {
  const x = fixture(t), native = require("../src/lib/provider-switch/skills");
  await native.importSkills();
  const symlink = fs.symlinkSync;
  fs.symlinkSync = () => { throw Object.assign(new Error("fixture symlinks unavailable"), { code: "EPERM" }); };
  let result;
  try { result = x.skills.handOverSharedSkills(["研究"]).results[0]; }
  finally { fs.symlinkSync = symlink; }
  assert.equal(result.ok, true);
  const codex = path.join(x.home, ".codex", "skills", "研究"), gemini = path.join(x.home, ".gemini", "skills", "研究");
  assert.equal(fs.lstatSync(codex).isDirectory(), true);
  assert.deepEqual((await native.toggleSkill("研究", "codex", false)).failures, []);
  assert.equal(fs.existsSync(codex), false);
  fs.appendFileSync(path.join(gemini, "SKILL.md"), "User customization\n");
  assert.deepEqual((await native.toggleSkill("研究", "gemini", false)).failures, []);
  assert.ok(fs.readFileSync(path.join(gemini, "SKILL.md"), "utf8").endsWith("User customization\n"));
});
