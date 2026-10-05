const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const paths = require("../src/lib/proxy/paths");
const config = require("../src/lib/proxy/config");
const localApi = require("../src/lib/local-api");
const { handleProxyApiRequest } = require("../src/lib/proxy/api");
const bridge = require("../src/lib/proxy/usage-bridge");

const timestamp = "2026-10-01T08:12:00.000Z";
const hour = "2026-10-01T08:00:00.000Z";
const control = { support_refresh: true, received_at: timestamp };
const zeroRequest = { timestamp, model: "unknown", tokens: { totalTokens: 0 } };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-usage-test-"));
  const previous = { usageDir: paths.usageDir, bucketsStatePath: paths.bucketsStatePath, pricingPath: paths.pricingPath };
  paths.usageDir = path.join(root, "usage");
  paths.bucketsStatePath = path.join(paths.usageDir, "buckets.json");
  // Keep the pricing sync off the real HOME and off the network: no store on
  // disk and fetch rejects, so record responses stay unannotated.
  paths.pricingPath = path.join(paths.usageDir, "models-dev-pricing.json");
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const queuePath = path.join(root, "queue.jsonl");
  t.mock.method(localApi, "resolveQueuePath", () => queuePath);
  fs.mkdirSync(paths.usageDir);
  const recordPath = path.join(paths.usageDir, "records-2026-10-01.jsonl");
  t.after(() => {
    bridge.stopBridge();
    Object.assign(paths, previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, queuePath, recordPath };
}

function jsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function writeHistory({ queuePath, recordPath }, records, count = records.length) {
  fs.writeFileSync(recordPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const bucket = {
    model: "unknown", hour_start: hour,
    input_tokens: 25, cached_input_tokens: 5, cache_creation_input_tokens: 0,
    output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 40,
    conversation_count: count,
  };
  fs.writeFileSync(paths.bucketsStatePath, JSON.stringify({ version: 1, source: "cliproxy", buckets: {
    [`unknown|${hour}`]: bucket,
    [`other|${hour}`]: { ...bucket, model: "other", conversation_count: 9 },
  } }));
  fs.writeFileSync(queuePath, [
    { ...bucket, source: "codex" },
    { ...bucket, source: "cliproxy" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("control payloads never change request counters, raw records or queue", (t) => {
  const f = fixture(t);
  const before = bridge.bridgeStatus();
  for (const value of [control, { support_refresh: false }, null, [], [control], "ping"]) {
    bridge.handleUsagePayload(JSON.stringify(value));
  }
  bridge.handleUsagePayload("invalid JSON");
  assert.deepEqual(bridge.bridgeStatus(), before);
  assert.deepEqual(fs.readdirSync(paths.usageDir), []);
  assert.equal(fs.existsSync(f.queuePath), false);
});

test("zero-token requests are kept, including failures and cancellations", (t) => {
  const f = fixture(t);
  const before = bridge.bridgeStatus().eventsSeenSinceConnect;
  for (const extra of [{}, { failed: true }, { canceled: true }]) {
    bridge.handleUsagePayload(JSON.stringify({ ...zeroRequest, ...extra }));
  }
  assert.equal(bridge.bridgeStatus().eventsSeenSinceConnect, before + 3);
  const records = fs.readdirSync(paths.usageDir).filter((n) => n.endsWith(".jsonl"));
  assert.equal(jsonl(path.join(paths.usageDir, records[0])).length, 3);
  assert.equal(jsonl(f.queuePath).at(-1).conversation_count, 1);
  assert.equal(jsonl(f.queuePath).at(-1).total_tokens, 0);
});

test("repair subtracts only controls, preserves other usage, backs up and is idempotent", (t) => {
  const f = fixture(t);
  writeHistory(f, [control, zeroRequest, { ...control, support_refresh: false }]);
  const beforeQueue = fs.readFileSync(f.queuePath, "utf8");
  const beforeRecords = fs.readFileSync(f.recordPath, "utf8");
  const result = bridge.repairUsageHistory();
  assert.equal(result.removedRecords, 2);
  assert.equal(result.correctedBuckets, 1);
  assert.equal(fs.readFileSync(path.join(result.backupDir, "queue.jsonl"), "utf8"), beforeQueue);
  assert.equal(fs.readFileSync(path.join(result.backupDir, path.basename(f.recordPath)), "utf8"), beforeRecords);
  assert.deepEqual(jsonl(f.recordPath), [zeroRequest]);
  const rows = jsonl(f.queuePath);
  assert.equal(rows[0].source, "codex");
  assert.equal(rows[0].conversation_count, 3);
  assert.equal(rows.at(-1).conversation_count, 1);
  assert.equal(rows.at(-1).total_tokens, 40);
  assert.equal(rows.at(-1).input_tokens, 25);
  const saved = JSON.parse(fs.readFileSync(paths.bucketsStatePath, "utf8"));
  assert.equal(saved.buckets[`unknown|${hour}`].conversation_count, 1);
  assert.equal(saved.buckets[`other|${hour}`].conversation_count, 9);
  assert.deepEqual(bridge.repairUsageHistory(), { removedRecords: 0, correctedBuckets: 0 });
  assert.equal(jsonl(f.queuePath).length, rows.length);
  bridge.handleUsagePayload(JSON.stringify(zeroRequest));
  assert.equal(jsonl(f.queuePath).at(-1).conversation_count, 2);
  assert.equal(jsonl(f.queuePath).at(-1).total_tokens, 40);
});

test("repair retracts control-only buckets even when the state flush was lost", (t) => {
  const f = fixture(t);
  writeHistory(f, [control]);
  const row = jsonl(f.queuePath).at(-1);
  for (const key of Object.keys(row)) if (key.endsWith("_tokens")) row[key] = 0;
  fs.writeFileSync(f.queuePath, JSON.stringify(row) + "\n");
  fs.unlinkSync(paths.bucketsStatePath);
  bridge.repairUsageHistory();
  assert.equal(jsonl(f.queuePath).at(-1).conversation_count, 0);
  assert.equal(jsonl(f.queuePath).at(-1).total_tokens, 0);
  assert.equal(jsonl(f.queuePath).at(-1).total_cost_usd, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.bucketsStatePath, "utf8")).buckets, {});
  assert.deepEqual(jsonl(f.recordPath), []);
});

test("repair resumes after a partial write without subtracting controls twice", (t) => {
  const f = fixture(t);
  writeHistory(f, [control, zeroRequest]);
  const original = fs.renameSync;
  const rename = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === f.recordPath) throw new Error("interrupted record rewrite");
    return original(from, to);
  });
  assert.throws(() => bridge.repairUsageHistory(), /interrupted record rewrite/);
  assert.equal(jsonl(f.queuePath).at(-1).conversation_count, 1);
  rename.mock.restore();
  bridge.repairUsageHistory();
  assert.equal(jsonl(f.queuePath).at(-1).conversation_count, 1);
  assert.equal(JSON.parse(fs.readFileSync(paths.bucketsStatePath, "utf8")).buckets[`unknown|${hour}`].conversation_count, 1);
  assert.deepEqual(jsonl(f.recordPath), [zeroRequest]);
});

test("proxy overview and request list exclude legacy notifications before repair", async (t) => {
  const f = fixture(t);
  writeHistory(f, [control, zeroRequest, { ...zeroRequest, failed: true }]);
  for (const endpoint of ["overview", "records"]) {
    let result;
    await handleProxyApiRequest({ method: "GET" }, {
      writeHead(status) { assert.equal(status, 200); },
      end(body) { result = JSON.parse(body); },
    }, new URL(`http://localhost/api/proxy/usage/${endpoint}`), {});
    if (endpoint === "overview") {
      assert.equal(result.overview.total_requests, 2);
      assert.equal(result.overview.success_count, 1);
      assert.equal(result.overview.failure_count, 1);
    } else {
      assert.equal(result.total, 2);
      assert.equal(result.records.length, 2);
    }
  }
});

test("combined pagination and stats use the same filtered records and preserve the stats-only API", async (t) => {
  const f = fixture(t);
  writeHistory(f, [
    control,
    { ...zeroRequest, provider: "up-a" },
    { ...zeroRequest, provider: "up-a", failed: true },
    { ...zeroRequest, provider: "up-b", canceled: true },
  ]);
  async function read(query) {
    let payload;
    await handleProxyApiRequest({ method: "GET" }, {
      writeHead(status) { assert.equal(status, 200); },
      end(body) { payload = JSON.parse(body); },
    }, new URL(`http://localhost/api/proxy/usage/records?${query}`), {});
    return payload;
  }
  const combined = await read("includeStats=1&pageSize=1&model=unknown");
  assert.equal(combined.records.length, 1);
  assert.equal(combined.total, 3);
  assert.deepEqual(combined.stats, (await read("stats=1&model=unknown")).stats);
  assert.equal(combined.stats.success_count, 1);
  assert.equal(combined.stats.failure_count, 1);
  assert.equal(combined.stats.canceled_count, 1);
  // Provider aggregation mirrors computeOverview: success requests and
  // failures count toward the provider; canceled-only providers do not.
  assert.deepEqual(combined.stats.providers, [
    { provider: "up-a", requests: 1, total_tokens: 0, failures: 1 },
  ]);
  const canceled = await read("includeStats=1&result=canceled");
  assert.equal(canceled.total, 1);
  assert.equal(canceled.records[0].canceled, true);
  assert.equal(canceled.stats.total_requests, 1);
  assert.equal(canceled.stats.total_tokens, 0);
  assert.deepEqual(canceled.stats.providers, []);
});

test("container liveness succeeds independently of proxy readiness", async (t) => {
  const f = fixture(t);
  t.mock.method(require("../src/lib/proxy/manager"), "status", () => { throw new Error("must not probe the core"); });
  const handler = localApi.createLocalApiHandler({ queuePath: f.queuePath });
  let result;
  const handled = await handler({ method: "GET", headers: {} }, {
    writeHead(status) { assert.equal(status, 200); },
    end(body) { result = JSON.parse(body); },
  }, new URL("http://localhost/api/health"));
  assert.equal(handled, true);
  assert.deepEqual(result, { ok: true });
});

test("RESP backfill, subscribe and reconnect ignore controls but accept the next request", async (t) => {
  const f = fixture(t);
  const sockets = [];
  const bulk = (value) => `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  const message = (value) => Buffer.from(`*3\r\n${bulk("message")}${bulk("usage")}${bulk(JSON.stringify(value))}`);
  t.mock.method(config, "getServerPort", () => 8318);
  t.mock.method(config, "getManagementKey", () => "test-key");
  const realConnect = net.connect;
  t.mock.method(net, "connect", (...args) => {
    if (args[0]?.port !== 8318) return realConnect(...args);
    const socket = new EventEmitter();
    let pops = 0;
    socket.setNoDelay = socket.unref = () => {};
    socket.destroy = () => socket.emit("close");
    socket.write = (command) => {
      let reply;
      if (command.includes("AUTH")) reply = Buffer.from("+OK\r\n");
      if (command.includes("LPOP")) reply = Buffer.from(pops++ === 0 ? bulk(JSON.stringify(control)) : "$-1\r\n");
      if (command.includes("SUBSCRIBE")) reply = message(control);
      if (reply) process.nextTick(() => socket.emit("data", reply));
    };
    sockets.push(socket);
    process.nextTick(() => socket.emit("connect"));
    return socket;
  });
  bridge.startBridge();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.bridgeStatus().eventsSeenSinceConnect, 0);
  assert.equal(fs.existsSync(f.queuePath), false);
  sockets[0].destroy();
  const deadline = Date.now() + 3000;
  while (sockets.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sockets.length, 2);
  assert.equal(bridge.bridgeStatus().eventsSeenSinceConnect, 0);
  sockets[1].emit("data", message(zeroRequest));
  assert.equal(bridge.bridgeStatus().eventsSeenSinceConnect, 1);
  assert.equal(jsonl(f.queuePath).at(-1).conversation_count, 1);
});

test("queue fold applies executor token semantics: fresh input, reasoning only when separate", (t) => {
  const f = fixture(t);
  // OpenAI-family upstream: input includes the cached share, reasoning is a
  // subset of output — the fold must not double-bill either.
  bridge.handleUsagePayload(JSON.stringify({
    timestamp, model: "gpt-5.2", executor_type: "OpenAIExecutor",
    tokens: { inputTokens: 300, outputTokens: 90, reasoningTokens: 40, cacheReadTokens: 140, cacheCreationTokens: 0, totalTokens: 390 },
  }));
  // Claude upstream: input is already fresh; thinking rides inside output.
  bridge.handleUsagePayload(JSON.stringify({
    timestamp, model: "claude-sonnet-5", executor_type: "ClaudeExecutor",
    tokens: { inputTokens: 100, outputTokens: 60, reasoningTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 10, totalTokens: 1090 },
  }));
  // Gemini upstream: input includes cache AND thoughts are separate output.
  bridge.handleUsagePayload(JSON.stringify({
    timestamp, model: "gemini-3-pro", executor_type: "GeminiExecutor",
    tokens: { inputTokens: 500, outputTokens: 100, reasoningTokens: 30, cacheReadTokens: 200, cacheCreationTokens: 0, totalTokens: 630 },
  }));
  const rows = jsonl(f.queuePath).filter((row) => row.source === "cliproxy");
  const byModel = new Map(rows.map((row) => [row.model, row]));
  assert.deepEqual(
    { input_tokens: byModel.get("gpt-5.2").input_tokens, reasoning_output_tokens: byModel.get("gpt-5.2").reasoning_output_tokens, total_tokens: byModel.get("gpt-5.2").total_tokens },
    { input_tokens: 160, reasoning_output_tokens: 0, total_tokens: 390 },
  );
  assert.deepEqual(
    { input_tokens: byModel.get("claude-sonnet-5").input_tokens, reasoning_output_tokens: byModel.get("claude-sonnet-5").reasoning_output_tokens },
    { input_tokens: 100, reasoning_output_tokens: 0 },
  );
  assert.deepEqual(
    { input_tokens: byModel.get("gemini-3-pro").input_tokens, reasoning_output_tokens: byModel.get("gemini-3-pro").reasoning_output_tokens },
    { input_tokens: 300, reasoning_output_tokens: 30 },
  );
});
