const http = require("node:http");
const crypto = require("node:crypto");
const { once } = require("node:events");
const protocol = require("./protocol");
const { createCatalog } = require("./catalog");

function failure(code, status = 502) { return Object.assign(new Error(code), { code, status }); }
function usageFromResponses(usage) {
  if (!usage) return undefined;
  const result = {};
  for (const [from, to] of [["input_tokens", "prompt_tokens"], ["output_tokens", "completion_tokens"], ["total_tokens", "total_tokens"]]) {
    if (Number.isFinite(usage[from])) result[to] = usage[from];
  }
  if (usage.input_tokens_details) result.prompt_tokens_details = { ...usage.input_tokens_details };
  if (usage.output_tokens_details) result.completion_tokens_details = { ...usage.output_tokens_details };
  return result;
}

function buildRequest(body, model) {
  const responses = model.protocol === "responses";
  const prepared = protocol.prepareToolsWithFingerprint(body.tools, responses);
  const { tools, placeholderNote, originalToAlias } = prepared;
  const payload = responses ? {
    model: model.id, stream: true, store: false, tools,
    input: protocol.transformToResponsesInput(body.messages, originalToAlias),
    instructions: protocol.extractSystemInstructions(body.messages, body.instructions, placeholderNote),
  } : {
    model: model.id, stream: true, stream_options: { include_usage: true }, tools,
    messages: protocol.transformChatMessages(body.messages, originalToAlias, placeholderNote),
  };
  const budget = body.max_completion_tokens ?? body.max_tokens;
  if (budget !== undefined) {
    if (!Number.isSafeInteger(budget) || budget <= 0) throw failure("invalid_token_budget", 400);
    // Preserve the client's ceiling, including reasoning; never silently increase it.
    payload[responses ? "max_output_tokens" : "max_tokens"] = budget;
  }
  for (const key of ["temperature", "top_p", "parallel_tool_calls"]) {
    if (body[key] !== undefined) payload[key] = body[key];
  }
  if (responses) {
    if (body.reasoning_effort) payload.reasoning = { effort: body.reasoning_effort };
    if (body.response_format) throw failure("unsupported_response_format", 400);
  } else {
    for (const key of ["stop", "response_format", "reasoning_effort"]) if (body[key] !== undefined) payload[key] = body[key];
  }
  const choice = body.tool_choice;
  // The upstream does not accept "none". Keep auto there and enforce none on output.
  if (choice && choice !== "none") {
    if (typeof choice === "object") {
      const name = choice.function?.name;
      if (!body.tools?.some((t) => t.function?.name === name)) throw failure("invalid_tool_choice", 400);
      const mapped = originalToAlias.get(name) || name;
      payload.tool_choice = responses ? { type: "function", name: mapped } : { type: "function", function: { name: mapped } };
    } else if (["auto", "required"].includes(choice)) payload.tool_choice = choice;
    else throw failure("invalid_tool_choice", 400);
  }
  return { payload, ...prepared };
}

// Parse complete SSE events, including CRLF, multi-line data and split UTF-8.
async function* events(body) {
  const decoder = new TextDecoder();
  let buffer = "", data = [], eventBytes = 0;
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    if (buffer.length > 10 * 1024 * 1024) throw failure("upstream_event_too_large");
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (!line && data.length) { yield data.join("\n"); data = []; eventBytes = 0; }
      else if (line.startsWith("data:")) {
        eventBytes += line.length;
        if (eventBytes > 10 * 1024 * 1024) throw failure("upstream_event_too_large");
        data.push(line.slice(5).trimStart());
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).trim());
  if (data.length) yield data.join("\n");
}

async function write(res, value, signal) {
  if (signal.aborted || res.destroyed) throw failure("canceled", 499);
  if (!res.write(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)) {
    await once(res, "drain", { signal });
  }
}

function createAdapter({ token, selectedModels = () => [], catalog = createCatalog(), fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  if (typeof token !== "string" || token.length < 32) throw new Error("Internal adapter token required");
  let lastInference = null;
  const controllers = new Set();
  const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json", "connection": "close" }); res.end(JSON.stringify(value)); };
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) json(res, { error: { code: "adapter_error" } }, 500);
      else res.destroy();
    });
  });
  async function handle(req, res) {
    const auth = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) {
      req.resume(); return json(res, { error: { code: "unauthorized" } }, 401);
    }
    const route = req.url?.split("?")[0];
    if (req.method === "GET" && route === "/health") {
      return json(res, { service: "aitool-opencode-free", pid: process.pid, catalog: catalog.snapshot(), lastInference });
    }
    if (req.method === "POST" && route === "/shutdown") {
      json(res, { ok: true });
      for (const controller of controllers) controller.abort();
      setImmediate(() => { server.close(); server.closeAllConnections(); }); return;
    }
    if ((req.method === "POST" && route === "/refresh") || (req.method === "GET" && route === "/v1/models")) {
      const result = await catalog.refresh(route === "/refresh");
      if (route === "/refresh") return json(res, result);
      return json(res, { object: "list", data: result.lastError ? [] : result.models.filter((m) => selectedModels().includes(m.id)).map((m) => ({ id: m.id, object: "model", owned_by: "opencode" })) });
    }
    if (req.method !== "POST" || route !== "/v1/chat/completions") { req.resume(); return json(res, { error: { code: "not_found" } }, 404); }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(failure("upstream_timeout", 504)), timeoutMs);
    const close = () => { if (!res.writableEnded) controller.abort(failure("canceled", 499)); };
    res.on("close", close);
    res.on("error", close);
    let upstream;
    try {
      let body;
      try { body = JSON.parse(await protocol.readRequestBody(req, undefined, controller.signal)); }
      catch (error) { throw failure(error.statusCode === 413 ? "payload_too_large" : "invalid_json", error.statusCode || 400); }
      if (!body || !Array.isArray(body.messages) || !body.messages.length) throw failure("messages_required", 400);
      if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((t) => t.type !== "function" || !t.function?.name))) throw failure("invalid_tools", 400);
      if (new Set((body.tools || []).map((t) => t.function.name)).size !== (body.tools || []).length) throw failure("duplicate_tool_name", 400);
      if (body.n !== undefined && body.n !== 1) throw failure("unsupported_choice_count", 400);
      if (!selectedModels().includes(body.model)) throw failure("model_not_selected", 400);
      const model = await catalog.resolve(body.model);
      if (!model) throw failure(catalog.snapshot().lastError || "model_unavailable", 503);
      const prepared = buildRequest(body, model);
      const session = protocol.getPersistentSessionId(req, body);
      upstream = await fetchImpl(`https://opencode.ai/inference/openai/v1/${model.protocol === "responses" ? "responses" : "chat/completions"}`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: {
          authorization: "Bearer public", "content-type": "application/json", accept: "text/event-stream",
          "user-agent": process.env.AITOOL_OPENCODE_FREE_USER_AGENT || "opencode/latest/2.0.29/cli",
          "x-opencode-client": "cli", "x-opencode-project": "global",
          "x-opencode-session": session, "x-opencode-session-id": session, "x-session-affinity": session,
        },
        body: JSON.stringify(prepared.payload),
      });
      if (!upstream.ok) {
        // Fixed diagnostic codes never persist or reflect upstream prompt echoes.
        throw failure(upstream.status === 429 ? "capacity_limited" : [401, 403].includes(upstream.status)
          ? "client_validation_failed" : "upstream_error", upstream.status);
      }
      if (!upstream.headers.get("content-type")?.includes("text/event-stream")) throw failure("invalid_upstream_stream");
      const id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`, created = Math.floor(Date.now() / 1000);
      const envelope = { id, created, model: model.id, object: "chat.completion.chunk" };
      let usage, finish = null, completed = false, content = "", reasoning = "", bufferedBytes = 0;
      const calls = new Map();
      const chunk = async (delta) => {
        if (body.stream) {
          if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          await write(res, { ...envelope, choices: [{ index: 0, delta, finish_reason: null }] }, controller.signal);
        } else {
          content += delta.content || ""; reasoning += delta.reasoning_content || "";
          bufferedBytes += Buffer.byteLength(JSON.stringify(delta));
          if (bufferedBytes > 10 * 1024 * 1024) throw failure("response_too_large");
        }
      };
      for await (const text of events(upstream.body)) {
        if (text === "[DONE]") { completed = Boolean(finish); break; }
        let event;
        try { event = JSON.parse(text); } catch { throw failure("invalid_upstream_event"); }
        if (event.error || event.type === "response.failed" || event.type === "error") throw failure("upstream_stream_error");
        if (model.protocol === "responses") {
          if (event.type === "response.output_text.delta") await chunk({ content: event.delta });
          if (["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event.type)) await chunk({ reasoning_content: event.delta });
          if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
            calls.set(event.output_index, { id: event.item.call_id, type: "function", function: { name: event.item.name, arguments: event.item.arguments || "" } });
          }
          if (event.type === "response.function_call_arguments.delta") {
            const call = calls.get(event.output_index);
            if (!call) throw failure("invalid_upstream_tool");
            call.function.arguments += event.delta;
          }
          if (["response.completed", "response.incomplete"].includes(event.type)) {
            usage = usageFromResponses(event.response?.usage);
            finish = event.type === "response.incomplete" ? event.response?.incomplete_details?.reason === "content_filter" ? "content_filter" : "length" : calls.size ? "tool_calls" : "stop";
            completed = true;
          }
        } else {
          if (event.usage) usage = event.usage;
          for (const choice of event.choices || []) {
            if (choice.index !== 0) throw failure("unsupported_choice_count");
            const delta = choice.delta || {};
            const { tool_calls, ...rest } = delta;
            if (Object.keys(rest).length) await chunk(rest);
            for (const tool of tool_calls || []) {
              const call = calls.get(tool.index) || { id: "", type: "function", function: { name: "", arguments: "" } };
              if (tool.id) call.id += tool.id;
              call.function.name += tool.function?.name || "";
              call.function.arguments += tool.function?.arguments || "";
              calls.set(tool.index, call);
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          }
        }
        if ([...calls.values()].reduce((n, c) => n + c.function.arguments.length + c.function.name.length, 0) > 10 * 1024 * 1024) throw failure("response_too_large");
      }
      if (!completed || !finish) throw failure("upstream_stream_incomplete");
      const tools = [...calls.values()].map((call) => {
        if (prepared.appended.includes(call.function.name) || body.tool_choice === "none") throw failure("unsupported_upstream_tool");
        call.function.name = prepared.aliasToOriginal.get(call.function.name) || call.function.name;
        if (!body.tools?.some((t) => t.function.name === call.function.name)) throw failure("unsupported_upstream_tool");
        return call;
      });
      if (body.stream) {
        if (tools.length) await chunk({ tool_calls: tools.map((call, index) => ({ index, ...call })) });
        if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream" });
        await write(res, { ...envelope, choices: [{ index: 0, delta: {}, finish_reason: finish }] }, controller.signal);
        if (usage && body.stream_options?.include_usage) await write(res, { ...envelope, choices: [], usage }, controller.signal);
        await write(res, "[DONE]", controller.signal);
        res.end();
      } else json(res, { id, created, model: model.id, object: "chat.completion", choices: [{ index: 0,
        message: { role: "assistant", content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: finish }], ...(usage ? { usage } : {}) });
      lastInference = { at: new Date().toISOString(), model: model.id, ok: true };
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      const code = reason?.code || "network_error", status = reason?.status || 502;
      lastInference = { at: new Date().toISOString(), ok: false, code, status };
      if (!res.destroyed) {
        if (res.headersSent) res.end(`data: ${JSON.stringify({ error: { code, message: code, type: "upstream_error" } })}\n\n`);
        else json(res, { error: { code, message: code, type: "upstream_error" } }, status);
      }
    } finally {
      clearTimeout(timer); controllers.delete(controller); res.off("close", close); res.off("error", close);
      if (upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {});
    }
  }
  server.requestTimeout = timeoutMs;
  return server;
}
module.exports = { createAdapter, buildRequest, usageFromResponses, events };
