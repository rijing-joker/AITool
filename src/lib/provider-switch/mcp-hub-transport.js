"use strict";
// Independent callable MCP transport for the opt-in Hub. The health checker
// remains read-only and never imports this module.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { resolveBinaryPath, resolvedCliEnvironment } = require("../command-runner");
const MAX_BYTES = 4 * 1024 * 1024;
const VERSION = "2025-03-26";
const fault = reason => Object.assign(new Error(`MCP transport: ${reason}`), { reason });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function rpcChannel(send) {
  const pending = new Map();
  let stopped = null;
  return {
    receive(message) {
      if (!message || message.jsonrpc !== "2.0") throw fault("protocol");
      if (message.method) {
        // Unsupported server-initiated requests must receive a reply.
        if (message.id !== undefined) void send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Server-initiated method is not supported by AiTool Hub" } }).catch(() => {});
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter.resolve(message); }
    },
    fail(error) { stopped = error; for (const waiter of pending.values()) waiter.reject(error); pending.clear(); },
    async ask(message) {
      if (stopped) throw stopped;
      const waiter = deferred(); pending.set(message.id, waiter);
      // Attach before send: an immediate process exit must not cause an
      // unhandled rejection while the write callback is still pending.
      waiter.promise.catch(() => {});
      try { await send(message); return await waiter.promise; }
      finally { pending.delete(message.id); }
    },
  };
}

function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fault("url"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw fault("url");
  return url;
}

async function consume(response, onMessage, { signal, sse = false, onEndpoint } = {}) {
  if (!response.body) throw fault("protocol");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0, event = "", data = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > MAX_BYTES) throw fault("size");
      text += decoder.decode(chunk.value, { stream: true });
      if (!sse) continue;
      let end;
      while ((end = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, end).replace(/\r$/, ""); text = text.slice(end + 1);
        if (!line) {
          if (data.length) {
            const value = data.join("\n");
            if (event === "endpoint") onEndpoint?.(value);
            else if (!event || event === "message") {
              let message; try { message = JSON.parse(value); } catch { throw fault("protocol"); }
              if (onMessage(message)) return;
            }
          }
          data = []; event = "";
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("event:")) event = line.slice(6).trim();
      }
    }
    if (!sse) {
      let message; try { message = JSON.parse(text); } catch { throw fault("protocol"); }
      onMessage(message);
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function httpStatus(response) {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw fault(response.status === 401 || response.status === 403 ? "authorization" : "http");
  }
}

async function httpTransport(spec, signal) {
  const url = safeUrl(spec.url);
  let session = null, protocol = VERSION;
  const headers = () => ({ ...spec.headers, "content-type": "application/json", accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": protocol, ...(session ? { "Mcp-Session-Id": session } : {}) });
  return {
    async send(message) {
      const response = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(message), signal, redirect: "error" });
      httpStatus(response);
      const nextSession = response.headers.get("mcp-session-id");
      if (nextSession) session = nextSession;
      if (message.id === undefined) { await response.body?.cancel(); return; }
      let reply;
      await consume(response, value => { if (value.id === message.id) { reply = value; return true; } return false; },
        { signal, sse: response.headers.get("content-type")?.includes("text/event-stream") });
      if (!reply) throw fault("protocol");
      if (message.method === "initialize" && typeof reply.result?.protocolVersion === "string") protocol = reply.result.protocolVersion;
      return reply;
    },
    async close() {
      if (!session) return;
      await fetch(url, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(1000), redirect: "error" })
        .then(response => response.body?.cancel()).catch(() => {});
    },
  };
}

async function sseTransport(spec, signal) {
  const url = safeUrl(spec.url), endpoint = deferred();
  endpoint.promise.catch(() => {});
  let target = null;
  const channel = rpcChannel(async message => {
    if (!target) throw fault("protocol");
    const response = await fetch(target, { method: "POST", headers: { ...spec.headers, "content-type": "application/json" },
      body: JSON.stringify(message), signal, redirect: "error" });
    httpStatus(response); await response.body?.cancel();
  });
  const response = await fetch(url, { headers: { ...spec.headers, accept: "text/event-stream" }, signal, redirect: "error" });
  httpStatus(response);
  void consume(response, message => { channel.receive(message); return false; }, { signal, sse: true,
    onEndpoint(value) {
      try {
        const candidate = safeUrl(new URL(value, url).href);
        if (candidate.origin !== url.origin) throw fault("endpoint");
        target = candidate; endpoint.resolve();
      } catch (error) { endpoint.reject(error); }
    },
  }).then(() => { const error = fault("exited"); channel.fail(error); endpoint.reject(error); }, error => { channel.fail(error); endpoint.reject(error); });
  await endpoint.promise;
  return { send: message => message.id === undefined ? channelSend(message) : channel.ask(message), close: () => response.body?.cancel().catch(() => {}) };
  async function channelSend(message) {
    const reply = await fetch(target, { method: "POST", headers: { ...spec.headers, "content-type": "application/json" }, body: JSON.stringify(message), signal, redirect: "error" });
    httpStatus(reply); await reply.body?.cancel();
  }
}

async function stdioTransport(spec, signal) {
  const binary = await resolveBinaryPath(spec.command, { signal });
  signal.throwIfAborted();
  if (!binary) throw fault("notfound");
  let command = binary, args = spec.args || [];
  // npm shims on Windows need their JS entry; never concatenate user args
  // through cmd.exe. Other .cmd launchers need an executable in the spec.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const name = path.basename(command).replace(/\.(cmd|bat)$/i, "");
    const entry = path.join(path.dirname(command), "node_modules", "npm", "bin", `${name}-cli.js`);
    if (!["npm", "npx"].includes(name) || !fs.existsSync(entry)) throw fault("launcher");
    command = process.execPath; args = [entry, ...args];
  }
  const child = spawn(command, args, { cwd: spec.cwd || undefined, env: resolvedCliEnvironment(binary, { env: { ...process.env, ...spec.env } }),
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  const channel = rpcChannel(message => new Promise((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(message)}\n`, error => error ? reject(fault("exited")) : resolve());
  }));
  let buffer = "", bytes = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk; bytes = Buffer.byteLength(buffer);
    if (bytes > MAX_BYTES) { channel.fail(fault("size")); return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      try { channel.receive(JSON.parse(line)); } catch { channel.fail(fault("protocol")); }
    }
  });
  // Drain but discard stderr; raw server errors may contain credentials.
  child.stderr.resume();
  child.stdin.on("error", () => channel.fail(fault("exited")));
  child.on("error", () => channel.fail(fault("start")));
  child.on("exit", () => channel.fail(fault("exited")));
  const exited = new Promise(resolve => child.once("exit", resolve));
  const close = async () => {
    channel.fail(fault("cancelled"));
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (!child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => child.kill()); killer.unref();
    } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    let timer;
    try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1000); timer.unref(); })]); }
    finally { clearTimeout(timer); }
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  return { send: message => message.id === undefined ? new Promise((resolve, reject) => child.stdin.write(`${JSON.stringify(message)}\n`, error => error ? reject(fault("exited")) : resolve())) : channel.ask(message),
    close: () => { signal.removeEventListener("abort", close); return close(); } };
}

module.exports = { stdioTransport, httpTransport, sseTransport, VERSION };
