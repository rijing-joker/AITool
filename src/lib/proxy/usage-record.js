const crypto = require("node:crypto");

// The RESP usage channel also carries capability/control notifications on
// subscribe and reconnect. Zero tokens alone do not identify a control frame:
// real failed, canceled and even successful requests can have zero usage.
function isControlNotification(record) {
  return record !== null && typeof record === "object" &&
    Object.hasOwn(record, "support_refresh");
}

function isUsageRecord(record) {
  return record !== null && typeof record === "object" &&
    !Array.isArray(record) && !isControlNotification(record);
}

// ---------------------------------------------------------------------------
// Record shape normalization.
//
// The core publishes snake_case usage payloads (internal/redisqueue/plugin.go:
// tokens.input_tokens, latency_ms, fail.status_code/body, …), while this
// codebase and the dashboard work on camelCase rows. Records written before
// the normalization existed are raw core payloads; normalizeRecord maps both
// shapes onto one canonical row and is idempotent, so the store can normalize
// every row at read time.
//
// It also strips secrets the way EasyCLIProxyAPI's collector does: the raw
// api_key never survives normalization — only a sha256 hash and a masked
// display form — and upstream response_headers are dropped.
// ---------------------------------------------------------------------------

const API_KEY_HASH = (key) => sha256Hex(key);

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function maskApiKey(value) {
  const key = String(value ?? "").trim();
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}••••`;
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function pickNumber(object, camelKey, snakeKey) {
  const value = Number(object?.[camelKey] ?? object?.[snakeKey]);
  return Number.isFinite(value) ? value : 0;
}

function pickString(object, camelKey, snakeKey) {
  const value = object?.[camelKey] ?? object?.[snakeKey];
  return value == null ? "" : String(value);
}

function deriveCanceled(row) {
  if (row.canceled === true) return true;
  if (row.canceled === false) return false;
  if (!row.failed) return false;
  if (row.failure_status === 499) return true;
  const body = String(row.failure_body || "").toLowerCase();
  return body.includes("context canceled") || body.includes("client closed request");
}

function normalizeRecord(record) {
  if (!isUsageRecord(record)) return null;
  const rawTokens = record.tokens && typeof record.tokens === "object" ? record.tokens : {};
  const fail = record.fail && typeof record.fail === "object" ? record.fail : {};
  const originalCanceled = record.canceled;
  const failure_status = Math.trunc(
    Number(fail.status_code ?? record.failure_status ?? record.failureStatus) || 0,
  );
  const failure_body = String(fail.body ?? record.failure_body ?? record.failure_message ?? "").trim();
  const latencyMs = pickNumber(record, "latencyMs", "latency_ms");
  const ttftRaw = Number(record.ttftMs ?? record.ttft_ms);
  const apiKey = pickString(record, "apiKey", "api_key");
  const id = pickString(record, "id", "request_id") || pickString(record, "requestId", "request_id");
  const row = {
    ...record,
    id,
    request_id: pickString(record, "request_id", "requestId") || id,
    timestamp: pickString(record, "timestamp", "timestamp"),
    latencyMs,
    ttftMs: Number.isFinite(ttftRaw) && ttftRaw > 0 ? ttftRaw : null,
    tokens: {
      inputTokens: pickNumber(rawTokens, "inputTokens", "input_tokens"),
      outputTokens: pickNumber(rawTokens, "outputTokens", "output_tokens"),
      reasoningTokens: pickNumber(rawTokens, "reasoningTokens", "reasoning_tokens"),
      cachedTokens: pickNumber(rawTokens, "cachedTokens", "cached_tokens"),
      cacheReadTokens: pickNumber(rawTokens, "cacheReadTokens", "cache_read_tokens"),
      cacheCreationTokens: pickNumber(rawTokens, "cacheCreationTokens", "cache_creation_tokens"),
      totalTokens: pickNumber(rawTokens, "totalTokens", "total_tokens"),
    },
    failed: record.failed === true,
    canceled: originalCanceled,
    failure_status,
    failure_body,
    failure_message: failure_body,
    reasoning_effort: pickString(record, "reasoning_effort", "reasoningEffort"),
    endpoint: pickString(record, "endpoint", "endpoint"),
    auth_index: pickString(record, "auth_index", "authIndex"),
  };
  row.canceled = deriveCanceled({ ...row, canceled: originalCanceled });
  // Never persist or forward the raw credential; keep only hash + mask.
  delete row.api_key;
  delete row.apiKey;
  delete row.response_headers;
  if (apiKey) {
    row.api_key_hash = API_KEY_HASH(apiKey);
    row.api_key_display = maskApiKey(apiKey);
  } else {
    row.api_key_hash = pickString(record, "api_key_hash", "apiKeyHash");
    row.api_key_display = pickString(record, "api_key_display", "apiKeyDisplay");
  }
  return row;
}

module.exports = { isControlNotification, isUsageRecord, normalizeRecord, maskApiKey, sha256Hex };
