const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const paths = require("./paths");
const config = require("./config");
const { isUsageRecord, normalizeRecord } = require("./usage-record");

// Usage bridge — the AiTool fusion point between the CLIProxyAPI core and the
// TokenTracker data plane.
//
// The core emits one JSON usage record per proxied request on a RESP pub/sub
// channel (`SUBSCRIBE usage`, served on the same port as the HTTP API; see
// CLIProxyAPI internal/api/redis_queue_protocol.go). The bridge:
//   1. appends every request event to ~/.aitool/proxy/usage/records-YYYY-MM-DD.jsonl
//      (request-level drill-down, like EasyCLIProxyAPI's usage records), and
//   2. folds successes into cumulative half-hour buckets keyed by
//      (source="cliproxy", model, hour_start) and appends updated rows to the
//      tracker queue (~/.tokentracker/tracker/queue.jsonl). Queue readers
//      dedupe last-row-wins per bucket, so proxy usage shows up in the same
//      dashboard trends / model breakdown / cost views as native CLI tools.
//
// Bucket totals are persisted so a bridge restart continues the same buckets
// instead of double-counting or resetting the hour.

const PROXY_SOURCE_ID = "cliproxy";
const BUCKET_FLUSH_DEBOUNCE_MS = 1_000;

let state = {
  socket: null,
  connected: false,
  connecting: false,
  phase: "idle",
  retryTimer: null,
  retryDelayMs: 1_000,
  buffer: null,
  recordsToday: 0,
  lastEventAt: null,
  lastError: null,
};

// ---------------------------------------------------------------------------
// Half-hour buckets (mirrors TokenTracker rollout.js toUtcHalfHourStart)
// ---------------------------------------------------------------------------

function toUtcHalfHourStart(ts) {
  const dt = new Date(ts);
  if (!Number.isFinite(dt.getTime())) return null;
  const halfMinute = dt.getUTCMinutes() >= 30 ? 30 : 0;
  return new Date(
    Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), dt.getUTCHours(), halfMinute, 0, 0),
  ).toISOString();
}

let buckets = null;
let bucketsLoaded = false;
let bucketFlushTimer = null;

function loadBuckets() {
  if (bucketsLoaded) return buckets;
  bucketsLoaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.bucketsStatePath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.buckets) {
      buckets = new Map(Object.entries(parsed.buckets));
      return buckets;
    }
  } catch {}
  buckets = new Map();
  return buckets;
}

function bucketKey(model, hourStart) {
  return `${model || "unknown"}|${hourStart}`;
}

function newBucket(model, hourStart) {
  return {
    model,
    hour_start: hourStart,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    conversation_count: 0,
  };
}

function scheduleBucketFlush() {
  if (bucketFlushTimer) return;
  bucketFlushTimer = setTimeout(() => {
    bucketFlushTimer = null;
    try {
      fs.mkdirSync(paths.usageDir, { recursive: true });
      const payload = JSON.stringify({
        version: 1,
        source: PROXY_SOURCE_ID,
        buckets: Object.fromEntries(buckets || []),
      });
      const tmp = `${paths.bucketsStatePath}.tmp`;
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      fs.renameSync(tmp, paths.bucketsStatePath);
    } catch (error) {
      console.error("[ProxyBridge] bucket flush failed:", error?.message || error);
    }
  }, BUCKET_FLUSH_DEBOUNCE_MS);
  bucketFlushTimer.unref?.();
}

function appendQueueRow(bucket, queuePath = require("../local-api").resolveQueuePath()) {
  const row = {
    source: PROXY_SOURCE_ID,
    model: bucket.model,
    hour_start: bucket.hour_start,
    input_tokens: bucket.input_tokens,
    cached_input_tokens: bucket.cached_input_tokens,
    cache_creation_input_tokens: bucket.cache_creation_input_tokens,
    output_tokens: bucket.output_tokens,
    reasoning_output_tokens: bucket.reasoning_output_tokens,
    total_tokens: bucket.total_tokens,
    billable_total_tokens: bucket.total_tokens,
    total_cost_usd: 0,
    conversation_count: bucket.conversation_count,
  };
  try {
    const { computeRowCost } = require("../pricing");
    row.total_cost_usd = Number(
      computeRowCost({ ...row, source: PROXY_SOURCE_ID }).toFixed(6),
    );
  } catch (error) {
    console.error("[ProxyBridge] cost computation failed:", error?.message || error);
  }
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.appendFileSync(queuePath, `${JSON.stringify(row)}\n`, { mode: 0o644 });
}

// ---------------------------------------------------------------------------
// RESP client
// ---------------------------------------------------------------------------

// Minimal RESP parser: enough for the core's push frames — arrays of bulk
// strings / integers, plus simple strings, errors and nil bulk for the
// LPOP backfill replies.
function createRespParser(onArray, onFrame) {
  let buffer = Buffer.alloc(0);
  return function feed(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      const lineEnd = buffer.indexOf("\r\n");
      if (lineEnd === -1) return;
      const prefix = String.fromCharCode(buffer[0]);
      const body = buffer.slice(1, lineEnd).toString("utf8");
      if (prefix !== "*") {
        // Non-array frame: +OK / -ERR / :int / $bulk (including $-1 nil).
        let skipBytes;
        if (prefix === "$") {
          const length = Number(body);
          if (!Number.isFinite(length)) {
            skipBytes = lineEnd + 2;
          } else if (length < 0) {
            skipBytes = lineEnd + 2;
            onFrame?.("$", null);
          } else {
            if (buffer.length < lineEnd + 2 + length + 2) return;
            skipBytes = lineEnd + 2 + length + 2;
            onFrame?.("$", buffer.slice(lineEnd + 2, lineEnd + 2 + length).toString("utf8"));
          }
        } else {
          skipBytes = lineEnd + 2;
          onFrame?.(prefix, body);
        }
        buffer = buffer.slice(skipBytes);
        continue;
      }
      const count = Number(body);
      if (!Number.isFinite(count) || count < 0) {
        if (count === -1) onFrame?.("*", null);
        buffer = buffer.slice(lineEnd + 2);
        continue;
      }
      // Scan array elements without consuming until the full array is buffered.
      let offset = lineEnd + 2;
      const elements = [];
      let complete = true;
      for (let i = 0; i < count; i += 1) {
        if (offset >= buffer.length) {
          complete = false;
          break;
        }
        const elementPrefix = String.fromCharCode(buffer[offset]);
        const elementLineEnd = buffer.indexOf("\r\n", offset);
        if (elementLineEnd === -1) {
          complete = false;
          break;
        }
        const elementBody = buffer.slice(offset + 1, elementLineEnd).toString("utf8");
        if (elementPrefix === "$") {
          const length = Number(elementBody);
          if (!Number.isFinite(length)) {
            elements.push(null);
            offset = elementLineEnd + 2;
            continue;
          }
          if (buffer.length < elementLineEnd + 2 + length + 2) {
            complete = false;
            break;
          }
          elements.push(buffer.slice(elementLineEnd + 2, elementLineEnd + 2 + length).toString("utf8"));
          offset = elementLineEnd + 2 + length + 2;
        } else if (elementPrefix === ":") {
          elements.push(Number(elementBody));
          offset = elementLineEnd + 2;
        } else {
          elements.push(elementBody);
          offset = elementLineEnd + 2;
        }
      }
      if (!complete) return;
      buffer = buffer.slice(offset);
      onArray(elements);
    }
  };
}

function handleUsagePayload(payloadText) {
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return;
  }
  if (!isUsageRecord(payload)) return;
  // Canonicalize the core's raw snake_case payload once: the fusion below and
  // the persisted record store both work on camelCase rows, and the raw
  // api_key / response_headers never reach the disk.
  const record = normalizeRecord(payload);
  if (!record) return;
  const now = new Date().toISOString();
  state.recordsToday += 1;
  state.lastEventAt = now;
  state.lastError = null;

  // 1) Request-level record store.
  try {
    fs.mkdirSync(paths.usageDir, { recursive: true });
    const dayFile = path.join(paths.usageDir, `records-${now.slice(0, 10)}.jsonl`);
    fs.appendFileSync(dayFile, `${JSON.stringify({ ...record, received_at: now })}\n`, { mode: 0o600 });
  } catch (error) {
    console.error("[ProxyBridge] record append failed:", error?.message || error);
  }

  // 2) Tracker-queue fusion (successful requests only; failures carry no
  //    reliable token totals).
  if (record.failed || record.canceled) return;
  loadBuckets();
  const tokens = record.tokens || {};
  const hourStart = toUtcHalfHourStart(record.timestamp || now);
  if (!hourStart) return;
  const model = String(record.response_model || record.model || record.alias || "unknown");
  const key = bucketKey(model, hourStart);
  const bucket = buckets.get(key) || newBucket(model, hourStart);
  bucket.input_tokens += Number(tokens.inputTokens) || 0;
  bucket.cached_input_tokens += Number(tokens.cacheReadTokens) || 0;
  bucket.cache_creation_input_tokens += Number(tokens.cacheCreationTokens) || 0;
  bucket.output_tokens += Number(tokens.outputTokens) || 0;
  bucket.reasoning_output_tokens += Number(tokens.reasoningTokens) || 0;
  bucket.total_tokens += Number(tokens.totalTokens) || 0;
  bucket.conversation_count += 1;
  buckets.set(key, bucket);
  appendQueueRow(bucket);
  scheduleBucketFlush();
}

function drainBackfill(socket) {
  // The queue retains events for a while (config default 60s, AiTool sets
  // 3600s), so pull anything queued while the bridge was down before
  // subscribing. Replies arrive as bulk strings (or wrapped arrays); a nil
  // reply ends the backfill and the parser's frame callback flips the phase.
  let drained = 0;
  const lpopLoop = () => {
    if (!state.connected || state.phase !== "backfill") return;
    socket.write("*2\r\n$4\r\nLPOP\r\n$5\r\nusage\r\n");
    drained += 1;
  };
  state.backfillLoop = lpopLoop;
  lpopLoop();
}

function connect() {
  if (state.connecting || state.connected) return;
  const port = config.getServerPort();
  state.connecting = true;
  const socket = net.connect({ host: "127.0.0.1", port, allowHalfOpen: false });
  state.socket = socket;

  let subscribed = false;

  const sendSubscribe = () => {
    if (subscribed || !state.connected) return;
    subscribed = true;
    socket.write("*2\r\n$9\r\nSUBSCRIBE\r\n$5\r\nusage\r\n");
  };

  const feed = createRespParser((elements) => {
    if (state.phase === "backfill") {
      // Some core builds wrap LPOP payloads in arrays; anything else here
      // means the backfill is done and we can subscribe.
      if (Array.isArray(elements) && typeof elements[0] === "string" && elements[0].trim().startsWith("{")) {
        handleUsagePayload(elements[0]);
        state.backfillLoop?.();
        return;
      }
      state.phase = "subscribed";
      sendSubscribe();
      return;
    }
    if (subscribed && Array.isArray(elements) && elements[0] === "message" && elements[1] === "usage") {
      handleUsagePayload(elements[2] || "");
    }
  }, (prefix, value) => {
    if (state.phase === "authing") {
      if (prefix === "+") {
        state.phase = "backfill";
        drainBackfill(socket);
      } else if (prefix === "-") {
        state.lastError = `resp auth failed: ${value}`;
        socket.destroy();
      }
      return;
    }
    if (state.phase === "backfill" && prefix === "$") {
      if (value === null) {
        state.phase = "subscribed";
        sendSubscribe();
        return;
      }
      if (typeof value === "string" && value.trim().startsWith("{")) {
        handleUsagePayload(value);
        state.backfillLoop?.();
      }
    }
  });

  socket.setNoDelay(true);
  // The bridge is a passenger of its host process (dashboard server), never
  // the thing keeping it alive — an `aitool proxy start` CLI invocation must
  // still exit after the detached core is up.
  socket.unref();
  socket.on("connect", () => {
    state.connected = true;
    state.connecting = false;
    state.phase = "authing";
    state.retryDelayMs = 1_000;
    state.lastError = null;
    state.recordsToday = 0;
    // The core's RESP endpoint rejects everything before AUTH; it validates
    // the management secret exactly like the HTTP management API.
    const token = config.getManagementKey();
    if (!token) {
      state.lastError = "management-key-unavailable";
      socket.destroy();
      return;
    }
    socket.write(`*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(token, "utf8")}\r\n${token}\r\n`);
  });
  socket.on("data", feed);
  socket.on("error", (error) => {
    state.lastError = error?.code || error?.message || String(error);
  });
  socket.on("close", () => {
    state.connected = false;
    state.connecting = false;
    state.phase = "idle";
    state.socket = null;
    if (state.stopping) return;
    scheduleRetry();
  });

  function scheduleRetry() {
    if (state.retryTimer || state.stopping) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      state.retryDelayMs = Math.min(state.retryDelayMs * 2, 30_000);
      connect();
    }, state.retryDelayMs);
    state.retryTimer.unref?.();
  }
}

function repairUsageHistory() {
  if (state.connected || state.connecting) throw new Error("Stop the usage bridge before repairing history");
  if (bucketFlushTimer) flushBucketsSync();
  // Do not let the exit hook restore stale totals if a repair fails midway.
  buckets = null;
  bucketsLoaded = false;
  const result = require("./usage-repair").repairUsageHistory({
    queuePath: require("../local-api").resolveQueuePath(),
    toUtcHalfHourStart,
    appendQueueRow,
  });
  return result;
}

function startBridge() {
  if (state.connected || state.connecting) return bridgeStatus();
  repairUsageHistory();
  loadBuckets();
  state.stopping = false;
  connect();
  return bridgeStatus();
}

function stopBridge() {
  state.stopping = true;
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  flushBucketsSync();
  buckets = null;
  bucketsLoaded = false;
  if (state.socket) {
    try {
      state.socket.destroy();
    } catch {}
    state.socket = null;
  }
  state.connected = false;
}

function bridgeStatus() {
  return {
    running: state.connected,
    connecting: state.connecting,
    lastEventAt: state.lastEventAt,
    lastError: state.lastError,
    eventsSeenSinceConnect: state.recordsToday,
    bucketCount: buckets ? buckets.size : 0,
  };
}

function flushBucketsSync() {
  if (bucketFlushTimer) {
    clearTimeout(bucketFlushTimer);
    bucketFlushTimer = null;
  }
  if (!buckets) return;
  try {
    fs.mkdirSync(paths.usageDir, { recursive: true });
    fs.writeFileSync(
      paths.bucketsStatePath,
      JSON.stringify({ version: 1, source: PROXY_SOURCE_ID, buckets: Object.fromEntries(buckets) }),
      { mode: 0o600 },
    );
  } catch {}
}

process.on("exit", flushBucketsSync);

module.exports = {
  startBridge,
  stopBridge,
  bridgeStatus,
  handleUsagePayload,
  repairUsageHistory,
  toUtcHalfHourStart,
  PROXY_SOURCE_ID,
};
