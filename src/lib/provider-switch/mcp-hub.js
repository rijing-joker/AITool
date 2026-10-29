"use strict";
// Callable, opt-in MCP gateway inspired by Magpie e0ea15b8e (MIT).
// Tool arguments/results stay in process memory and are never logged.
const crypto = require("node:crypto");
const { resolveReferences } = require("./mcp-envrefs");
const transport = require("./mcp-hub-transport");
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function toolName(server, tool) {
  const name = `${server}__${tool}`;
  return name.length <= 128 ? name : `${name.slice(0, 110)}_${digest(name).slice(0, 16)}`;
}
function allowed(row, app, tool) {
  const spec = row.server;
  if ((row.disabledTools?.[app] || []).includes(tool)) return false;
  if ([spec.disabled_tools, spec.excludeTools, spec.tools?.exclude].some(list => Array.isArray(list) && list.includes(tool))) return false;
  return !Array.isArray(spec.enabled_tools) || spec.enabled_tools.includes(tool);
}
function createHub({ listServers = () => require("./mcp").listServers(), enabled = async () => (await require("./mcp-hub-config").read()).enabled,
  connect, idleMs = 600000, timeoutMs = 60000 } = {}) {
  const pool = new Map(); let sequence = 0, active = 0;
  const stop = async entry => { entry.controller.abort(); await entry.ready.catch(() => {}); await entry.client?.close(); };
  const prune = async () => {
    const rows = await listServers(), on = await enabled();
    for (const [id, entry] of pool) if (!on || !rows.some(row => row.id === id && fingerprint(row) === entry.revision) || (!entry.busy && Date.now() - entry.used > idleMs)) {
      pool.delete(id); await stop(entry);
    }
  };
  const timer = setInterval(() => { void prune().catch(() => {}); }, Math.min(idleMs, 30000)); timer.unref();
  const fingerprint = row => require("./mcp-check").fingerprint(row);
  const ask = async (entry, method, params) => {
    const id = ++sequence;
    const reply = await entry.client.send({ jsonrpc: "2.0", id, method, params });
    if (reply?.jsonrpc !== "2.0" || reply.id !== id || reply.error || !reply.result || typeof reply.result !== "object") throw new Error("MCP upstream did not return a valid result");
    return reply.result;
  };
  const acquire = async row => {
    const revision = fingerprint(row); let entry = pool.get(row.id);
    if (entry && entry.revision !== revision) { pool.delete(row.id); await stop(entry); entry = null; }
    if (!entry) {
      if (pool.size >= 20) throw new Error("MCP Hub connection limit reached");
      entry = { revision, controller: new AbortController(), used: Date.now(), busy: 0 };
      pool.set(row.id, entry);
      entry.ready = (async () => {
        const spec = resolveReferences(row.server, process.env), type = require("./mcp").specTransportType(spec);
        const watchdog = setTimeout(() => entry.controller.abort(), timeoutMs); watchdog.unref();
        try {
          entry.client = await (connect ? connect(spec, entry.controller.signal) : (type === "stdio" ? transport.stdioTransport : type === "sse" ? transport.sseTransport : transport.httpTransport)(spec, entry.controller.signal));
          const info = await ask(entry, "initialize", { protocolVersion: transport.VERSION, capabilities: {}, clientInfo: { name: "aitool-mcp-hub", version: "1.0" } });
          entry.hasTools = Boolean(info.capabilities?.tools);
          if (!info.protocolVersion || !info.capabilities) throw new Error("MCP initialization failed");
          await entry.client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        } finally { clearTimeout(watchdog); }
      })();
      entry.ready.catch(() => { if (pool.get(row.id) === entry) pool.delete(row.id); entry.controller.abort(); void entry.client?.close(); });
    }
    await entry.ready; return entry;
  };
  const using = async (row, action, signal) => {
    const entry = await acquire(row); entry.busy++;
    const abort = () => entry.controller.abort();
    const timer = setTimeout(abort, timeoutMs); timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    try { signal?.throwIfAborted(); return await action(entry); }
    catch (error) { entry.controller.abort(); throw error; }
    finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); entry.busy--; entry.used = Date.now();
      if (entry.controller.signal.aborted) { if (pool.get(row.id) === entry) pool.delete(row.id); await entry.client?.close(); }
    }
  };
  const rowsFor = async app => {
    if (!await enabled()) throw new Error("MCP Hub is disabled");
    const rows = await listServers();
    return rows.filter(row => row.id !== "aitool-hub" && (app === "all" || row.apps?.[app]));
  };
  const enumerate = async (app, signal) => {
    const tools = [], routes = new Map();
    for (const row of await rowsFor(app)) await using(row, async entry => {
      if (!entry.hasTools) return;
      let cursor; const cursors = new Set(), seen = new Set();
      for (let page = 0; page < 50; page++) {
        const result = await ask(entry, "tools/list", cursor ? { cursor } : {});
        if (!Array.isArray(result.tools)) throw new Error("MCP tool catalog is invalid");
        for (const tool of result.tools) {
          if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(tool?.name || "") || seen.has(tool.name)) throw new Error("MCP tool catalog has invalid or duplicate names");
          seen.add(tool.name); if (!allowed(row, app, tool.name)) continue;
          const name = toolName(row.id, tool.name);
          if (routes.has(name) || tools.length >= 1000) throw new Error("MCP tool catalog is too large or has colliding names");
          routes.set(name, { row, tool: tool.name }); tools.push({ ...tool, name });
        }
        cursor = result.nextCursor;
        if (!cursor) return;
        if (typeof cursor !== "string" || cursors.has(cursor)) throw new Error("MCP tool pagination is invalid");
        cursors.add(cursor);
      }
      throw new Error("MCP tool pagination limit reached");
    }, signal);
    return { tools, routes };
  };
  const request = async (app, message, signal) => {
    if (active >= 32) throw new Error("MCP Hub is busy");
    active++;
    try {
      await rowsFor(app);
      if (message.method === "initialize") return { protocolVersion: transport.VERSION, capabilities: { tools: {} }, serverInfo: { name: "aitool-hub", version: "1.0" } };
      if (message.method === "ping") return {};
      if (message.method === "tools/list") return { tools: (await enumerate(app, signal)).tools };
      if (message.method === "tools/call") {
        const route = (await enumerate(app, signal)).routes.get(message.params?.name);
        if (!route) throw Object.assign(new Error("MCP tool is unavailable or disabled"), { rpcCode: -32602 });
        const fresh = (await rowsFor(app)).find(row => row.id === route.row.id);
        if (!fresh || fingerprint(fresh) !== fingerprint(route.row) || !allowed(fresh, app, route.tool)) throw new Error("MCP configuration changed before the tool call");
        return await using(fresh, entry => ask(entry, "tools/call", { name: route.tool, arguments: message.params?.arguments || {} }), signal);
      }
      throw Object.assign(new Error("MCP method is not supported"), { rpcCode: -32601 });
    } finally { active--; }
  };
  const close = async () => { clearInterval(timer); const entries = [...pool.values()]; pool.clear(); await Promise.allSettled(entries.map(stop)); };
  return { request, prune, close, activeConnections: () => pool.size };
}
let singleton;
function hub() { return singleton ||= createHub(); }
module.exports = { createHub, hub, toolName, allowed };
