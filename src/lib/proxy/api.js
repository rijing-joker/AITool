const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const paths = require("./paths");
const config = require("./config");
const manager = require("./manager");
const bridge = require("./usage-bridge");
const management = require("./management");
const recordStore = require("./usage-records").createUsageRecordStore();
const coreInstall = require("./core-install").getInstance;

// Dashboard-facing REST surface for the proxy layer. Mounted by local-api.js
// under /api/proxy/*. Read endpoints are open (consistent with the rest of the
// local API); mutations require the same local-mutation auth the other
// endpoints use, passed in by local-api as `ctx.isAuthorizedLocalMutation`.

function json(res, data, status) {
  res.writeHead(status || 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readJsonBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Usage records store (raw per-request events from the bridge)
// ---------------------------------------------------------------------------

const recordTimestamps = new WeakMap();
function recordTimestamp(record) {
  if (!recordTimestamps.has(record)) recordTimestamps.set(record, Date.parse(record.timestamp || ""));
  return recordTimestamps.get(record);
}

function computeOverview(rows) {
  const now = Date.now();
  const success = rows.filter((r) => !r.failed && !r.canceled);
  const failed = rows.filter((r) => r.failed);
  const canceled = rows.filter((r) => r.canceled && !r.failed);
  const sumTokens = (list, key) => list.reduce((acc, r) => acc + (Number(r?.tokens?.[key]) || 0), 0);

  const byModel = new Map();
  const byProvider = new Map();
  for (const row of success) {
    const model = String(row.response_model || row.model || "unknown");
    const modelEntry = byModel.get(model) || { model, requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    modelEntry.requests += 1;
    modelEntry.input_tokens += Number(row?.tokens?.inputTokens) || 0;
    modelEntry.output_tokens += Number(row?.tokens?.outputTokens) || 0;
    modelEntry.total_tokens += Number(row?.tokens?.totalTokens) || 0;
    byModel.set(model, modelEntry);

    const provider = String(row.provider || "unknown");
    const providerEntry = byProvider.get(provider) || { provider, requests: 0, total_tokens: 0, failures: 0 };
    providerEntry.requests += 1;
    providerEntry.total_tokens += Number(row?.tokens?.totalTokens) || 0;
    byProvider.set(provider, providerEntry);
  }
  for (const row of failed) {
    const provider = String(row.provider || "unknown");
    const providerEntry = byProvider.get(provider) || { provider, requests: 0, total_tokens: 0, failures: 0 };
    providerEntry.failures += 1;
    byProvider.set(provider, providerEntry);
  }

  // Timeline: half-hour buckets over the trailing 24h (matches the queue
  // bucketing used for dashboard trends).
  const timeline = [];
  for (let i = 47; i >= 0; i -= 1) {
    const hourStart = bridge.toUtcHalfHourStart(new Date(now - i * 30 * 60 * 1000));
    timeline.push({ hour_start: hourStart, requests: 0, failures: 0, total_tokens: 0 });
  }
  const timelineIndex = new Map(timeline.map((point) => [Date.parse(point.hour_start), point]));
  for (const row of rows) {
    const point = timelineIndex.get(Math.floor(recordTimestamp(row) / 1_800_000) * 1_800_000);
    if (!point) continue;
    if (row.failed) point.failures += 1;
    else if (!row.canceled) point.requests += 1;
    point.total_tokens += Number(row?.tokens?.totalTokens) || 0;
  }

  const recentWindow = rows.filter((r) => {
    const ts = recordTimestamp(r);
    return Number.isFinite(ts) && now - ts <= 5 * 60 * 1000;
  });
  const latencies = success.map((r) => Number(r.latencyMs) || 0).filter((v) => v > 0);

  return {
    total_requests: rows.length,
    success_count: success.length,
    failure_count: failed.length,
    canceled_count: canceled.length,
    success_rate: rows.length ? Number(((success.length / rows.length) * 100).toFixed(2)) : null,
    input_tokens: sumTokens(success, "inputTokens"),
    output_tokens: sumTokens(success, "outputTokens"),
    reasoning_tokens: sumTokens(success, "reasoningTokens"),
    cache_read_tokens: sumTokens(success, "cacheReadTokens"),
    cache_creation_tokens: sumTokens(success, "cacheCreationTokens"),
    total_tokens: sumTokens(success, "totalTokens"),
    rpm: Number((recentWindow.length / 5).toFixed(2)),
    tpm: sumTokens(recentWindow, "totalTokens"),
    average_latency_ms: latencies.length
      ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1))
      : null,
    models: Array.from(byModel.values()).sort((a, b) => b.total_tokens - a.total_tokens),
    providers: Array.from(byProvider.values()).sort((a, b) => b.requests - a.requests),
    timeline,
  };
}

// ---------------------------------------------------------------------------
// EasyCLIProxyAPI API-接入 helpers (management pass-through, remarks, probes)
// ---------------------------------------------------------------------------

const providerHealth = require("./provider-health");

const REMARK_SECTIONS = new Set(["gemini-api-key", "codex-api-key", "claude-api-key", "openai-compatibility"]);

function truncateForError(text) {
  const trimmed = String(text ?? "").trim();
  const chars = Array.from(trimmed);
  return chars.length <= 240 ? trimmed : `${chars.slice(0, 240).join("")}…`;
}

// Mirrors the Rust format_management_error so the ported page sees the exact
// same error strings it was built around.
function formatManagementError(status, data) {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const field = (key) => (typeof data[key] === "string" ? data[key].trim() : "");
    const error = field("error");
    const message = field("message");
    const detail = error && message && error !== message
      ? `${error}: ${message}`
      : error || message;
    if (detail) return `Management API error (${status}): ${truncateForError(detail)}`;
  }
  if (typeof data === "string" && data.trim()) {
    return `Management API error (${status}): ${truncateForError(data)}`;
  }
  return `Management API error (${status})`;
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function lengthPrefixed(parts, text) {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  parts.push(length, bytes);
}

// Same record identity as EasyCLIProxyAPI's Rust side: sha256 over
// length-prefixed section/name/base-url plus sorted api-key hashes.
function remarkRecordIdentity(section, locator) {
  const keyHashes = [...new Set(
    (Array.isArray(locator?.apiKeys) ? locator.apiKeys : [])
      .map((key) => String(key ?? "").trim())
      .filter(Boolean)
      .map((key) => sha256Hex(key)),
  )].sort();
  if (keyHashes.length === 0) return null;
  const parts = [];
  for (const component of [
    String(section ?? "").trim(),
    String(locator?.providerName ?? "").trim(),
    String(locator?.baseUrl ?? "").trim(),
  ]) {
    lengthPrefixed(parts, component);
  }
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(keyHashes.length));
  parts.push(count);
  for (const keyHash of keyHashes) lengthPrefixed(parts, keyHash);
  const configIdentity = String(locator?.configIdentity ?? "");
  if (configIdentity) lengthPrefixed(parts, configIdentity);
  return { recordHash: sha256Hex(Buffer.concat(parts)), keyHashes };
}

function readRemarksStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.remarksPath, "utf8"));
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch {}
  return { entries: [] };
}

function writeRemarksStore(store) {
  fs.mkdirSync(path.dirname(paths.remarksPath), { recursive: true });
  fs.writeFileSync(paths.remarksPath, `${JSON.stringify(store, null, 2)}\n`);
}

function resolveProviderRemark(store, query) {
  const section = String(query?.providerSection ?? "");
  const identity = remarkRecordIdentity(section, query);
  if (!identity) return "";
  let remark = "";
  for (const entry of store.entries) {
    if (entry.section !== section || entry.recordHash !== identity.recordHash) continue;
    if (!identity.keyHashes.includes(entry.keyHash)) continue;
    remark = entry.remark;
    if (remark) break;
  }
  return remark;
}

function applyProviderRemarkUpdate(update) {
  const section = String(update?.providerSection ?? "");
  if (!REMARK_SECTIONS.has(section)) {
    throw new Error("Invalid API access type");
  }
  const remark = String(update?.remark ?? "").trim();
  if (Array.from(remark).length > 80) {
    throw new Error("Key note cannot exceed 80 characters");
  }
  if (/[\u0000-\u001f\u007f]/.test(remark)) {
    throw new Error("Key note cannot contain line breaks or control characters");
  }
  const toIdentities = (records) => (Array.isArray(records) ? records : [])
    .map((locator) => remarkRecordIdentity(section, locator))
    .filter(Boolean);
  const previous = toIdentities(update?.previousRecords);
  const next = toIdentities(update?.records);
  const all = toIdentities(update?.allRecords);
  const replaceSet = new Set([...previous, ...next].map((identity) => identity.recordHash));
  const allHashes = new Set(all.map((identity) => identity.recordHash));
  const store = readRemarksStore();
  store.entries = store.entries.filter((entry) => entry.section !== section
    || (entry.recordHash && allHashes.has(entry.recordHash) && !replaceSet.has(entry.recordHash)));
  const inserted = new Set(
    store.entries.filter((entry) => entry.section === section && entry.recordHash).map((entry) => entry.recordHash),
  );
  for (const identity of next) {
    if (inserted.has(identity.recordHash)) continue;
    inserted.add(identity.recordHash);
    for (const keyHash of identity.keyHashes) {
      store.entries.push({ section, recordHash: identity.recordHash, keyHash, remark });
    }
  }
  writeRemarksStore(store);
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

async function handleProxyApiRequest(req, res, url, ctx) {
  const p = url.pathname;
  if (!p.startsWith("/api/proxy/") && p !== "/api/proxy") return false;
  const method = String(req.method || "GET").toUpperCase();
  const requireMutation = () => {
    if (!ctx?.isAuthorizedLocalMutation?.(req)) {
      json(res, { ok: false, error: "Unauthorized" }, 401);
      return false;
    }
    return true;
  };

  try {
    // --- lifecycle ---
    if (p === "/api/proxy/status") {
      const coreStatus = await manager.status();
      json(res, { ok: true, core: coreStatus, bridge: bridge.bridgeStatus() });
      return true;
    }
    if (p === "/api/proxy/start" && method === "POST") {
      if (!requireMutation()) return true;
      const result = await manager.start();
      bridge.startBridge();
      json(res, { ok: true, result, bridge: bridge.bridgeStatus() });
      return true;
    }
    if (p === "/api/proxy/stop" && method === "POST") {
      if (!requireMutation()) return true;
      bridge.stopBridge();
      const result = await manager.stop();
      json(res, { ok: true, result });
      return true;
    }
    if (p === "/api/proxy/install" && method === "POST") {
      if (!requireMutation()) return true;
      // Starts the background install task (EasyCLIProxyAPI's stop-and-update
      // flow); progress is polled at GET /api/proxy/install.
      try {
        const task = coreInstall().startInstall();
        json(res, { ok: true, task });
      } catch (error) {
        json(res, { ok: false, error: error?.message || "install failed" }, error?.statusCode || 500);
      }
      return true;
    }
    if (p === "/api/proxy/install" && method === "GET") {
      json(res, { ok: true, task: coreInstall().snapshot() });
      return true;
    }
    if (p === "/api/proxy/install/cancel" && method === "POST") {
      if (!requireMutation()) return true;
      json(res, { ok: true, task: coreInstall().cancelInstall() });
      return true;
    }
    if (p === "/api/proxy/settings" && (method === "PUT" || method === "POST")) {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const settings = config.readSettings();
      if (typeof body.autoStart === "boolean") settings.autoStart = body.autoStart;
      config.writeSettings(settings);
      json(res, { ok: true, settings });
      return true;
    }

    // --- config pass-through (management API) ---
    if (p === "/api/proxy/config" && (method === "PUT" || method === "PATCH")) {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await management.request("PUT", "/v0/management/config", { body });
      json(res, result.ok ? { ok: true } : { ok: false, error: result.error || result.status }, result.ok ? 200 : 502);
      return true;
    }
    if (p === "/api/proxy/config") {
      const result = await management.request("GET", "/v0/management/config");
      json(res, result.ok ? { ok: true, config: result.data } : { ok: false, error: result.error || result.status }, result.ok ? 200 : 502);
      return true;
    }
    if (p === "/api/proxy/config.yaml") {
      if (method === "PUT") {
        if (!requireMutation()) return true;
        const body = await readJsonBody(req);
        const result = await management.request("PUT", "/v0/management/config.yaml", { body: { yaml: String(body.yaml || "") } });
        json(res, result.ok ? { ok: true } : { ok: false, error: result.error || result.status }, result.ok ? 200 : 502);
        return true;
      }
      const result = await management.request("GET", "/v0/management/config.yaml");
      json(res, result.ok ? { ok: true, yaml: typeof result.data === "string" ? result.data : String(result.data || "") } : { ok: false, error: result.error || result.status }, result.ok ? 200 : 502);
      return true;
    }

    // --- client access keys ---
    if (p === "/api/proxy/keys" && (method === "PUT" || method === "PATCH" || method === "DELETE")) {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const result = await management.request(method, "/v0/management/api-keys", { body });
      json(res, result.ok ? { ok: true } : { ok: false, error: result.error || result.status }, result.ok ? 200 : 502);
      return true;
    }
    if (p === "/api/proxy/keys") {
      const result = await management.request("GET", "/v0/management/api-keys");
      if (result.ok) {
        const data = result.data;
        const list = Array.isArray(data) ? data : data?.["api-keys"] || data?.items || [];
        json(res, { ok: true, keys: list });
      } else {
        json(res, { ok: false, error: result.error || result.status }, 502);
      }
      return true;
    }

    // --- provider auth files ---
    if (p === "/api/proxy/auth-files" && method === "GET") {
      const listResult = await management.request("GET", "/v0/management/auth-files", { query: { page: 1, page_size: 100 } });
      if (!listResult.ok) {
        json(res, { ok: false, error: listResult.error || listResult.status }, 502);
        return true;
      }
      const statusResult = await management.request("GET", "/v0/management/auth-files/status");
      const files = Array.isArray(listResult.data) ? listResult.data : listResult.data?.files || [];
      const statuses = statusResult.ok ? statusResult.data : null;
      json(res, { ok: true, files, statuses });
      return true;
    }
    if (p === "/api/proxy/auth-files" && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const name = String(body.name || "").trim();
      const content = String(body.content || "");
      if (!name || !name.endsWith(".json") || !content) {
        json(res, { ok: false, error: "name (…​.json) and content required" }, 400);
        return true;
      }
      // The core's upload endpoint is multipart/form-data. Build the body
      // manually — undici's request() does not reliably serialize FormData,
      // and a raw buffer keeps the forward deterministic.
      const boundary = `----aitool${crypto.randomBytes(8).toString("hex")}`;
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name.replace(/"/g, "")}"\r\nContent-Type: application/json\r\n\r\n`,
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const formBody = Buffer.concat([head, Buffer.from(content), tail]);
      const { request: undiciRequest } = require("undici");
      const token = config.getManagementKey();
      const port = config.getServerPort();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await undiciRequest(`http://127.0.0.1:${port}/v0/management/auth-files`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "content-length": String(formBody.length),
          },
          body: formBody,
        });
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        const text = await response.body.text();
        json(res, ok ? { ok: true } : { ok: false, error: text || `HTTP ${response.statusCode}` }, ok ? 200 : 502);
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) }, 502);
      } finally {
        clearTimeout(timer);
      }
      return true;
    }
    if (p === "/api/proxy/auth-files" && method === "DELETE") {
      if (!requireMutation()) return true;
      const name = url.searchParams.get("name");
      if (!name) {
        json(res, { ok: false, error: "name query parameter required" }, 400);
        return true;
      }
      const result = await management.request("DELETE", "/v0/management/auth-files", { query: { name } });
      json(res, result.ok ? { ok: true } : { ok: false, error: result.error || result.status }, result.ok ? 200 : 502);
      return true;
    }
    if (p === "/api/proxy/auth-files/refresh" && method === "POST") {
      if (!requireMutation()) return true;
      const result = await management.request("POST", "/v0/management/auth-files/refresh", { body: {} });
      json(res, result.ok ? { ok: true } : { ok: false, error: result.error || result.status }, result.ok ? 200 : 502);
      return true;
    }

    // --- usage records / overview ---
    if (p === "/api/proxy/usage/overview") {
      json(res, { ok: true, overview: computeOverview(await recordStore.readRecords(paths.usageDir)), bridge: bridge.bridgeStatus() });
      return true;
    }
    if (p === "/api/proxy/usage/records") {
      const rows = await recordStore.readRecords(paths.usageDir);
      const model = (url.searchParams.get("model") || "").trim().toLowerCase();
      const provider = (url.searchParams.get("provider") || "").trim().toLowerCase();
      const failed = url.searchParams.get("failed");
      const result = url.searchParams.get("result") || "all";
      const since = Date.parse(url.searchParams.get("since") || "");
      const until = Date.parse(url.searchParams.get("until") || "");
      const filtered = rows.filter((row) => {
        if (model && !String(row.response_model || row.model || "").toLowerCase().includes(model)) return false;
        if (provider && !String(row.provider || "").toLowerCase().includes(provider)) return false;
        if (failed === "true" && !row.failed) return false;
        if (failed === "false" && row.failed) return false;
        if (result === "success" && (row.failed || row.canceled)) return false;
        if (result === "failed" && !row.failed) return false;
        if (result === "canceled" && (!row.canceled || row.failed)) return false;
        const ts = recordTimestamp(row);
        if (Number.isFinite(since) && (!Number.isFinite(ts) || ts < since)) return false;
        if (Number.isFinite(until) && (!Number.isFinite(ts) || ts > until)) return false;
        return true;
      });
      const statsOnly = Boolean(url.searchParams.get("stats"));
      let stats;
      if (statsOnly || url.searchParams.get("includeStats") === "1") {
        const success = filtered.filter((row) => !row.failed && !row.canceled);
        const failedRows = filtered.filter((row) => row.failed);
        const canceled = filtered.filter((row) => row.canceled && !row.failed);
        const totalTokens = success.reduce((acc, row) => acc + (Number(row?.tokens?.totalTokens) || 0), 0);
        const byModel = new Map();
        const byProvider = new Map();
        for (const row of success) {
          const name = String(row.response_model || row.model || "unknown");
          const entry = byModel.get(name) || { model: name, requests: 0, total_tokens: 0 };
          entry.requests += 1;
          entry.total_tokens += Number(row?.tokens?.totalTokens) || 0;
          byModel.set(name, entry);

          const provider = String(row.provider || "unknown");
          const providerEntry = byProvider.get(provider) || { provider, requests: 0, total_tokens: 0, failures: 0 };
          providerEntry.requests += 1;
          providerEntry.total_tokens += Number(row?.tokens?.totalTokens) || 0;
          byProvider.set(provider, providerEntry);
        }
        for (const row of failedRows) {
          const provider = String(row.provider || "unknown");
          const providerEntry = byProvider.get(provider) || { provider, requests: 0, total_tokens: 0, failures: 0 };
          providerEntry.failures += 1;
          byProvider.set(provider, providerEntry);
        }
        stats = {
          total_requests: filtered.length,
          success_count: success.length,
          failure_count: failedRows.length,
          canceled_count: canceled.length,
          total_tokens: totalTokens,
          models: Array.from(byModel.values()).sort((a, b) => b.total_tokens - a.total_tokens).slice(0, 8),
          providers: Array.from(byProvider.values()).sort((a, b) => b.requests - a.requests),
        };
      }
      if (statsOnly) {
        json(res, { ok: true, stats });
        return true;
      }
      const pageSize = Math.min(Math.max(Number(url.searchParams.get("pageSize")) || 50, 1), 500);
      const page = Math.max(Number(url.searchParams.get("page")) || 0, 0);
      const start = page * pageSize;
      json(res, {
        ok: true,
        total: filtered.length,
        page,
        pageSize,
        records: filtered.slice(start, start + pageSize),
        ...(stats ? { stats } : {}),
      });
      return true;
    }

    // --- management pass-through + provider remarks + health probes ---
    // The dashboard's port of EasyCLIProxyAPI's managementApi needs the core's
    // exact semantics: v8-style paths, JSON-or-string responses and the same
    // error strings ("Management API error (404): not_found", …) so its
    // fallback logic (e.g. absent v8 config nodes → 404) keeps working.
    if (p === "/api/proxy/management-request" && method === "POST") {
      if (!requireMutation()) return true;
      const raw = await readJsonBody(req);
      const body = raw && typeof raw === "object" && raw.request && typeof raw.request === "object"
        ? raw.request
        : raw;
      const verb = String(body.method || "").trim().toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(verb)) {
        json(res, { ok: false, error: "Unsupported management API request method" });
        return true;
      }
      const route = String(body.path || "").trim();
      if (!route || route.includes("://") || route.includes("..")) {
        json(res, { ok: false, error: "Invalid management API path" });
        return true;
      }
      const timeoutMs = Math.min(120_000, Math.max(1_000, Number(body.timeoutMs) || 15_000));
      const result = await management.request(verb, `/v8/management/${route.replace(/^\/+/, "")}`, {
        query: body.query && typeof body.query === "object" && !Array.isArray(body.query) ? body.query : undefined,
        body: body.body,
        timeoutMs,
      });
      if (!result.ok) {
        json(res, { ok: false, error: formatManagementError(result.status, result.data) });
        return true;
      }
      json(res, { ok: true, value: result.data === "" ? null : result.data });
      return true;
    }

    if (p === "/api/proxy/provider-remarks/resolve" && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const store = readRemarksStore();
      const queries = Array.isArray(body.queries) ? body.queries : [];
      const remarks = queries.map((query) => resolveProviderRemark(store, query));
      json(res, { ok: true, remarks });
      return true;
    }

    if (p === "/api/proxy/provider-remarks" && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        applyProviderRemarkUpdate(body.update || {});
        json(res, { ok: true });
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }

    if (p === "/api/proxy/provider-health-probe" && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      try {
        json(res, { ok: true, result: await providerHealth.probe(body.request || body) });
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }

    // --- structured config fields (EasyCLIProxyAPI ConfigPanel port) ---
    // The Rust GUI patches config.yaml on disk and lets the core's watcher
    // reload; this route does the same with dotted-path field merges. Fields
    // not in the map are untouched; null removes a key.
    if (p === "/api/proxy/config-fields") {
      const YAML = require("yaml");
      const readFields = () => {
        let doc = {};
        try { doc = YAML.parse(fs.readFileSync(paths.configPath, "utf8")) || {}; } catch {}
        const get = (dotted) => {
          let node = doc;
          for (const part of dotted.split(".")) {
            if (node === null || typeof node !== "object") return undefined;
            node = node[part];
          }
          return node;
        };
        return {
          "server.port": get("server.port"),
          "server.host": get("server.host"),
          "proxy-url": get("proxy-url"),
          "routing.strategy": get("routing.strategy"),
          "routing.session-affinity": get("routing.session-affinity"),
          "routing.session-affinity-ttl": get("routing.session-affinity-ttl"),
          "routing.cooldown.disable-cooling": get("routing.cooldown.disable-cooling"),
          "routing.retry.request-retry": get("routing.retry.request-retry"),
          "routing.retry.max-retry-credentials": get("routing.retry.max-retry-credentials"),
          "routing.retry.max-retry-interval": get("routing.retry.max-retry-interval"),
          "routing.retry.streaming-bootstrap-retries": get("routing.retry.streaming-bootstrap-retries"),
          "debug": get("debug"),
          "logging-to-file": get("logging-to-file"),
          "observability.usage.usage-statistics-enabled": get("observability.usage.usage-statistics-enabled"),
          "observability.usage.redis-usage-queue-retention-seconds": get("observability.usage.redis-usage-queue-retention-seconds"),
        };
      };
      if (method === "PUT" || method === "PATCH") {
        if (!requireMutation()) return true;
        const body = await readJsonBody(req);
        const fields = body && typeof body.fields === "object" && body.fields ? body.fields : null;
        if (!fields) {
          json(res, { ok: false, error: "fields object required" }, 400);
          return true;
        }
        let doc = {};
        try { doc = YAML.parse(fs.readFileSync(paths.configPath, "utf8")) || {}; } catch {}
        for (const [dotted, value] of Object.entries(fields)) {
          if (!/^[a-z0-9.-]+$/i.test(dotted)) {
            json(res, { ok: false, error: `Invalid config field: ${dotted}` }, 400);
            return true;
          }
          const parts = dotted.split(".");
          let node = doc;
          for (let i = 0; i < parts.length - 1; i += 1) {
            if (node[parts[i]] === null || typeof node[parts[i]] !== "object") node[parts[i]] = {};
            node = node[parts[i]];
          }
          if (value === null) delete node[parts[parts.length - 1]];
          else node[parts[parts.length - 1]] = value;
        }
        fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
        fs.writeFileSync(paths.configPath, YAML.stringify(doc));
        // Keep the bootstrap copy consistent with what ensureConfig expects.
        json(res, { ok: true, fields: readFields() });
        return true;
      }
      json(res, { ok: true, fields: readFields() });
      return true;
    }

    // --- kernel model aliases (EasyCLIProxyAPI ThinkingAliasesPage engine) ---
    // Dispatches to alias-config.js, which reads the legacy config view from
    // the core and writes section-level changes back through the management API.
    if (p === "/api/proxy/alias-config" && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const aliasConfig = require("./alias-config");
      try {
        switch (String(body.action || "")) {
          case "load":
            json(res, { ok: true, state: await aliasConfig.loadState() });
            break;
          case "edit-source":
            json(res, { ok: true, context: await aliasConfig.getEditContext(body) });
            break;
          case "create":
            json(res, { ok: true, state: body.speedOnly
              ? await aliasConfig.createSpeedAlias(body)
              : await aliasConfig.createAlias(body) });
            break;
          case "delete":
            json(res, { ok: true, state: await aliasConfig.deleteAlias(body) });
            break;
          default:
            json(res, { ok: false, error: "Unknown alias-config action" }, 400);
        }
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }

    if (p === "/api/proxy/auth-files/open-directory" && method === "POST") {
      if (!requireMutation()) return true;
      const { spawn } = require("node:child_process");
      fs.mkdirSync(paths.authDir, { recursive: true });
      const command = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "explorer" : "xdg-open";
      const child = spawn(command, [paths.authDir], { detached: true, stdio: "ignore" });
      child.unref();
      json(res, { ok: true, directory: paths.authDir });
      return true;
    }

    // --- client api-key remarks (GUI-side notes, like EasyCLIProxyAPI's
    // GuiApiKeyEntry remarks which live outside the kernel config) ---
    if (p === "/api/proxy/api-key-remarks" && (method === "PUT" || method === "POST")) {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const remarks = isPlainObject(body.remarks) ? body.remarks : null;
      if (!remarks) {
        json(res, { ok: false, error: "remarks object required" }, 400);
        return true;
      }
      for (const [key, remark] of Object.entries(remarks)) {
        if (Array.from(String(remark)).length > 80) {
          json(res, { ok: false, error: "Key note cannot exceed 80 characters" }, 400);
          return true;
        }
        if (/[\u0000-\u001f\u007f]/.test(String(remark))) {
          json(res, { ok: false, error: "Key note cannot contain line breaks or control characters" }, 400);
          return true;
        }
        void key;
      }
      const store = {};
      for (const [key, remark] of Object.entries(remarks)) {
        const trimmedKey = String(key).trim();
        const trimmedRemark = String(remark).trim();
        if (trimmedKey && trimmedRemark) store[trimmedKey] = trimmedRemark;
      }
      fs.mkdirSync(path.dirname(paths.apiKeyRemarksPath), { recursive: true });
      fs.writeFileSync(paths.apiKeyRemarksPath, `${JSON.stringify(store, null, 2)}\n`);
      json(res, { ok: true, remarks: store });
      return true;
    }
    if (p === "/api/proxy/api-key-remarks") {
      let store = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(paths.apiKeyRemarksPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) store = parsed;
      } catch {}
      json(res, { ok: true, remarks: store });
      return true;
    }

    json(res, { ok: false, error: "Not found" }, 404);
    return true;
  } catch (error) {
    json(res, { ok: false, error: error?.message || String(error) }, 500);
    return true;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

module.exports = { handleProxyApiRequest };
