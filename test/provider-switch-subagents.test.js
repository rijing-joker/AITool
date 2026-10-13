const test = require('node:test');
const assert = require('node:assert/strict');
const { parse: parseToml } = require('smol-toml');
const parse = text => JSON.parse(JSON.stringify(parseToml(text)));
const { projectCodex, extractCodexConfig } = require('../src/lib/provider-switch/targets');
const editor = require('../src/lib/provider-switch/editor');
const toml = require('../src/lib/provider-switch/toml');
const provider = agents => ({ id: 'fixture', settingsConfig: { config: { agents } } });

test('Codex subagent defaults switch and clear without changing user roles, limits or notify', () => {
  const prev = provider({ default_subagent_model: 'old', default_subagent_reasoning_effort: 'low' });
  const target = provider({ default_subagent_model: 'new', default_subagent_reasoning_effort: 'high' });
  for (const agents of [
    '[agents]\nmax_threads = 8 # keep this comment\ndefault_subagent_model = "old"\ndefault_subagent_reasoning_effort = "low"\n[agents.reviewer]\nconfig_file = "review.toml"\n',
    'agents = { max_threads = 8, default_subagent_model = "old", default_subagent_reasoning_effort = "low", reviewer = { config_file = "review.toml" } }\n',
    'agents.max_threads = 8\nagents.default_subagent_model = "old"\nagents.default_subagent_reasoning_effort = "low"\n[agents.reviewer]\nconfig_file = "review.toml"\n',
  ]) {
    const liveToml = 'notify = ["my-hook"]\n' + agents;
    const updated = projectCodex({ prev, target, liveToml }).configToml;
    assert.deepEqual(parse(updated).agents, { max_threads: 8, default_subagent_model: 'new', default_subagent_reasoning_effort: 'high', reviewer: { config_file: 'review.toml' } });
    if (agents.includes('# keep')) assert.match(updated, /max_threads = 8 # keep this comment/);
    const cleared = projectCodex({ prev: target, target: provider({}), liveToml: updated }).configToml;
    assert.deepEqual(parse(cleared), { notify: ['my-hook'], agents: { max_threads: 8, reviewer: { config_file: 'review.toml' } } });
  }
});

test('subagent defaults are provider fields while user agent edits keep three-way conflict checks', () => {
  const base = { config: { agents: { default_subagent_model: 'old', max_threads: 4, reviewer: { config_file: 'one.toml' } } } };
  const edited = { config: { agents: { default_subagent_model: 'new', max_threads: 8, reviewer: { config_file: 'two.toml' } } } };
  const plan = editor.planSave('codex', {}, edited, base);
  assert.deepEqual(plan.rowSettings.config.agents, { default_subagent_model: 'new' });
  assert.deepEqual(plan.changes.map(c => c.path), [['agents', 'max_threads'], ['agents', 'reviewer']]);
  const original = '[agents]\ndefault_subagent_model = "old"\nmax_threads = 6\n[agents.reviewer]\nconfig_file = "one.toml"\n';
  const lives = { config: { exists: true, content: original } };
  assert.equal(editor.resolveConflicts('codex', plan.changes, lives)[0].conflict, true);
  const applied = editor.applyChanges('codex', lives, plan.changes);
  assert.deepEqual(parse(applied.config.content).agents, { default_subagent_model: 'old', max_threads: 8, reviewer: { config_file: 'two.toml' } });
  assert.deepEqual(extractCodexConfig(original).config.agents, { default_subagent_model: 'old' });
});

test('empty agent defaults remove their empty table and preserve hand-edited residue', () => {
  const prev = provider({ default_subagent_model: 'old' });
  assert.equal(parse(projectCodex({ prev, target: provider({}), liveToml: '[agents]\ndefault_subagent_model = "old"\n' }).configToml).agents, undefined);
  assert.equal(parse(projectCodex({ prev, target: provider({}), liveToml: '[agents]\ndefault_subagent_model = "mine"\n' }).configToml).agents.default_subagent_model, 'mine');
  assert.deepEqual(parse(toml.setTableValue('[agents.reviewer]\nconfig_file="old"\n', 'agents', 'max_threads', 4)).agents, { max_threads: 4, reviewer: { config_file: 'old' } });
});

test('editing an agent array of tables keeps the existing unsupported-format guard', () => {
  const content = '[[agents.reviewer]]\nconfig_file = "one.toml"\n';
  const base = { config: parse(content) };
  const edited = { config: { agents: { reviewer: [{ config_file: 'two.toml' }] } } };
  const { changes } = editor.planSave('codex', {}, edited, base);
  assert.throws(() => editor.applyChanges('codex', { config: { exists: true, content } }, changes), /array-of-tables/);
});
