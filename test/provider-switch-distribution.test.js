"use strict";
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const YAML = require("yaml");
const TOML = require("smol-toml");
const distribution = require("../src/lib/provider-switch/library-distribution");
const skills = require("../src/lib/provider-switch/skills");
const mcp = require("../src/lib/provider-switch/mcp");
const execFile = require("node:util").promisify(require("node:child_process").execFile);
let dir, previous;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-distribution-")); previous = process.env.HOME; process.env.HOME = dir; });
afterEach(async () => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; await fs.rm(dir, { force: true, recursive: true }); });
const role = { name: "review-code", description: "Review code", prompt: "Synthetic role instructions", apps: ["claude", "codex"], skills: [], mcp: [] };
async function apply(kind, row) { const plan = await distribution.preview({ kind, row }); assert.deepEqual(plan.errors, []); return distribution.apply({ kind, row, revision: plan.revision }); }
test("roles render native formats and remove only unchanged managed files", async () => {
  await apply("subagent", role);
  const codex = path.join(dir, ".codex/agents/review-code.toml"), claude = path.join(dir, ".claude/agents/review-code.md");
  assert.equal(TOML.parse(await fs.readFile(codex, "utf8")).developer_instructions, role.prompt);
  assert.match(await fs.readFile(claude, "utf8"), /name: review-code/);
  await fs.appendFile(codex, "\n# user edit");
  const plan = await distribution.preview({ kind: "subagent", row: { ...role, apps: [] } }); assert.match(plan.errors.join(" "), /edited/);
  await assert.rejects(distribution.apply({ kind: "subagent", row: { ...role, apps: [] }, revision: plan.revision }), /edited/);
  assert.equal((await fs.stat(claude)).mode & 0o777, 0o600);
});
test("pre-existing role and symlinked agent directory are never overwritten", async () => {
  const target = path.join(dir, ".claude/agents/review-code.md"); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, "user");
  const plan = await distribution.preview({ kind: "subagent", row: role }); assert.match(plan.errors.join(" "), /User file/);
  await fs.rm(path.dirname(target), { recursive: true }); await fs.mkdir(path.join(dir, "outside")); await fs.symlink(path.join(dir, "outside"), path.dirname(target));
  assert.match((await distribution.preview({ kind: "subagent", row: role })).errors.join(" "), /symlink/);
});
test("project copies use selected scopes and preserve user MCP neighbors", async () => {
  const skillDir = path.join(dir, ".claude/skills/example"); await fs.mkdir(skillDir, { recursive: true }); await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: example\n---\nSynthetic skill"); await skills.importSkills();
  await mcp.upsertServer({ id: "fixture", server: { command: "node", args: ["fixture"] }, apps: {} });
  const project = path.join(dir, "project"); await fs.mkdir(project); await fs.writeFile(path.join(project, ".mcp.json"), '{"mcpServers":{"user":{"command":"user"}},"custom":true}');
  const row = { dir: project, apps: ["claude"], skills: ["example"], mcp: ["fixture"] };
  await apply("project", row);
  const doc = JSON.parse(await fs.readFile(path.join(project, ".mcp.json"))); assert.equal(doc.custom, true); assert.equal(doc.mcpServers.user.command, "user"); assert.equal(doc.mcpServers.fixture.command, "node");
  assert.match(await fs.readFile(path.join(project, ".claude/skills/example/SKILL.md"), "utf8"), /Synthetic skill/);
  await apply("project", { ...row, skills: [], mcp: [] });
  assert.equal(JSON.parse(await fs.readFile(path.join(project, ".mcp.json"))).mcpServers.fixture, undefined);
  assert.equal(JSON.parse(await fs.readFile(path.join(project, ".mcp.json"))).mcpServers.user.command, "user");
  await assert.rejects(fs.stat(path.join(project, ".claude/skills/example/SKILL.md")), { code: "ENOENT" });
  await apply("project", { ...row, apps: [], skills: [], mcp: [] });
  assert.equal(JSON.parse(await fs.readFile(path.join(project, ".mcp.json"))).mcpServers.user.command, "user");
  assert.equal((await fs.readFile(path.join(project, ".gitignore"), "utf8")).includes("AiTool project distribution"), false);
});
test("recovery manifests describe new files and back up replaced files", async () => {
  const first = await apply("subagent", role);
  const manifest = JSON.parse(await fs.readFile(path.join(first.recoveryPath, "manifest.json")));
  assert.equal(manifest.files.every(row => !row.existed && row.backup === null && row.status === "applied"), true);
  const changed = await apply("subagent", { ...role, prompt: "Changed synthetic instructions" });
  const recovery = JSON.parse(await fs.readFile(path.join(changed.recoveryPath, "manifest.json")));
  assert.equal(recovery.files.every(row => row.existed && row.backup), true);
  assert.match(await fs.readFile(path.join(changed.recoveryPath, recovery.files[0].backup), "utf8"), /Synthetic role instructions/);
});
test("duplicate MCP fields are rejected before any projection", async () => {
  const project = path.join(dir, "project"); await fs.mkdir(project);
  await fs.writeFile(path.join(project, ".mcp.json"), '{"mcpServers":{},"mcpServers":{}}');
  await assert.rejects(distribution.preview({ kind: "project", row: { dir: project, apps: ["claude"], skills: [], mcp: [] } }), /Duplicate/);
});
test("source and destination changes invalidate preview, special source links fail", async () => {
  const project = path.join(dir, "project"), source = path.join(dir, ".claude/skills/example"); await fs.mkdir(project); await fs.mkdir(source, { recursive: true }); await fs.writeFile(path.join(source, "SKILL.md"), "Synthetic"); await skills.importSkills();
  const row = { dir: project, apps: ["codex"], skills: ["example"], mcp: [] }, plan = await distribution.preview({ kind: "project", row });
  await fs.writeFile(path.join(source, "SKILL.md"), "Changed");
  await assert.rejects(distribution.apply({ kind: "project", row, revision: plan.revision }), error => error.status === 409);
  await fs.symlink("SKILL.md", path.join(source, "link.md"));
  await assert.rejects(distribution.preview({ kind: "project", row }), /symlink/);
});

test("project skill copies retain executable bits and keep other files private", { skip: process.platform === "win32" }, async () => {
  const source = path.join(dir, ".claude/skills/example"), project = path.join(dir, "project");
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(project);
  await fs.writeFile(path.join(source, "SKILL.md"), "Synthetic skill");
  await fs.writeFile(path.join(source, "run.sh"), "#!/bin/sh\nprintf 'skill-ok'\n");
  await fs.chmod(path.join(source, "run.sh"), 0o755);
  await skills.importSkills();
  const row = { dir: project, apps: ["claude", "codex"], skills: ["example"], mcp: [] };
  await apply("project", row);
  for (const scope of [".claude", ".agents"]) {
    const copied = path.join(project, scope, "skills/example");
    assert.equal((await fs.stat(path.join(copied, "run.sh"))).mode & 0o777, 0o711);
    assert.equal((await execFile(path.join(copied, "run.sh"))).stdout, "skill-ok");
    assert.equal((await fs.stat(path.join(copied, "SKILL.md"))).mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(path.join(project, ".gitignore"))).mode & 0o777, 0o600);
  const plan = await distribution.preview({ kind: "project", row });
  await fs.chmod(path.join(source, "run.sh"), 0o644);
  await assert.rejects(distribution.apply({ kind: "project", row, revision: plan.revision }), error => error.status === 409);
  const changed = await apply("project", row);
  assert.equal((await fs.stat(path.join(project, ".agents/skills/example/run.sh"))).mode & 0o777, 0o600);
  const manifest = JSON.parse(await fs.readFile(path.join(changed.recoveryPath, "manifest.json")));
  const script = manifest.files.find(item => item.target.endsWith(".agents/skills/example/run.sh"));
  assert.equal(script.beforeMode, 0o711);
  assert.equal((await fs.stat(path.join(changed.recoveryPath, script.backup))).mode & 0o777, 0o600);
});
