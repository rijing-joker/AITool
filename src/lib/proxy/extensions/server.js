"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const state = require("../managed-upstream");
const options = { root: process.env.AITOOL_EXTENSIONS_DIR };
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
function createServer(configOptions = options) {
  const active = new Set();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) json(res, { error: { code: "extension_failed" } }, 502); else res.destroy(); });
  });
  async function handle(req, res) {
    const config = await state.settings(configOptions);
    if (req.url === "/mcp/tools") return require("./tools").handle(req, res, config, { ...configOptions, active });
    const expected = Buffer.from(`Bearer ${config.token}`), actual = Buffer.from(req.headers.authorization || "");
    if (!config.token || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) { req.resume(); return json(res, { error: { code: "unauthorized" } }, 401); }
    if (req.url === "/health" && req.method === "GET") return json(res, { service: "aitool-extensions", pid: process.pid });
    if (req.url === "/shutdown" && req.method === "POST") {
      json(res, { ok: true }); for (const controller of active) controller.abort();
      setImmediate(() => { server.close(); server.closeAllConnections(); }); return;
    }
    const match = /^\/(magpie|workbuddy|workbuddy-ai|routing)\/v1\/chat\/completions$/.exec(req.url || "");
    if (req.method !== "POST" || !match || !config.enabled[match[1]]) { req.resume(); return json(res, { error: { code: "not_found" } }, 404); }
    if (active.size >= 12 || req.headers["x-aitool-extension-hop"]) { req.resume(); return json(res, { error: { code: "extension_loop_or_busy" } }, 503); }
    const controller = new AbortController(); active.add(controller);
    const timer = setTimeout(() => controller.abort(), 120000);
    const close = () => { if (!res.writableEnded) controller.abort(); }; res.on("close", close);
    try {
      const raw = await require("../opencode-free/protocol").readRequestBody(req, 8 * 1024 * 1024, controller.signal);
      let body; try { body = JSON.parse(raw); } catch { return json(res, { error: { code: "invalid_json" } }, 400); }
      const module = match[1] === "magpie" ? require("./magpie") : match[1] === "routing" ? require("./routing") : require("./workbuddy");
      await module.forward({ kind: match[1], req, res, body, signal: controller.signal, options: configOptions, pipeline });
    } catch {
      if (!res.headersSent) json(res, { error: { code: controller.signal.aborted ? "canceled_or_timeout" : "extension_failed" } }, controller.signal.aborted ? 504 : 502); else res.destroy();
    } finally { clearTimeout(timer); active.delete(controller); res.off("close", close); }
  }
  server.requestTimeout = 120000;
  server.on("close", () => { for (const controller of active) controller.abort(); });
  server.stop = () => { for (const controller of active) controller.abort(); server.close(); server.closeAllConnections(); };
  return server;
}
if (require.main === module) (async () => {
  const config = await state.settings(options), server = createServer();
  server.on("error", () => process.exit(1));
  server.listen(config.port, "127.0.0.1", async () => state.write(path.join(state.root(options), "runtime.json"), { port: server.address().port, pid: process.pid }));
  server.on("close", async () => {
    const runtime = await state.read(path.join(state.root(options), "runtime.json"));
    if (runtime?.pid === process.pid) await require("node:fs/promises").rm(path.join(state.root(options), "runtime.json"), { force: true });
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.stop());
})();
module.exports = { createServer };
