"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { parse } = require("smol-toml");
const subagents = require("../src/lib/provider-switch/codex-subagents");
for (const text of [
  '# user\n[agents]\ndefault_subagent_model="keep"\ndefault_subagent_reasoning_effort="high"\nmax_concurrent_threads_per_session=3\n[agents.reviewer]\nconfig_file="role.toml"\n',
  'agents = {default_subagent_model="keep", default_subagent_reasoning_effort="high", max_concurrent_threads_per_session=3, reviewer={config_file="role.toml"}}\n',
]) test("Codex global subagent settings preserve provider model/effort and user roles in every TOML form", () => {
  const before = parse(text).agents;
  const after = parse(subagents.project(text, { enabled: false, interruptMessage: false, maxConcurrentThreadsPerSession: null })).agents;
  assert.equal(after.default_subagent_model, before.default_subagent_model);
  assert.equal(after.default_subagent_reasoning_effort, before.default_subagent_reasoning_effort);
  assert.deepEqual(after.reviewer, before.reviewer);
  assert.equal(after.max_concurrent_threads_per_session, undefined);
  assert.equal(after.enabled, false);
  assert.equal(after.interrupt_message, false);
});
test("Codex subagent settings reject stale revisions and invalid concurrency before writes", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-codex-globals-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "config.toml");
  const original = '# user config\n[agents]\nmax_threads=8\n';
  await fs.writeFile(file, original);
  const state = await subagents.read(file);
  await assert.rejects(subagents.save({ ...state.config, maxConcurrentThreadsPerSession: 0 }, state.revision, file), /positive/);
  await fs.appendFile(file, "# external edit\n");
  await assert.rejects(subagents.save(state.config, state.revision, file), error => error.status === 409);
  assert.equal(await fs.readFile(file, "utf8"), original + "# external edit\n");
});
test("OMP named profile paths win over an inherited agent path and reject escapes", () => {
  const { agentDir } = require("../src/lib/provider-switch/omp");
  assert.equal(agentDir({ HOME: "/fixture", PI_CONFIG_DIR: ".custom", OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/old/agent" }), "/fixture/.custom/profiles/work/agent");
  assert.equal(agentDir({ HOME: "/fixture", OMP_PROFILE: "default", PI_PROFILE: "old" }), "/fixture/.omp/agent");
  assert.throws(() => agentDir({ HOME: "/fixture", OMP_PROFILE: "../escape" }), /Invalid/);
});
