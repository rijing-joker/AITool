const paths = require("./paths");

// Thin HTTP client for the CLIProxyAPI core Management API
// (http://127.0.0.1:<port>/v0/management/*, Bearer <management secret-key>).
// Uses undici (already a runtime dependency of the CLI).

async function request(method, route, { query, body, timeoutMs = 15_000 } = {}) {
  const config = require("./config");
  const port = config.getServerPort();
  const token = config.getManagementKey();
  if (!token) {
    return { ok: false, status: 0, error: "management-key-unavailable" };
  }
  const url = new URL(`http://127.0.0.1:${port}${route}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const { request: undiciRequest } = require("undici");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await undiciRequest(url, {
      method,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.body.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, data: parsed };
  } catch (error) {
    return { ok: false, status: 0, error: error?.code || error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function ping() {
  const result = await request("GET", "/v0/management/config", { timeoutMs: 3_000 });
  if (result.ok) return { reachable: true };
  if (result.status === 401 || result.status === 403) {
    return { reachable: true, authError: true };
  }
  return { reachable: false, error: result.error || `status ${result.status}` };
}

module.exports = { request, ping };
