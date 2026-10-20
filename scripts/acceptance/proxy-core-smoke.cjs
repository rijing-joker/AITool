#!/usr/bin/env node
'use strict';

// Opt-in, isolated release validation. All inference goes to a loopback fixture;
// no installed core, live configuration, account or user queue is changed.
// Usage: node scripts/acceptance/proxy-core-smoke.cjs /absolute/path/to/cli-proxy-api
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const req = createRequire(path.resolve(__dirname, '../../package.json'));
const YAML = req('yaml');
const core = process.argv[2];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

(async () => {
  assert.ok(core && path.isAbsolute(core), 'Pass an absolute path to the core binary');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aitool-core-smoke-'));
  const managementKey = crypto.randomBytes(24).toString('hex');
  const clientKey = crypto.randomBytes(24).toString('hex');
  const calls = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: request.url, body });
    const toolResult = body.messages?.find(message => message.role === 'tool');
    const tool = !toolResult && JSON.stringify(body).includes('call_tool');
    const reply = toolResult ? 'Shanghai fixture result' : 'fixture response';
    const truncated = JSON.stringify(body).includes('truncate_stream');
    const toolCall = { id: 'call_fixture', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } };
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion', created: Math.floor(Date.now()/1000), model: 'fixture-model',
        choices: [{ index: 0, message: { role: 'assistant', content: tool ? null : reply, ...(tool ? { tool_calls: [toolCall] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 25 }, completion_tokens_details: { reasoning_tokens: 5 } } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = (delta, finish = null, usage) => response.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
    if (tool) {
      event({ role: 'assistant', tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: 'get_weather', arguments: '{"city":' } }] });
      event({ tool_calls: [{ index: 0, function: { arguments: '"Shanghai"}' } }] });
    } else event({ role: 'assistant', content: reply });
    if (truncated) { response.end(); return; }
    event({}, tool ? 'tool_calls' : 'stop', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 25 }, completion_tokens_details: { reasoning_tokens: 5 } });
    response.end('data: [DONE]\n\n');
  });
  let child, bridge;
  try {
    await listen(upstream);
    const reserver = http.createServer();
    await listen(reserver);
    const port = reserver.address().port;
    await close(reserver);
    const config = { 'config-version': 8, server: { host: '127.0.0.1', port },
      management: { 'secret-key': managementKey, 'allow-remote': false, 'disable-control-panel': true },
      access: { 'api-keys': [clientKey] }, oauth: { 'auth-dir': path.join(root, 'auths') },
      observability: { logs: { 'request-log': false, 'error-logs-max-files': 0 }, usage: { 'usage-statistics-enabled': true, 'redis-usage-queue-retention-seconds': 3600 } },
      routing: { retry: { 'request-retry': 0 } },
      'api-keys': { 'openai-compatibility': [{ name: 'fixture', 'base-url': `http://127.0.0.1:${upstream.address().port}/v1`, keys: [{ 'api-key': 'fixture-upstream-key', 'proxy-url': 'direct' }], models: [{ name: 'fixture-model', alias: 'smoke' }, { name: 'fixture-model', alias: 'smoke-tool' }, ...['chat', 'claude', 'responses', 'gemini'].map(format => ({ name: `fixture-truncated-${format}`, alias: `smoke-truncated-${format}` }))] }] },
    };
    await fsp.mkdir(config.oauth['auth-dir']);
    await fsp.writeFile(path.join(root, 'config.yaml'), YAML.stringify(config), { mode: 0o600 });
    const output = fs.openSync(path.join(root, 'core.log'), 'a');
    child = cp.spawn(core, ['-config', path.join(root, 'config.yaml'), '-local-model'], { cwd: root, stdio: ['ignore', output, output] });
    fs.closeSync(output);
    const base = `http://127.0.0.1:${port}`;
    const fetchAt = (route, options = {}) => fetch(base + route, { ...options, signal: AbortSignal.timeout(15000) });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { const response = await fetchAt('/v1/models', { headers: { authorization: `Bearer ${clientKey}` } }); if (response.ok) { ready = true; break; } } catch {}
      if (child.exitCode != null) break;
      await delay(100);
    }
    assert.ok(ready, 'isolated core did not become ready');
    const paths = req('./src/lib/proxy/paths');
    const proxyConfig = req('./src/lib/proxy/config');
    paths.usageDir = path.join(root, 'usage');
    paths.bucketsStatePath = path.join(root, 'usage', 'buckets.json');
    proxyConfig.getServerPort = () => port;
    proxyConfig.getManagementKey = () => managementKey;
    const queuePath = path.join(root, 'queue.jsonl');
    req('./src/lib/local-api').resolveQueuePath = () => queuePath;
    bridge = req('./src/lib/proxy/usage-bridge');
    bridge.startBridge();
    for (let i=0; i<40 && !bridge.bridgeStatus().running; i++) await delay(50);
    assert.equal(bridge.bridgeStatus().lastError, null);
    await delay(200);
    const tools = [{ type: 'function', function: { name: 'get_weather', description: 'fixture', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
    const formats = [
      ['chat', '/v1/chat/completions', (stream, tool) => ({ model: tool ? 'smoke-tool' : 'smoke', messages: [{ role: 'user', content: tool ? 'call_tool' : 'hello fixture' }], stream, ...(tool ? { tools } : {}), ...(stream ? { stream_options: { include_usage: true } } : {}) })],
      ['claude', '/v1/messages', (stream, tool) => ({ model: tool ? 'smoke-tool' : 'smoke', max_tokens: 100, messages: [{ role: 'user', content: tool ? 'call_tool' : 'hello fixture' }], stream, ...(tool ? { tools: [{ name: 'get_weather', description: 'fixture', input_schema: tools[0].function.parameters }] } : {}) })],
      ['responses', '/v1/responses', (stream, tool) => ({ model: tool ? 'smoke-tool' : 'smoke', input: [{ role: 'user', content: tool ? 'call_tool' : 'hello fixture' }], stream, ...(tool ? { tools: [{ type: 'function', ...tools[0].function }] } : {}) })],
      ['gemini', null, (stream, tool) => ({ contents: [{ role: 'user', parts: [{ text: tool ? 'call_tool' : 'hello fixture' }] }], ...(tool ? { tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'fixture', parameters: tools[0].function.parameters }] }] } : {}) })],
    ];
    const checks = [];
    let expected = 0;
    for (const [format, route, bodyOf] of formats) for (const stream of [false, true]) for (const tool of [false, true]) {
      const endpoint = route || `/v1beta/models/${tool ? 'smoke-tool' : 'smoke'}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
      const response = await fetchAt(endpoint, { method: 'POST', headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(bodyOf(stream, tool)) });
      const body = await response.text();
      assert.equal(response.status, 200, `${format} ${stream} ${tool}: ${body}`);
      assert.ok(body.includes(tool ? 'get_weather' : 'fixture response'), `${format} response lost its content`);
      if (tool) assert.ok(body.includes('Shanghai'), `${format} response lost tool arguments`);
      expected++;
      checks.push(`${format}:${stream ? 'stream' : 'json'}:${tool ? 'tool' : 'text'}`);
    }
    // Submit a synthetic tool result; the validation never executes a tool.
    for (const stream of [false, true]) {
      const response = await fetchAt('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' }, body: JSON.stringify({
        model: 'smoke-tool', stream, tools, messages: [
          { role: 'user', content: 'call_tool' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } }] },
          { role: 'tool', tool_call_id: 'call_fixture', content: 'fixture weather' },
        ],
      }) });
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes('Shanghai fixture result'));
      assert.equal(calls.at(-1).body.messages.find(message => message.role === 'tool').tool_call_id, 'call_fixture');
      expected++;
      checks.push(`chat:${stream ? 'stream' : 'json'}:tool-result round trip`);
    }
    const waitRecords = async count => {
      for (let i=0; i<100 && bridge.bridgeStatus().eventsSeenSinceConnect<count; i++) await delay(50);
      assert.ok(bridge.bridgeStatus().eventsSeenSinceConnect>=count, `missing usage ${JSON.stringify(bridge.bridgeStatus())}`);
    };
    await waitRecords(expected);
    const readBuckets = async () => new Map((await fsp.readFile(queuePath, 'utf8')).trim().split('\n').map(line => {
      const row = JSON.parse(line);
      return [`${row.model}|${row.hour_start}`, row];
    }));
    const sum = (buckets, field) => [...buckets.values()].reduce((total, row) => total + (row[field] || 0), 0);
    const totalBefore = sum(await readBuckets(), 'total_tokens');
    bridge.stopBridge();
    await delay(150);
    bridge.startBridge();
    await delay(300);
    const response = await fetchAt('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' }, body: JSON.stringify(formats[0][2](false, false)) });
    assert.equal(response.status, 200);
    await response.text();
    await waitRecords(1);
    const buckets = await readBuckets();
    assert.equal(sum(buckets, 'total_tokens'), totalBefore + 120, 'bridge restart broke bucket continuity');
    assert.equal(sum(buckets, 'conversation_count'), expected + 1);
    assert.equal(sum(buckets, 'input_tokens'), (expected + 1) * 75);
    assert.equal(sum(buckets, 'cached_input_tokens'), (expected + 1) * 25);
    assert.equal(sum(buckets, 'output_tokens'), (expected + 1) * 20);
    assert.equal(sum(buckets, 'reasoning_output_tokens'), 0, 'reasoning is already part of output');
    checks.push('RESP bridge:normalized usage:restart continuity');
    const managementHeaders = { authorization: `Bearer ${managementKey}` };
    const snapshot = await fetchAt('/v8/management/config.yaml', { headers: managementHeaders });
    assert.equal(snapshot.status, 200);
    const revision = snapshot.headers.get('etag');
    await snapshot.text();
    assert.ok(revision);
    const nextKeys = [clientKey, 'fixture-extra-client'];
    const saved = await fetchAt('/v8/management/config/access/api-keys', { method: 'PUT', headers: { ...managementHeaders, 'if-match': revision, 'content-type': 'application/json' }, body: JSON.stringify(nextKeys) });
    assert.equal(saved.status, 200, await saved.text());
    const stale = await fetchAt('/v8/management/config/access/api-keys', { method: 'PUT', headers: { ...managementHeaders, 'if-match': revision, 'content-type': 'application/json' }, body: JSON.stringify(['stale']) });
    assert.equal(stale.status, 412);
    await stale.text();
    checks.push('ETag conditional save:stale revision rejected');
    const truncation = [];
    for (const [format, route, bodyOf] of formats) {
      const body = JSON.parse(JSON.stringify(bodyOf(true, false)).replaceAll('hello fixture', 'truncate_stream'));
      if (body.model) body.model = `smoke-truncated-${format}`;
      const endpoint = route || `/v1beta/models/smoke-truncated-${format}:streamGenerateContent?alt=sse`;
      const broken = await fetchAt(endpoint, { method: 'POST', headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const responseBody = await broken.text();
      assert.equal(broken.status, 200, `${format}: ${responseBody}`);
      await waitRecords(truncation.length + 2); // One successful request after reconnect.
      truncation.push({ format, endpoint: endpoint.split('?')[0], httpStatus: broken.status, sentDone: responseBody.includes('[DONE]') });
    }
    const recordFiles = (await fsp.readdir(paths.usageDir)).filter(name=>name.startsWith('records-'));
    const records = (await Promise.all(recordFiles.map(name=>fsp.readFile(path.join(paths.usageDir,name),'utf8')))).join('').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, expected + 1 + truncation.length, 'control notifications must not become usage records');
    for (const result of truncation) {
      const record = records.find(row => row.alias === `smoke-truncated-${result.format}`);
      assert.ok(record, `missing ${result.format} truncation record`);
      result.failed = record.failed;
      result.failureStatus = record.failure_status;
      // Chat and Gemini currently complete a clean EOF; report that upstream
      // limitation instead of claiming all truncations are detected.
      if (['claude', 'responses'].includes(result.format)) assert.equal(record.failed, true, `${result.format} clean EOF must fail`);
    }
    const rawRecords = JSON.stringify(records);
    assert.ok(!rawRecords.includes(clientKey));
    assert.ok(!rawRecords.includes('fixture-upstream-key'));
    checks.push('persisted records:client and upstream keys excluded');
    console.log(JSON.stringify({ checks, truncation, upstreamCalls: calls.length, records: records.length, uniqueRequests: new Set(records.map(row => row.request_id)).size, buckets: buckets.size, freshInput: sum(buckets, 'input_tokens'), cachedInput: sum(buckets, 'cached_input_tokens'), output: sum(buckets, 'output_tokens') }, null, 2));
  } finally {
    bridge?.stopBridge();
    if (child && child.exitCode == null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(3000)]);
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    await close(upstream);
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
