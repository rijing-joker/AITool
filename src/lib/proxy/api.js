const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const paths = require("./paths");
const config = require("./config");
const manager = require("./manager");
const bridge = require("./usage-bridge");
const management = require("./management");

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

function listRecordFiles() {
  try {
    return fs
      .readdirSync(paths.usageDir)
      .filter((name) => /^records-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function readRecords({ maxFiles = 14 } = {}) {
  const rows = [];
  for (const name of listRecordFiles().slice(0, maxFiles)) {
    try {
      const raw = fs.readFileSync(path.join(paths.usageDir, name), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {}
      }
    } catch {}
  }
  rows.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
  return rows;
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
  const timelineIndex = new Map(timeline.map((point) => [point.hour_start, point]));
  for (const row of rows) {
    const point = timelineIndex.get(bridge.toUtcHalfHourStart(row.timestamp));
    if (!point) continue;
    if (row.failed) point.failures += 1;
    else if (!row.canceled) point.requests += 1;
    point.total_tokens += Number(row?.tokens?.totalTokens) || 0;
  }

  const recentWindow = rows.filter((r) => {
    const ts = Date.parse(r.timestamp || "");
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
      const result = await manager.installCore();
      json(res, { ok: true, result });
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
      json(res, { ok: true, overview: computeOverview(readRecords()), bridge: bridge.bridgeStatus() });
      return true;
    }
    if (p === "/api/proxy/usage/records") {
      const rows = readRecords();
      const model = url.searchParams.get("model");
      const provider = url.searchParams.get("provider");
      const failed = url.searchParams.get("failed");
      const filtered = rows.filter((row) => {
        if (model && String(row.response_model || row.model || "") !== model) return false;
        if (provider && String(row.provider || "") !== provider) return false;
        if (failed === "true" && !row.failed) return false;
        if (failed === "false" && row.failed) return false;
        return true;
      });
      const pageSize = Math.min(Math.max(Number(url.searchParams.get("pageSize")) || 50, 1), 500);
      const page = Math.max(Number(url.searchParams.get("page")) || 0, 0);
      const start = page * pageSize;
      json(res, {
        ok: true,
        total: filtered.length,
        page,
        pageSize,
        records: filtered.slice(start, start + pageSize),
      });
      return true;
    }

    json(res, { ok: false, error: "Not found" }, 404);
    return true;
  } catch (error) {
    json(res, { ok: false, error: error?.message || String(error) }, 500);
    return true;
  }
}

module.exports = { handleProxyApiRequest };
