const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const paths = require("./paths");
const config = require("./config");
const manager = require("./manager");
const bridge = require("./usage-bridge");
const management = require("./management");
const recordStore = require("./usage-records").createUsageRecordStore();
const pricing = require("./pricing");
const { upstreamIdentity, createUsageLabeler, usageFilterOptions } = require("./usage-labels");
const coreInstall = require("./core-install").getInstance;

// Dashboard-facing REST surface for the proxy layer. Mounted by local-api.js
// under /api/proxy/*. Read endpoints are open (consistent with the rest of the
// local API); mutations require the same local-mutation auth the other
// endpoints use, passed in by local-api as `ctx.isAuthorizedLocalMutation`.

function isJsonObjectString(text) {
  const parsed = JSON.parse(text);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
}

function json(res, data, status) {
  res.writeHead(status || 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function configResponse(res, result, data = {}) {
  if (result.etag) res.setHeader("ETag", result.etag);
  const status = result.ok ? 200 : result.status === 412 ? 412 : result.status >= 400 && result.status < 500 ? result.status : 502;
  json(res, result.ok ? { ok: true, ...data, etag: result.etag || null }
    : { ok: false, error: result.status === 412 ? "PROXY_CONFIG_CONFLICT" : result.error || result.data?.error || `HTTP ${result.status}` }, status);
}

function requireConfigRevision(res, value) {
  // Require an actual strong revision; '*' would deliberately bypass protection.
  if (typeof value === "string" && /^"[^"\r\n]+"$/.test(value)) return true;
  json(res, { ok: false, error: "PROXY_CONFIG_REVISION_REQUIRED" }, 428);
  return false;
}

function clientAccessKeys(cfg) {
  if (Array.isArray(cfg?.access?.["api-keys"])) return cfg.access["api-keys"];
  // Legacy configs used a top-level array; v8 uses that name for upstreams.
  return Array.isArray(cfg?.["api-keys"]) ? cfg["api-keys"] : [];
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

// Per-model speed eligibility mirrors cc-switch's usage_stats (c615c3e):
// exact speed needs first-token timing (≥ 100 output tokens and ≥ 100 ms of
// generation after the first token); rows without TTFT can only be estimated
// from total duration, and there the thresholds are higher (≥ 200 tokens,
// ≥ 1 s) because the first-token wait dominates short requests.
const SPEED_MIN_OUTPUT_TOKENS = 100;
const SPEED_MIN_GENERATION_MS = 100;
const SPEED_ESTIMATE_MIN_OUTPUT_TOKENS = 200;
const SPEED_ESTIMATE_MIN_DURATION_MS = 1000;

function speedEligible(row) {
  const output = Number(row?.tokens?.outputTokens) || 0;
  const latency = Number(row.latencyMs);
  const ttft = Number(row.ttftMs);
  return row.ttftMs != null && Number.isFinite(ttft) && Number.isFinite(latency)
    && output >= SPEED_MIN_OUTPUT_TOKENS
    && latency - ttft >= SPEED_MIN_GENERATION_MS;
}

function speedEstimateEligible(row) {
  const output = Number(row?.tokens?.outputTokens) || 0;
  const latency = Number(row.latencyMs);
  return row.ttftMs == null && Number.isFinite(latency)
    && output >= SPEED_ESTIMATE_MIN_OUTPUT_TOKENS
    && latency >= SPEED_ESTIMATE_MIN_DURATION_MS;
}

function modelEntryOf(byModel, row) {
  const model = String(row.response_model || row.model || "unknown");
  let entry = byModel.get(model);
  if (!entry) {
    entry = {
      model,
      requests: 0,
      success_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      speed_output_tokens: 0,
      speed_generation_ms: 0,
      est_speed_output_tokens: 0,
      est_speed_duration_ms: 0,
    };
    byModel.set(model, entry);
  }
  return entry;
}

function computeOverview(rows) {
  const now = Date.now();
  // Disjoint result buckets — canceled rows carry failed=true.
  const success = rows.filter((r) => !r.failed && !r.canceled);
  const failed = rows.filter((r) => r.failed && !r.canceled);
  const canceled = rows.filter((r) => r.canceled);
  const sumTokens = (list, key) => list.reduce((acc, r) => acc + (Number(r?.tokens?.[key]) || 0), 0);

  const byModel = new Map();
  const byProvider = new Map();
  // Model stats count every request toward requests/success_rate (cc-switch
  // rollup semantics — a model whose requests all fail still shows 0%),
  // while tokens, cache and speed ride the success bucket so the rows sum
  // to the headline totals above.
  for (const row of rows) {
    const modelEntry = modelEntryOf(byModel, row);
    modelEntry.requests += 1;
    if (row.canceled || row.failed) continue;
    modelEntry.success_count += 1;
    modelEntry.input_tokens += Number(row?.tokens?.inputTokens) || 0;
    modelEntry.output_tokens += Number(row?.tokens?.outputTokens) || 0;
    modelEntry.total_tokens += Number(row?.tokens?.totalTokens) || 0;
    modelEntry.cache_read_tokens += Number(row?.tokens?.cacheReadTokens) || 0;
    modelEntry.cache_creation_tokens += Number(row?.tokens?.cacheCreationTokens) || 0;
    if (speedEligible(row)) {
      modelEntry.speed_output_tokens += Number(row?.tokens?.outputTokens) || 0;
      modelEntry.speed_generation_ms += Number(row.latencyMs) - Number(row.ttftMs);
    } else if (speedEstimateEligible(row)) {
      modelEntry.est_speed_output_tokens += Number(row?.tokens?.outputTokens) || 0;
      modelEntry.est_speed_duration_ms += Number(row.latencyMs);
    }
  }
  for (const modelEntry of byModel.values()) {
    modelEntry.success_rate = modelEntry.requests
      ? Number(((modelEntry.success_count / modelEntry.requests) * 100).toFixed(2))
      : null;
  }
  for (const row of success) {
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
    if (row.canceled) continue;
    if (row.failed) point.failures += 1;
    else point.requests += 1;
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
    // easy 88d5852 semantics: canceled requests are not provider failures, so
    // they stay out of the denominator; no completed requests means no rate.
    success_rate: success.length + failed.length
      ? Number(((success.length / (success.length + failed.length)) * 100).toFixed(2))
      : null,
    input_tokens: sumTokens(success, "inputTokens"),
    output_tokens: sumTokens(success, "outputTokens"),
    reasoning_tokens: sumTokens(success, "reasoningTokens"),
    cache_read_tokens: sumTokens(success, "cacheReadTokens"),
    cache_creation_tokens: sumTokens(success, "cacheCreationTokens"),
    total_tokens: sumTokens(success, "totalTokens"),
    rpm: Number((recentWindow.length / 5).toFixed(2)),
    tpm: Number((sumTokens(recentWindow, "totalTokens") / 5).toFixed(2)),
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
const balance = require("./balance");
const budget = require("./budget");

const REMARK_SECTIONS = new Set([
  "gemini-api-key", "interactions-api-key", "vertex-api-key", "codex-api-key",
  "claude-api-key", "xai-api-key", "meta-api-key", "openai-compatibility",
]);

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
// Log directory opener (cc-switch's settings.advanced.logConfig.openLog)
// ---------------------------------------------------------------------------

// Resolved lazily per platform; the folder opens on the host running this
// Node process, so a remote dashboard browser gets the failure response
// rather than a silently useless spawn.
async function openPathInFileManager(command) {
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const opener = command
    || (process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "explorer"
      : "xdg-open");
  await new Promise((resolve, reject) => {
    const child = spawn(opener, [paths.logsDir], { detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

let logsDirOpener = openPathInFileManager;

function setLogsDirOpenerForTests(fn) {
  logsDirOpener = fn || openPathInFileManager;
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
    if (p === "/api/proxy/models/refresh" && method === "POST") {
      if (!requireMutation()) return true;
      const results = await Promise.all(["/v8/management/models/refresh", "/v8/management/routing/model-definitions/refresh"].map(async route => {
        const result = await management.request("POST", route, { timeoutMs: 60_000 });
        return { route, ok: result.ok, status: result.status, unsupported: [404, 405].includes(result.status), data: result.data, error: result.error };
      }));
      json(res, { ok: true, results }); return true;
    }
    if (p === "/api/proxy/routing" && method === "GET") { json(res, { ok: true, ...await require("./extensions/routing").status() }); return true; }
    if (p === "/api/proxy/routing" && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req), routing = require("./extensions/routing");
      if (body.action === "magpie-events") { json(res, { ok: true, events: await routing.magpieEvents() }); return true; }
      if (body.enabled) {
        if (!clientAccessKeys(config.readConfig() || {}).includes(body.apiKey)) throw new Error("Select a configured proxy key");
        const models = await require("./copilot").modelCatalog(body);
        if ([...(body.models || []), ...(body.intent ? [body.classifier] : [])].some(id => !models.some(row => row.id === id))) throw new Error("Select available models and classifier");
      }
      json(res, { ok: true, ...await routing.configure(body) }); return true;
    }
    if (p === "/api/proxy/tools" && method === "GET") { json(res, { ok: true, ...await require("./extensions/tools").status() }); return true; }
    if (p === "/api/proxy/tools" && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req), tools = require("./extensions/tools");
      if (body.action === "mount") json(res, { ok: true, ...await tools.mount(body.apps) });
      else {
        if (body.enabled && body.mode === "local") {
          if (!clientAccessKeys(config.readConfig() || {}).includes(body.apiKey)) throw new Error("Select a configured proxy client key");
          const models = await require("./copilot").modelCatalog(body);
          if (!models.some(row => row.id === body.model && row.inputModalities?.includes("image"))) throw new Error("Select a model with verified image capability");
        }
        json(res, { ok: true, ...await tools.configure(body) });
      }
      return true;
    }
    if (p === "/api/proxy/integrations" && method === "GET") {
      const magpie = require("./extensions/magpie"), buddy = require("./extensions/workbuddy");
      json(res, { ok: true, magpie: await magpie.status(), workbuddy: await buddy.status("workbuddy"), workbuddyAI: await buddy.status("workbuddy-ai") }); return true;
    }
    if (p === "/api/proxy/integrations" && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      if (!["magpie", "workbuddy", "workbuddy-ai"].includes(body.kind)) throw new Error("Unknown optional integration");
      const root = require("./managed-upstream").root({});
      const result = await require("../fs").withFileLock(require("node:path").join(root, "integration-mutation"), async () => {
        if (body.kind === "magpie") {
          const magpie = require("./extensions/magpie");
          if (body.action === "discover") return magpie.discover();
          if (body.action === "configure") return magpie.configure(body);
        } else {
          const buddy = require("./extensions/workbuddy");
          if (body.action === "desktop") return buddy.useDesktop(body.kind);
          if (body.action === "key") return buddy.useKey(body.kind, body.apiKey);
          if (body.action === "begin") return buddy.begin(body.kind);
          if (body.action === "poll") return buddy.poll(body.kind, body.id);
          if (body.action === "catalog") return { models: await buddy.catalog(body.kind) };
          if (body.action === "quota") return buddy.quota(body.kind);
          if (body.action === "configure") return buddy.configure(body.kind, body);
          if (body.action === "forget") return buddy.forget(body.kind);
        }
        throw new Error("Unknown optional integration action");
      });
      json(res, { ok: true, result }); return true;
    }
    if (p === "/api/proxy/opencode-free" && method === "GET") {
      json(res, { ok: true, ...await require("./opencode-free").status() });
      return true;
    }
    if (["/api/proxy/opencode-free", "/api/proxy/opencode-free/refresh"].includes(p) && method === "POST") {
      if (!requireMutation()) return true;
      const free = require("./opencode-free");
      if (p.endsWith("/refresh")) json(res, { ok: true, catalog: await free.refresh() });
      else json(res, { ok: true, ...await free.configure(await readJsonBody(req)) });
      return true;
    }
    if (p === "/api/proxy/copilot" && method === "GET") {
      json(res, { ok: true, clients: await require("./copilot").status() });
      return true;
    }
    if (p === "/api/proxy/desktop-clients" && method === "GET") {
      json(res, { ok: true, clients: await require("./desktop-clients").status() }); return true;
    }
    if (["/api/proxy/desktop-clients/connect", "/api/proxy/desktop-clients/restore", "/api/proxy/desktop-clients/models"].includes(p) && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req), clients = require("./desktop-clients");
      if (p.endsWith("/restore")) { json(res, { ok: true, ...await clients.restore(body.client) }); return true; }
      const cfg = config.readConfig() || {};
      if (!clientAccessKeys(cfg).includes(body.apiKey)) { json(res, { ok: false, error: "Select a configured proxy client key." }, 400); return true; }
      const models = await require("./copilot").modelCatalog(body);
      if (p.endsWith("/models")) json(res, { ok: true, models: models.map(row => row.id) });
      else json(res, { ok: true, ...await clients.connect(body.client, { ...body, models }) });
      return true;
    }
    if (["/api/proxy/copilot/connect", "/api/proxy/copilot/restore", "/api/proxy/copilot/models"].includes(p) && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const copilot = require("./copilot");
      if (p.endsWith("/models")) json(res, { ok: true, models: await copilot.models(body) });
      else if (p.endsWith("/restore")) json(res, { ok: true, ...await copilot.restore(body.client) });
      else {
        const cfg = config.readConfig() || {};
        const keys = clientAccessKeys(cfg);
        if (!keys.includes(body.apiKey)) { json(res, { ok: false, error: "Select a configured proxy client key." }, 400); return true; }
        const models = body.client === "vscode" ? await copilot.modelCatalog(body) : undefined;
        json(res, { ok: true, ...await copilot.connect(body.client, { ...body, models }) });
      }
      return true;
    }
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
    if (p === "/api/proxy/restart" && method === "POST") {
      if (!requireMutation()) return true;
      bridge.stopBridge();
      let result;
      try {
        result = await manager.restart();
      } finally {
        // A failed restart (install error, startup timeout, port dispute)
        // must not leave the usage bridge down with nothing polling the
        // core back up — same recovery contract as the install flow.
        bridge.startBridge();
      }
      json(res, { ok: true, result, bridge: bridge.bridgeStatus() });
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
    if (p === "/api/proxy/core-update" && method === "GET") {
      // Update check for the settings page (original: checks on page entry +
      // a manual button). Resolves GitCode → GitHub latest and compares with
      // the installed version; failures surface as ok:false, the page stays
      // quiet about them.
      try {
        const fetchCoreModule = require("../../../scripts/fetch-core.cjs");
        const update = await fetchCoreModule.checkUpdate({ signal: AbortSignal.timeout(15_000) });
        json(res, { ok: true, update });
      } catch (error) {
        json(res, { ok: false, error: error?.message || String(error) });
      }
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
    if (p === "/api/proxy/logs/open" && method === "POST") {
      if (!requireMutation()) return true;
      try {
        await logsDirOpener();
        json(res, { ok: true });
      } catch (error) {
        json(res, { ok: false, error: error?.message || "open failed" }, 500);
      }
      return true;
    }

    // --- config pass-through (management API) ---
    if (p === "/api/proxy/config" && (method === "PUT" || method === "PATCH")) {
      if (!requireMutation()) return true;
      if (!requireConfigRevision(res, req.headers["if-match"])) return true;
      const body = await readJsonBody(req);
      const result = await management.request(method, "/v8/management/config", { body, ifMatch: req.headers["if-match"] });
      configResponse(res, result);
      return true;
    }
    if (p === "/api/proxy/config") {
      const result = await management.request("GET", "/v8/management/config");
      configResponse(res, result, { config: result.data });
      return true;
    }
    if (p === "/api/proxy/config.yaml") {
      if (method === "PUT") {
        if (!requireMutation()) return true;
        const body = await readJsonBody(req);
        if (!requireConfigRevision(res, body.etag)) return true;
        const result = await management.request("PUT", "/v8/management/config.yaml", {
          body: String(body.yaml || ""), contentType: "application/yaml", ifMatch: body.etag,
        });
        configResponse(res, result);
        return true;
      }
      const result = await management.request("GET", "/v8/management/config.yaml");
      configResponse(res, result, { yaml: typeof result.data === "string" ? result.data : String(result.data || "") });
      return true;
    }

    if (p === "/api/proxy/privacy" && (method === "GET" || method === "PUT")) {
      if (method === "PUT") {
        if (!requireMutation()) return true;
        const body = await readJsonBody(req);
        if (typeof body.enabled !== "boolean") {
          json(res, { ok: false, error: "enabled must be boolean" }, 400);
          return true;
        }
        config.writeSettings({ ...config.readSettings(), privacyMode: body.enabled });
      }
      json(res, { ok: true, enabled: config.readSettings().privacyMode ?? null });
      return true;
    }

    // --- client access keys ---
    if (p === "/api/proxy/keys" && (method === "PUT" || method === "PATCH" || method === "DELETE")) {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      if (!requireConfigRevision(res, body.etag)) return true;
      const result = await management.request(method, "/v8/management/config/access/api-keys", { body: body.keys, ifMatch: body.etag });
      configResponse(res, result);
      return true;
    }
    if (p === "/api/proxy/keys") {
      // The core omits access.api-keys until the first key is created (and
      // may omit it again when empty). Read the document so an empty list
      // still carries the revision required to create the missing path.
      const result = await management.request("GET", "/v8/management/config");
      if (result.ok) {
        configResponse(res, result, { keys: clientAccessKeys(result.data) });
      } else {
        configResponse(res, result);
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
    if (p === "/api/proxy/auth-files/vertex-import" && method === "POST") {
      if (!requireMutation()) return true;
      // Vertex service-account import: the core normalizes and validates the
      // account and creates the auth record (EasyCLIProxyAPI c6af303 parity).
      // Same manual multipart translation as the auth-files upload above.
      const body = await readJsonBody(req);
      const name = String(body.name || "").trim();
      const content = String(body.content || "");
      const location = String(body.location || "").trim();
      if (!name || !name.toLowerCase().endsWith(".json") || !content) {
        json(res, { ok: false, error: "name (….json) and content required" }, 400);
        return true;
      }
      try {
        if (!isJsonObjectString(content)) throw new Error("not an object");
      } catch {
        json(res, { ok: false, error: "credential content must be a JSON object" }, 400);
        return true;
      }
      const boundary = `----aitool${crypto.randomBytes(8).toString("hex")}`;
      const partBuffers = [
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name.replace(/"/g, "")}"\r\nContent-Type: application/json\r\n\r\n`),
        Buffer.from(content),
      ];
      if (location) {
        partBuffers.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="location"\r\n\r\n${location}`));
      }
      partBuffers.push(Buffer.from(`\r\n--${boundary}--\r\n`));
      const formBody = Buffer.concat(partBuffers);
      const { request: undiciRequest } = require("undici");
      const token = config.getManagementKey();
      const port = config.getServerPort();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await undiciRequest(`http://127.0.0.1:${port}/v0/management/oauth/import?provider=vertex`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "content-length": String(formBody.length),
          },
          body: formBody,
        });
        const text = await response.body.text();
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        let result = null;
        try { result = JSON.parse(text); } catch { /* non-JSON error body */ }
        if (ok && result && (result.status === "ok" || result.project_id)) {
          json(res, {
            ok: true,
            result: {
              projectId: String(result.project_id ?? ""),
              email: String(result.email ?? ""),
              location: String(result.location ?? location),
              authFile: String(result["auth-file"] ?? result.auth_file ?? ""),
            },
          });
        } else {
          json(res, { ok: false, error: text || `HTTP ${response.statusCode}` }, 502);
        }
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
    if (p === "/api/proxy/pricing" && method === "GET") {
      // Read-only pricing sync state for the dashboard's cost column tooltip.
      // include=1 also returns the per-model metadata (context window,
      // reasoning efforts) keyed by normalized id for the codex catalog fill.
      const snapshot = await pricing.getPricingSnapshot(paths.pricingPath);
      const payload = { ok: true, modelCount: snapshot.modelCount, fetchedAt: snapshot.fetchedAt, stale: snapshot.stale, syncing: snapshot.syncing };
      if (url.searchParams.get("include") === "1" && snapshot.models) {
        payload.models = Object.fromEntries(Object.entries(snapshot.models).map(([id, entry]) => [
          id,
          { contextWindow: entry.contextWindow, maxOutputTokens: entry.maxOutputTokens, reasoningEfforts: entry.reasoningEfforts },
        ]));
      }
      json(res, payload);
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
      const keyHash = url.searchParams.get("api_key_hash") || "";
      const upstream = url.searchParams.get("upstream") || "";
      const inRange = (row) => {
        const ts = recordTimestamp(row);
        return !(Number.isFinite(since) && (!Number.isFinite(ts) || ts < since))
          && !(Number.isFinite(until) && (!Number.isFinite(ts) || ts > until));
      };
      const rangeRows = rows.filter(inRange);
      const filtered = rangeRows.filter((row) => {
        if (keyHash && row.api_key_hash !== keyHash) return false;
        if (upstream && upstreamIdentity(row) !== upstream) return false;
        if (model && !String(row.response_model || row.model || "").toLowerCase().includes(model)) return false;
        if (provider && !String(row.provider || "").toLowerCase().includes(provider)) return false;
        if (failed === "true" && !row.failed) return false;
        if (failed === "false" && row.failed) return false;
        // Disjoint result buckets matching the stats aggregation below:
        // success excludes canceled, canceled ⊆ failed∪canceled is never
        // double-counted as failed.
        if (result === "success" && (row.failed || row.canceled)) return false;
        if (result === "failed" && (!row.failed || row.canceled)) return false;
        if (result === "canceled" && !row.canceled) return false;
        const ts = recordTimestamp(row);
        if (Number.isFinite(since) && (!Number.isFinite(ts) || ts < since)) return false;
        if (Number.isFinite(until) && (!Number.isFinite(ts) || ts > until)) return false;
        return true;
      });
      const statsOnly = Boolean(url.searchParams.get("stats"));
      let stats;
      if (statsOnly || url.searchParams.get("includeStats") === "1") {
        // Disjoint result buckets: canceled rows carry failed=true (499 /
        // context canceled), so counting failed rows alone would swallow them.
        const success = filtered.filter((row) => !row.failed && !row.canceled);
        const failedRows = filtered.filter((row) => row.failed && !row.canceled);
        const canceled = filtered.filter((row) => row.canceled);
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
      // Cost estimation (models.dev pricing): add a total over all filtered
      // successful requests and annotate the returned page. Without a pricing
      // index (never synced, offline) stats and records pass through
      // untouched. This runs before the stats-only early return so both
      // response shapes carry the same stats object.
      const pricingSnapshot = await pricing.getPricingSnapshot(paths.pricingPath);
      const pricingModels = pricingSnapshot.models;
      if (stats && pricingModels) {
        let totalCostUsd = 0;
        // Same disjoint success bucket as the stats aggregation above (the
        // `success` list itself is scoped to that block).
        for (const row of filtered) {
          if (row.failed || row.canceled) continue;
          const cost = pricing.estimateCostUsd(pricingModels, String(row.response_model || row.model || ""), row.tokens, { executorType: row.executor_type });
          if (cost != null) totalCostUsd += cost;
        }
        stats.total_cost_usd = totalCostUsd;
      }
      if (statsOnly) {
        json(res, { ok: true, stats });
        return true;
      }
      // Refresh optional labels with every records request, including manual
      // refresh. Core outages never prevent reading the local history.
      let credentials = [];
      if (rangeRows.some((row) => row.auth_index)) {
        try {
          const result = await management.request("GET", "/v8/management/credentials", { timeoutMs: 3000 });
          if (result.ok && Array.isArray(result.data?.files)) credentials = result.data.files;
        } catch {}
      }
      let remarks = {};
      try { remarks = JSON.parse(fs.readFileSync(paths.apiKeyRemarksPath, "utf8")) || {}; } catch {}
      const label = createUsageLabeler({ keys: clientAccessKeys(config.readConfig()), remarks, providerRemarks: readRemarksStore().entries, credentials });
      const filterOptions = usageFilterOptions(rangeRows.map(label));
      const pageSize = Math.min(Math.max(Number(url.searchParams.get("pageSize")) || 50, 1), 500);
      const page = Math.max(Number(url.searchParams.get("page")) || 0, 0);
      const start = page * pageSize;
      const pageRecords = filtered.slice(start, start + pageSize).map((record) => {
        const costUsd = pricing.estimateCostUsd(pricingModels, String(record.response_model || record.model || ""), record.tokens, { executorType: record.executor_type });
        return label(costUsd == null ? record : { ...record, costUsd });
      });
      json(res, {
        ok: true,
        total: filtered.length,
        page,
        pageSize,
        records: pageRecords,
        filterOptions,
        ...(stats ? { stats } : {}),
      });
      return true;
    }
    if (p === "/api/proxy/usage/heatmap") {
      // Per-day totals for the 53-week usage heatmap (cc-switch cf2e6a7's
      // surviving "All" range). Days are server-local (same convention as
      // the TT base's aggregateByDay); cost follows the records route.
      const now = Date.now();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (start.getDay() + 6) % 7 - 52 * 7);
      const since = start.getTime();
      const rows = (await recordStore.readRecords(paths.usageDir, { since }))
        .filter((row) => recordTimestamp(row) >= since && recordTimestamp(row) <= now);
      const byDay = new Map();
      const dayKeyOf = (ts) => {
        const date = new Date(ts);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      };
      for (const row of rows) {
        const ts = recordTimestamp(row);
        if (!Number.isFinite(ts)) continue;
        const key = dayKeyOf(ts);
        let entry = byDay.get(key);
        if (!entry) {
          entry = { date: key, requests: 0, tokens: 0, costUsd: 0 };
          byDay.set(key, entry);
        }
        entry.requests += 1;
        entry.tokens += Number(row?.tokens?.totalTokens) || 0;
      }
      const pricingSnapshot = await pricing.getPricingSnapshot(paths.pricingPath);
      if (pricingSnapshot.models) {
        for (const row of rows) {
          if (row.failed || row.canceled) continue;
          const ts = recordTimestamp(row);
          if (!Number.isFinite(ts)) continue;
          const cost = pricing.estimateCostUsd(pricingSnapshot.models, String(row.response_model || row.model || ""), row.tokens, { executorType: row.executor_type });
          if (cost != null) byDay.get(dayKeyOf(ts)).costUsd += cost;
        }
      }
      json(res, { ok: true, days: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)) });
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
      const refresh = verb === "POST" && /^\/?credentials\/refresh$/.test(route);
      const pluginQuota = verb === "POST" && /^\/?plugins\/[^/]+\/quota$/.test(route);
      const timeoutMs = Math.min(refresh ? 300_000 : 120_000, Math.max(1_000, Number(body.timeoutMs) || 15_000));
      if (verb !== "GET" && /^\/?config(?:[/.]|$)/.test(route)
        && !requireConfigRevision(res, body.ifMatch)) return true;
      const options = {
        query: body.query && typeof body.query === "object" && !Array.isArray(body.query) ? body.query : undefined,
        body: body.body,
        timeoutMs,
        ifMatch: body.ifMatch,
      };
      let result = await management.request(verb, `/v8/management/${route.replace(/^\/+/, "")}`, options);
      // Older cores expose plugin operations only on the legacy namespace.
      // Never retry permission, account or upstream failures on another route.
      if (result.status === 404 && (pluginQuota || (verb === "GET" && /^\/?plugins$/.test(route)))) {
        result = await management.request(verb, `/v0/management/${route.replace(/^\/+/, "")}`, options);
      }
      if (!result.ok) {
        if (result.status === 412) configResponse(res, result);
        else json(res, { ok: false, error: refresh ? "Credential refresh failed" : pluginQuota ? "Plugin quota query failed" : formatManagementError(result.status, result.data) });
        return true;
      }
      // Refresh replies may contain access and refresh tokens. Expose only
      // acknowledgements and per-credential results to the browser.
      const value = refresh ? require("./credential-refresh").sanitize(result.data) : pluginQuota ? require("./credential-refresh").sanitizeQuota(result.data) : result.data === "" ? null : result.data;
      json(res, { ok: true, value, etag: result.etag || null });
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

    if (p === "/api/proxy/balance-check" && method === "POST") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      json(res, await balance.checkBalance({
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        timeoutMs: body.timeoutMs,
      }));
      return true;
    }

    // --- budgets (AiTool-side settings, monitored over proxy records) ---
    if (p === "/api/proxy/budget" && method === "PUT") {
      if (!requireMutation()) return true;
      const body = await readJsonBody(req);
      const settings = config.readSettings();
      settings.budgets = budget.normalizeBudgets(body.budgets || body);
      config.writeSettings(settings);
      json(res, { ok: true });
      return true;
    }
    if (p === "/api/proxy/budget") {
      const budgets = budget.normalizeBudgets(config.readSettings().budgets);
      const now = Date.now();
      const start = new Date(now);
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      const rows = await recordStore.readRecords(paths.usageDir, { since: start.getTime() });
      const pricingSnapshot = await pricing.getPricingSnapshot(paths.pricingPath);
      const pricingModels = pricingSnapshot.models;
      const costOf = pricingModels
        ? (row) => pricing.estimateCostUsd(pricingModels, String(row.response_model || row.model || ""), row.tokens, { executorType: row.executor_type })
        : () => null;
      json(res, {
        ok: true,
        budget: budget.computeBudgetStatus({ budgets, rows, costOf, now }),
        pricingAvailable: Boolean(pricingModels),
      });
      return true;
    }

    // --- structured config fields (EasyCLIProxyAPI ConfigPanel port) ---
    // Apply settings through the core's conditional config writer. The core
    // checks If-Match under its config lock; no direct file write races reload.
    if (p === "/api/proxy/config-fields") {
      const YAML = require("yaml");
      const readFields = (doc) => {
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
          "routing.session-affinity-rebind-on": get("routing.session-affinity-rebind-on"),
          "routing.cooldown.disable-cooling": get("routing.cooldown.disable-cooling"),
          "routing.retry.request-retry": get("routing.retry.request-retry"),
          "routing.retry.max-retry-credentials": get("routing.retry.max-retry-credentials"),
          "routing.retry.max-retry-interval": get("routing.retry.max-retry-interval"),
          "routing.retry.streaming-bootstrap-retries": get("routing.retry.streaming-bootstrap-retries"),
          "debug": get("debug"),
          "logging-to-file": get("logging-to-file"),
          "client.codex.enable-apply-patch": get("client.codex.enable-apply-patch"),
          "client.codex.optimize-multi-agent-v2": get("client.codex.optimize-multi-agent-v2"),
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
        if (!requireConfigRevision(res, body.etag)) return true;
        const snapshot = await management.request("GET", "/v8/management/config.yaml");
        if (!snapshot.ok) { configResponse(res, snapshot); return true; }
        if (snapshot.etag !== body.etag) { configResponse(res, { ok: false, status: 412, etag: snapshot.etag }); return true; }
        const doc = YAML.parse(snapshot.data) || {};
        const allowed = readFields(doc);
        for (const [dotted, value] of Object.entries(fields)) {
          if (!Object.hasOwn(allowed, dotted)) {
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
        const result = await management.request("PUT", "/v8/management/config.yaml", {
          body: YAML.stringify(doc), contentType: "application/yaml", ifMatch: body.etag,
        });
        configResponse(res, result, { fields: readFields(doc) });
        return true;
      }
      const result = await management.request("GET", "/v8/management/config.yaml");
      configResponse(res, result, { fields: result.ok ? readFields(YAML.parse(result.data) || {}) : {} });
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
        json(res, { ok: false, error: error?.message || String(error) }, error?.statusCode || 400);
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
    json(res, { ok: false, error: error?.message || String(error) }, error?.status >= 400 && error?.status < 600 ? error.status : 500);
    return true;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

module.exports = { handleProxyApiRequest, openPathInFileManager, setLogsDirOpenerForTests };
