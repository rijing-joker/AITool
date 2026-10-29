"use strict";
const crypto = require("node:crypto");
const MAX_BYTES = 4 * 1024 * 1024;
const send = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
async function handle(req, res, url) {
  const match = /^\/api\/mcp\/hub\/(all|[a-z]+)$/.exec(url.pathname);
  if (!match) return false;
  const state = await require("./mcp-hub-config").read();
  const supplied = req.headers.authorization?.replace(/^Bearer /i, "") || "";
  const token = Buffer.from(state.token || ""), incoming = Buffer.from(supplied);
  if (!token.length || incoming.length !== token.length || !crypto.timingSafeEqual(token, incoming)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="AiTool MCP Hub"'); send(res, 401, { error: "MCP Hub authentication required" }); return true;
  }
  const origin = req.headers.origin;
  if (origin) {
    let source; try { source = new URL(origin); } catch {}
    if (!source || !["http:", "https:"].includes(source.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(source.hostname) || source.username || source.password) { send(res, 403, { error: "Foreign page origin is not allowed" }); return true; }
  }
  if (match[1] !== "all" && !require("./mcp").MCP_APPS.includes(match[1])) { send(res, 404, { error: "MCP client is unsupported" }); return true; }
  if (!state.enabled) { send(res, 503, { error: "MCP Hub is disabled" }); return true; }
  if (req.method === "DELETE") { send(res, 200, {}); return true; }
  if (req.method !== "POST") { res.setHeader("Allow", "POST, DELETE"); send(res, 405, { error: "Use MCP Streamable HTTP POST" }); return true; }
  if (!req.headers["content-type"]?.includes("application/json")) { send(res, 415, { error: "JSON content type required" }); return true; }
  const controller = new AbortController(), abort = () => controller.abort();
  req.once("aborted", abort); res.once("close", abort);
  let message;
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BYTES) { send(res, 413, { error: "MCP request exceeds 4 MiB" }); return true; } chunks.push(chunk); }
    try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw Object.assign(new Error(), { rpcCode: -32700 }); }
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number")) throw Object.assign(new Error(), { rpcCode: -32600 });
    if (message.id === undefined) { res.writeHead(202); res.end(); return true; }
    const result = await require("./mcp-hub").hub().request(match[1], message, controller.signal);
    const reply = { jsonrpc: "2.0", id: message.id, result };
    if (Buffer.byteLength(JSON.stringify(reply)) > MAX_BYTES) throw new Error("MCP result exceeded the size limit");
    if (!res.destroyed) send(res, 200, reply);
  } catch (error) {
    if (!res.destroyed) send(res, 200, { jsonrpc: "2.0", id: message?.id ?? null, error: { code: error.rpcCode || -32603, message: error.rpcCode === -32602 ? "Tool unavailable or disabled" : error.rpcCode === -32601 ? "Method not supported" : "MCP Hub request failed; check the server configuration" } });
  } finally { req.removeListener("aborted", abort); res.removeListener("close", abort); }
  return true;
}
module.exports = { handle };
