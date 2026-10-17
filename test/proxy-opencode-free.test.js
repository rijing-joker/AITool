const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createAdapter, buildRequest, usageFromResponses } = require('../src/lib/proxy/opencode-free/server');
const { createCatalog, selectModels, VERIFIED_FREE_IDS } = require('../src/lib/proxy/opencode-free/catalog');
const { computeRowCost, getModelPricing } = require('../src/lib/pricing');
const token = 'test-internal-key-'.repeat(4);
const models = [{ id: 'big-pickle', protocol: 'chat' }, { id: 'muse-spark-1.3-contributor-free', protocol: 'responses' }];
const fixtureCatalog = () => ({ snapshot: () => ({ models, lastError: null }), refresh: async () => ({ models, lastError: null }), resolve: async id => models.find(m => m.id === id) });
const input = { model: 'big-pickle', messages: [{ role: 'user', content: 'Synthetic fixture' }], max_tokens: 20 };
const usage = { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 7 } };
function sse(events) { return new Response(events.map(x => `data: ${typeof x === 'string' ? x : JSON.stringify(x)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }); }
const chatEvents = (delta = { content: 'OK' }, finish = 'stop') => [
  { choices: [{ index: 0, delta, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  { choices: [], usage }, '[DONE]',
];
async function adapter(t, fetchImpl, options = {}) {
  const server = createAdapter({ token, selectedModels: () => models.map(m => m.id), catalog: fixtureCatalog(), fetchImpl, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, send: (body = input, headers = {}) => fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) }) };
}
function metadata(overrides = {}) {
  return { opencode: { npm: '@ai-sdk/openai-compatible', models: {
    'big-pickle': { id: 'big-pickle', name: 'Pickle', cost: { input: 0, output: 0 }, modalities: { output: ['text'] }, tool_call: true, ...overrides },
  } } };
}

test('catalog requires live zero pricing, supported protocol, tools and reviewed ID', () => {
  const live = { data: [{ id: 'big-pickle' }] };
  assert.equal(selectModels(live, metadata()).length, 1);
  for (const override of [{ status: 'deprecated' }, { cost: { input: 0.1, output: 0 } }, { cost: { input: 0, output: 0, cache_read: 1 } }, { provider: { npm: '@ai-sdk/anthropic' } }, { tool_call: false }, { id: 'paid-free' }]) {
    assert.equal(selectModels(live, metadata(override)).length, 0);
  }
  assert.equal(selectModels({ data: [] }, metadata()).length, 0);
});

test('catalog coalesces refreshes and fails closed after network errors or retirement', async () => {
  let calls = 0, failing = false, retired = false, now = 100000;
  const catalog = createCatalog({ now: () => now, fetchImpl: async url => {
    calls++; if (failing) throw new Error('network');
    return Response.json(url.includes('models.dev') ? metadata() : { data: retired ? [] : [{ id: 'big-pickle' }] });
  } });
  await Promise.all(Array.from({ length: 10 }, () => catalog.refresh()));
  assert.equal(calls, 2); assert.ok(await catalog.resolve('big-pickle'));
  failing = true; now += 3600001;
  assert.equal(await catalog.resolve('big-pickle'), false);
  assert.equal(catalog.snapshot().lastError, 'catalog_unavailable');
  failing = false; retired = true; await catalog.refresh(true);
  assert.equal(await catalog.resolve('big-pickle'), undefined);
});

test('client token ceilings and tool choice survive both upstream protocols', () => {
  const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { filename: { type: 'string' } } } } }, { type: 'function', function: { name: 'read_client', parameters: { type: 'object' } } }];
  for (const model of models) {
    const request = buildRequest({ ...input, tools, tool_choice: { type: 'function', function: { name: 'read' } } }, model);
    assert.equal(request.payload[model.protocol === 'responses' ? 'max_output_tokens' : 'max_tokens'], 20);
    assert.equal(request.aliasToOriginal.get('read_client2'), 'read');
    assert.equal(model.protocol === 'responses' ? request.payload.tool_choice.name : request.payload.tool_choice.function.name, 'read_client2');
  }
  assert.throws(() => buildRequest({ ...input, max_tokens: 0 }, models[0]), /invalid_token_budget/);
});

test('adapter requires its internal key and selected exact model ID', async t => {
  let called = 0;
  const { send, url } = await adapter(t, async () => { called++; return sse(chatEvents()); });
  assert.equal((await send(input, { authorization: 'Bearer public' })).status, 401);
  assert.equal((await fetch(`${url}/health`)).status, 401);
  assert.equal((await send({ ...input, model: 'deepseek' })).status, 400);
  assert.equal((await send({ ...input, model: 'gpt-5.4' })).status, 400);
  assert.equal(called, 0);
});

for (const stream of [false, true]) test(`chat preserves usage details and completion (${stream ? 'stream' : 'JSON'})`, async t => {
  const { send } = await adapter(t, async (url, options) => {
    assert.equal(url, 'https://opencode.ai/inference/openai/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer public');
    assert.equal(JSON.parse(options.body).max_tokens, 20);
    return sse(chatEvents());
  });
  const res = await send({ ...input, stream, stream_options: { include_usage: true } });
  assert.equal(res.status, 200);
  if (!stream) { const body = await res.json(); assert.deepEqual(body.usage, usage); assert.equal(body.choices[0].message.content, 'OK'); }
  else { const text = await res.text(); assert.match(text, /"cached_tokens":80/); assert.match(text, /"reasoning_tokens":7/); assert.ok(text.endsWith('data: [DONE]\n\n')); }
});

for (const stream of [false, true]) test(`Responses lane preserves detailed usage and incomplete reason (${stream})`, async t => {
  const { send } = await adapter(t, async url => {
    assert.ok(url.endsWith('/responses'));
    return sse([{ type: 'response.output_text.delta', delta: '你好' }, { type: 'response.incomplete', response: {
      incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 100, output_tokens: 12, total_tokens: 112,
        input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 7 } },
    } }]);
  });
  const res = await send({ ...input, model: models[1].id, stream, stream_options: { include_usage: true } });
  const text = await res.text();
  assert.match(text, /你好/); assert.match(text, /"finish_reason":"length"/); assert.match(text, /"cached_tokens":80/); assert.match(text, /"reasoning_tokens":7/);
  assert.deepEqual(usageFromResponses({ input_tokens: 5 }), { prompt_tokens: 5 });
});

test('tool aliases restore original names and result IDs round-trip without parameter remapping', async t => {
  let calls = 0;
  const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { filename: { type: 'string' } } } } }];
  const { send } = await adapter(t, async (url, options) => {
    const body = JSON.parse(options.body); calls++;
    if (calls === 1) return sse(chatEvents({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_client', arguments: '{"filename":"fixture"}' } }] }, 'tool_calls'));
    assert.equal(body.messages.find(m => m.role === 'assistant').tool_calls[0].function.name, 'read_client');
    assert.equal(body.messages.find(m => m.role === 'tool').tool_call_id, 'call_1');
    return sse(chatEvents());
  });
  const first = await (await send({ ...input, tools })).json();
  assert.equal(first.choices[0].message.tool_calls[0].function.name, 'read');
  assert.equal(first.choices[0].message.tool_calls[0].function.arguments, '{"filename":"fixture"}');
  const second = await (await send({ ...input, tools, messages: [...input.messages, first.choices[0].message, { role: 'tool', tool_call_id: 'call_1', content: 'fixture result' }] })).json();
  assert.equal(second.choices[0].message.content, 'OK');
});

test('injected or unknown tools never reach the client, even with fragmented names', async t => {
  const { send } = await adapter(t, async () => sse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'sh', arguments: '' } }] } }] },
    ...chatEvents({ tool_calls: [{ index: 0, function: { name: 'ell', arguments: '{}' } }] }, 'tool_calls'),
  ]));
  for (const stream of [false, true]) {
    const res = await send({ ...input, stream }); const text = await res.text();
    assert.equal(res.status, 502); assert.match(text, /unsupported_upstream_tool/); assert.doesNotMatch(text, /"name":"shell"/);
  }
});

test('HTTP errors, incomplete SSE and stream errors are failures, not fabricated success', async t => {
  let response = () => new Response('contains private echo', { status: 403 });
  const { send, url } = await adapter(t, async () => response());
  assert.equal((await send()).status, 403);
  let health = await (await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(health.lastInference.code, 'client_validation_failed');
  assert.doesNotMatch(JSON.stringify(health), /private echo|Synthetic fixture/);
  response = () => new Response('', { status: 429 }); assert.equal((await send()).status, 429);
  response = () => sse([{ choices: [{ index: 0, delta: { content: 'partial' } }] }]);
  assert.equal((await send()).status, 502);
  response = () => sse([{ error: { message: 'private prompt' } }]);
  const text = await (await send({ ...input, stream: true })).text();
  assert.match(text, /upstream_stream_error/); assert.doesNotMatch(text, /private prompt|\[DONE\]/);
});

test('timeout aborts the upstream and returns a bounded diagnostic', async t => {
  let aborted = false;
  const { send } = await adapter(t, async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); });
  }), { timeoutMs: 40 });
  const res = await send(); assert.equal(res.status, 504); assert.equal(aborted, true);
});

test('client cancellation aborts an in-flight upstream', async t => {
  let entered, aborted;
  const started = new Promise(resolve => { entered = resolve; });
  const stopped = new Promise(resolve => { aborted = resolve; });
  const { url } = await adapter(t, async (url, { signal }) => new Promise((resolve, reject) => {
    entered(); signal.addEventListener('abort', () => { aborted(); reject(signal.reason); });
  }));
  const controller = new AbortController();
  const request = fetch(`${url}/v1/chat/completions`, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(input) }).catch(() => {});
  await started; controller.abort(); await stopped; await request;
});

test('free IDs price at zero without changing paid siblings or other cliproxy rows', () => {
  for (const model of VERIFIED_FREE_IDS) {
    const price = getModelPricing(model); assert.equal(price.input, 0); assert.equal(price.output, 0);
    assert.equal(computeRowCost({ source: 'cliproxy', model, input_tokens: 1e6, output_tokens: 1e6, cached_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }), 0);
  }
  assert.ok(computeRowCost({ source: 'cliproxy', model: 'deepseek-v4.1-flash', input_tokens: 1e6 }) > 0);
});

test('native group merge preserves unrelated keys/overrides and rejects ownership conflicts', () => {
  const { mergeGroup } = require('../src/lib/proxy/opencode-free');
  const existing = [{ name: 'personal', keys: [{ 'api-key': 'private', 'proxy-url': 'socks5://local', headers: { custom: '1' } }], models: [{ name: 'paid' }], future: true }];
  const settings = { token, port: 20129, models: ['big-pickle'] };
  const merged = mergeGroup(existing, settings, true);
  assert.deepEqual(merged[0], existing[0]); assert.equal(merged[1]['base-url'], 'http://127.0.0.1:20129/v1');
  assert.deepEqual(mergeGroup(merged, settings, false), existing);
  assert.throws(() => mergeGroup([{ name: 'aitool-opencode-free', keys: [] }], settings, true), /conflict/);
});

test('free group sync preserves aliases and overrides while reconciling selected model names', () => {
  const { mergeGroup } = require('../src/lib/proxy/opencode-free');
  const settings = { token, port: 20129, models: ['beam-free', 'big-pickle'] };
  const group = {
    name: 'aitool-opencode-free', 'base-url': 'http://127.0.0.1:20129/v1',
    keys: [{ 'api-key': token, 'proxy-url': 'direct', headers: { custom: 'keep' }, models: [
      { name: 'big-pickle', alias: 'key-pickle', thinking: { levels: ['high'] } },
    ] }],
    models: [
      { name: 'big-pickle', alias: 'big-pickle', 'display-name': 'Pickle', thinking: { levels: ['low', 'high'] } },
      { name: 'big-pickle', alias: 'pickle-high', future: { keep: true } },
      { name: 'beam-free', alias: 'beam-alias' },
    ],
  };
  const snapshot = structuredClone(group);
  // Restart/unchanged selection does not reorder or recreate native mappings,
  // including a per-key override that only exposes an alias for a source ID.
  assert.deepEqual(mergeGroup([group], settings, true), [group]);
  const [updated] = mergeGroup([group], { ...settings, models: ['big-pickle', 'space-bunny-free'] }, true);
  const added = { name: 'space-bunny-free', alias: 'space-bunny-free' };
  assert.deepEqual(updated.models, [...group.models.slice(0, 2), added]);
  assert.deepEqual(updated.keys[0].models, [group.keys[0].models[0], added]);
  assert.deepEqual(updated.keys[0].headers, group.keys[0].headers);
  assert.deepEqual(group, snapshot, 'sync must not mutate the fetched configuration');
  assert.deepEqual(mergeGroup([updated], { ...settings, models: ['big-pickle', 'space-bunny-free'] }, true), [updated]);
  const [removed] = mergeGroup([updated], { ...settings, models: ['space-bunny-free'] }, true);
  assert.deepEqual(removed.models, [added]);
  assert.deepEqual(removed.keys[0].models, [added]);
});

test('CLI presets use the current proxy port, empty client keys and the current Codex auth model', () => {
  const config = require('../src/lib/proxy/config'); const original = config.getServerPort;
  config.getServerPort = () => 19999;
  try {
    const { freePreset } = require('../src/lib/provider-switch/opencode-free-preset');
    assert.equal(freePreset('claude').settingsConfig.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:19999');
    const codex = freePreset('codex').settingsConfig;
    assert.equal(codex.auth, null); assert.equal(codex.config.model_providers.custom.wire_api, 'responses');
    assert.equal(codex.config.model_providers.custom.experimental_bearer_token, '');
    assert.equal(freePreset('opencode').settingsConfig.provider.options.baseURL, 'http://127.0.0.1:19999/v1');
  } finally { config.getServerPort = original; }
});

test('dashboard control endpoints require local mutation auth and status never exposes keys', async t => {
  const { handleProxyApiRequest } = require('../src/lib/proxy/api');
  const free = require('../src/lib/proxy/opencode-free');
  const original = { status: free.status, configure: free.configure, refresh: free.refresh };
  let writes = 0;
  free.status = async () => ({ enabled: false, running: false, selectedModels: [], catalog: { models: [] } });
  free.configure = async body => { writes++; return { enabled: body.enabled, running: false }; };
  free.refresh = async () => { writes++; return { models: [] }; };
  const http = require('node:http');
  const server = http.createServer((req, res) => handleProxyApiRequest(req, res, new URL(req.url, 'http://localhost'), {
    isAuthorizedLocalMutation: request => request.headers['x-test-local'] === 'yes',
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { Object.assign(free, original); server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}/api/proxy/opencode-free`;
  for (const suffix of ['', '/refresh']) assert.equal((await fetch(url + suffix, { method: 'POST', body: '{}' })).status, 401);
  assert.equal(writes, 0);
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-test-local': 'yes' }, body: '{"enabled":false}' })).status, 200);
  assert.equal(writes, 1);
});
