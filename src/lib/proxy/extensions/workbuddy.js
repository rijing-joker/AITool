"use strict";
// Protocol/auth adapted from magpie-community/plugins @ 7fdc07f1,
// MIT. Instruction identity rewriting and system-to-user retries are omitted.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const https = require("node:https");
const { withFileLock } = require("../../fs");
const state = require("../managed-upstream");
const direct = require("./http");
const { events } = require("../opencode-free/server");
const SITES = { workbuddy: "https://copilot.tencent.com", "workbuddy-ai": "https://www.workbuddy.ai" };
function site(kind) { if (!SITES[kind]) throw new Error("Unknown WorkBuddy site"); return SITES[kind]; }
const file = (kind, options) => path.join(state.root(options), `${kind}-account.json`);
function headers(kind, account = {}) {
  return { authorization: `Bearer ${account.access || ""}`, "content-type": "application/json", accept: "application/json",
    "user-agent": "WorkBuddy/5.5.6", "x-user-id": String(account.uid || ""), "x-domain": account.domain || new URL(site(kind)).host,
    "x-product": "SaaS", "x-ide-type": "WorkBuddy", "x-ide-name": "WorkBuddy", "x-ide-version": "5.5.6", "x-requested-with": "XMLHttpRequest",
    "x-agent-intent": "craft", "x-agent-purpose": "conversation", ...(kind === "workbuddy-ai" ? { "x-agent-type": "main" } : {}),
    ...(account.enterpriseId ? { "x-enterprise-id": account.enterpriseId, "x-tenant-id": account.enterpriseId } : {}) };
}
async function call(kind, route, { account, method = "POST", body = {}, extra = {}, signal } = {}, options = {}) {
  const response = await (options.request || direct.request)(site(kind) + route, { method, headers: { ...headers(kind, account), ...extra }, body: method === "GET" ? undefined : JSON.stringify(body), signal });
  let doc; try { doc = JSON.parse(response.body); } catch { throw new Error("Invalid WorkBuddy response"); }
  if (response.status >= 300 || doc.code) {
    const error = new Error(`WorkBuddy HTTP ${response.status}, code ${Number(doc.code) || 0}`);
    error.code = Number(doc.code); error.status = response.status; throw error;
  }
  return doc.data;
}
function merged(account, token) {
  if (typeof token?.accessToken !== "string" || !token.accessToken) throw new Error("WorkBuddy returned no access token");
  return { ...account, access: token.accessToken, refresh: token.refreshToken || account.refresh || "", domain: token.domain || account.domain || "",
    expires: token.expiresAt > 0 ? token.expiresAt : token.expiresIn > 0 ? Date.now() + token.expiresIn * 1000 : account.expires || 0,
    refreshExpiresAt: token.refreshExpiresAt > 0 ? token.refreshExpiresAt : token.refreshExpiresIn > 0 ? Date.now() + token.refreshExpiresIn * 1000 : account.refreshExpiresAt || 0 };
}
function desktopFile(kind, options = {}) {
  site(kind);
  const home = options.home || os.homedir(), platform = options.platform || process.platform;
  const base = platform === "darwin" ? path.join(home, "Library/Application Support") : platform === "win32" ? path.join(home, "AppData/Local") : path.join(home, ".local/share");
  return path.join(base, "CodeBuddyExtension/Data/Public/auth", kind === "workbuddy" ? "workbuddy-desktop.info" : "workbuddy-desktop-ai.info");
}
async function desktop(kind, options = {}) {
  let data;
  try { const raw = await fs.readFile(desktopFile(kind, options), "utf8"); if (raw.length > 1024 * 1024) throw new Error(); data = JSON.parse(raw); }
  catch { throw new Error("No readable WorkBuddy desktop sign-in; use browser login"); }
  if (data.auth?.accessToken?.$wbEncrypted || data.auth?.refreshToken?.$wbEncrypted) throw new Error("WorkBuddy desktop credentials are encrypted; use browser login");
  if (!data.account?.uid || typeof data.auth?.accessToken !== "string") throw new Error("No usable desktop account");
  // Never spend the desktop's rotating refresh token: that can sign it out.
  const account = merged({ uid: String(data.account.uid), enterpriseId: data.account.enterpriseId || "", source: "desktop" }, { ...data.auth, refreshToken: "" });
  if (account.expires && account.expires < Date.now() + 60000) throw new Error("Desktop login is expiring; refresh it in WorkBuddy or use browser login");
  return account;
}
async function useDesktop(kind, options = {}) {
  const account = await desktop(kind, options);
  await state.write(file(kind, options), { source: "desktop", uid: account.uid, enterpriseId: account.enterpriseId });
  return { source: "desktop" };
}
async function begin(kind, options = {}) {
  const login = await call(kind, `/v2/plugin/auth/state?platform=${encodeURIComponent(kind)}`, { extra: { "x-no-authorization": "true", "x-no-user-id": "true", "x-no-enterprise-id": "true", "x-no-department-info": "true" } }, options);
  let url; try { url = new URL(login.authUrl); } catch { throw new Error("WorkBuddy returned no login URL"); }
  if (url.protocol !== "https:" || url.username || url.password || !["tencent.com", "workbuddy.ai", "workbuddy.cn"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) || typeof login.state !== "string") throw new Error("Untrusted WorkBuddy login URL");
  url.searchParams.set("version", "2.0.0"); url.searchParams.set("loginSessionId", crypto.randomUUID());
  const id = crypto.randomUUID();
  await state.write(path.join(state.root(options), `${kind}-login.json`), { id, state: login.state, expires: Date.now() + 300000 });
  return { id, url: url.toString() };
}
async function poll(kind, id, options = {}) {
  const loginFile = path.join(state.root(options), `${kind}-login.json`);
  return withFileLock(loginFile, async () => {
    const login = await state.read(loginFile);
    if (!login || login.id !== id || login.expires < Date.now()) throw new Error("WorkBuddy login expired; start again");
    try {
      const token = login.token || await call(kind, `/v2/plugin/auth/token?state=${encodeURIComponent(login.state)}`, { method: "GET" }, options);
      if (!login.token) await state.write(loginFile, { ...login, token });
      let account = merged({}, token);
      const who = await call(kind, `/v2/plugin/login/account?state=${encodeURIComponent(login.state)}`, { method: "GET", account, extra: { "x-no-user-id": "true", "x-no-enterprise-id": "true" } }, options);
      if (!who?.uid) throw new Error("WorkBuddy returned no account ID");
      account = { ...account, source: "browser", uid: String(who.uid), enterpriseId: who.enterpriseId || "" };
      const type = String(who.type || "").trim().toLowerCase();
      if (!account.enterpriseId && type && type !== "personal") {
        const list = await call(kind, "/v2/plugin/accounts", { method: "GET", account }, options);
        const mine = (list?.accounts || []).filter(row => String(row.uid) === account.uid && typeof row.enterpriseId === "string" && row.enterpriseId.trim());
        const same = mine.filter(row => String(row.type || "").toLowerCase() === type), last = mine.filter(row => row.lastLogin);
        const pick = same.length === 1 ? same[0] : last.length === 1 ? last[0] : mine.length === 1 ? mine[0] : null;
        if (!pick) throw new Error("WorkBuddy enterprise account is ambiguous; select an explicit account in login");
        account.enterpriseId = pick.enterpriseId.trim();
      }
      await state.write(file(kind, options), account); await fs.rm(loginFile, { force: true });
      return { pending: false, source: "browser" };
    } catch (error) { if ([11217, 12151].includes(error.code) || [408, 429].includes(error.status)) return { pending: true }; throw error; }
  });
}
async function current(kind, options = {}) {
  const target = file(kind, options);
  return withFileLock(target, async () => {
    let account = await state.read(target);
    if (!account) throw new Error("Sign in to WorkBuddy first");
    if (account.source === "desktop") return desktop(kind, options);
    if (typeof account.access !== "string" || !account.access || !account.uid || ![undefined, "browser"].includes(account.source)) throw new Error("WorkBuddy login is unreadable; sign in again");
    if (!account.expires || account.expires > Date.now() + 60000) return account;
    if (!account.refresh || (account.refreshExpiresAt && account.refreshExpiresAt < Date.now())) throw new Error("WorkBuddy login expired; sign in again");
    const token = await call(kind, "/v2/plugin/auth/token/refresh", { account, extra: { "x-refresh-token": account.refresh, "x-auth-refresh-source": "plugin" } }, options);
    account = merged(account, token); await state.write(target, account); return account;
  });
}
// A 401 mid-call renews once and resends (magpie-community workbuddy 0.1.31).
// The renewal runs under the same account file lock as current(), so two
// concurrent calls cannot both spend the rotating refresh token; if another
// call already renewed, its fresh account is reused without a second refresh.
async function authorizedCall(kind, route, { account, ...rest }, options = {}) {
  try {
    return await call(kind, route, { account, ...rest }, options);
  } catch (error) {
    if (error.status !== 401 || !account || account.source === "desktop" || !account.refresh) throw error;
    const target = file(kind, options);
    const renewed = await withFileLock(target, async () => {
      let latest = await state.read(target);
      if (!latest || latest.source === "desktop" || typeof latest.access !== "string" || !latest.access) throw error;
      if (latest.access !== account.access && latest.expires && latest.expires > Date.now() + 60000) return latest;
      if (!latest.refresh || (latest.refreshExpiresAt && latest.refreshExpiresAt < Date.now())) throw new Error("WorkBuddy login expired; sign in again");
      const token = await call(kind, "/v2/plugin/auth/token/refresh", { account: latest, extra: { "x-refresh-token": latest.refresh, "x-auth-refresh-source": "plugin" } }, options);
      latest = merged(latest, token); await state.write(target, latest); return latest;
    });
    return await call(kind, route, { ...rest, account: renewed }, options);
  }
}
async function catalog(kind, options = {}) {
  const account = await current(kind, options);
  const config = await authorizedCall(kind, "/v3/config", { account, method: "GET" }, options);
  const allowed = (config.agents || []).filter(row => row.name === "cli").flatMap(row => row.models || []);
  return [...new Set(allowed)].flatMap(id => {
    const row = config.models?.find(model => model.id === id);
    if (!row || typeof id !== "string" || !id || id.length > 256 || /[\x00-\x1f]/.test(id)) return [];
    return [{ id, name: String(row.name || id).slice(0, 256), contextWindow: row.maxInputTokens, maxOutputTokens: row.maxOutputTokens,
      images: row.supportsImages === true && !(kind === "workbuddy-ai" && /^glm-/.test(id)), reasoning: row.supportsReasoning === true }];
  });
}
function quotaOf(sum) {
  let used = 0, total = 0;
  for (const row of sum?.Packages || []) {
    const limit = Number(row.CycleTotalCapacity), amount = Number(row.CycleUsedCapacity);
    if (!Number.isFinite(limit) || !Number.isFinite(amount) || limit < 0 || amount < 0) throw new Error("Invalid WorkBuddy quota");
    total += limit; used += amount;
  }
  return total > 0 ? { used, total, unit: "credits" } : null;
}
async function quota(kind, options = {}) {
  const account = await current(kind, options);
  const sum = await authorizedCall(kind, "/billing/meter/get-user-resource-summary", { account }, options);
  const personal = quotaOf(sum); if (personal) return personal;
  if (account.enterpriseId) {
    const value = await authorizedCall(kind, "/billing/meter/get-enterprise-user-usage", { account }, options);
    const total = Number(value.limitNum), used = Number(value.credit);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(used) && used >= 0) return { used, total, unit: "credits" };
  }
  return { used: null, total: null, unit: "credits" };
}
async function status(kind, options = {}) {
  site(kind); const config = await state.settings(options), account = await state.read(file(kind, options));
  return { enabled: config.enabled[kind] === true, signedIn: !!account, source: account?.source || null, models: config[kind]?.models || [], instructionPolicy: "preserve" };
}
async function configure(kind, input, options = {}) {
  site(kind); if (typeof input.enabled !== "boolean") throw new Error("enabled must be boolean");
  if (!input.enabled) {
    await state.configure(`aitool-${kind}`, null, options);
    await state.saveSettings(value => ({ ...value, enabled: { ...value.enabled, [kind]: false } }), options); return status(kind, options);
  }
  const models = await catalog(kind, options);
  if (!Array.isArray(input.models) || !input.models.length || input.models.length > 100 || input.models.some(id => !models.some(row => row.id === id))) throw new Error("Select live WorkBuddy models");
  const port = await (options.runtime || require("./runtime")).start(options), config = await state.settings(options);
  const ids = [...new Set(input.models)];
  await state.configure(`aitool-${kind}`, { "base-url": `http://127.0.0.1:${port}/${kind}/v1`, keys: [{ "api-key": config.token, "proxy-url": "direct" }], models: ids.map(id => ({ name: id, alias: `${kind}/${id}` })) }, options);
  await state.saveSettings(value => ({ ...value, enabled: { ...value.enabled, [kind]: true }, [kind]: { models: ids } }), options); return status(kind, options);
}
async function forget(kind, options = {}) {
  await configure(kind, { enabled: false }, options);
  await fs.rm(file(kind, options), { force: true }); return status(kind, options);
}
async function collectCompletion(response, model) {
  const result = { id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model };
  const choices = new Map();
  let done = false, bytes = 0;
  for await (const event of events(response)) {
    bytes += Buffer.byteLength(event);
    if (bytes > 16 * 1024 * 1024) throw new Error("WorkBuddy response exceeds size limit");
    if (event.trim() === "[DONE]") { done = true; break; }
    let chunk;
    try { chunk = JSON.parse(event); } catch { throw new Error("Invalid WorkBuddy stream"); }
    if (!chunk || typeof chunk !== "object" || chunk.error) throw new Error("WorkBuddy stream failed");
    for (const key of ["id", "created", "model", "system_fingerprint", "service_tier"]) if (chunk[key] != null) result[key] = chunk[key];
    if (chunk.usage) {
      const previous = result.usage;
      result.usage = { ...previous, ...chunk.usage };
      for (const key of ["prompt_tokens_details", "completion_tokens_details"]) {
        if (chunk.usage[key]) result.usage[key] = { ...previous?.[key], ...chunk.usage[key] };
      }
    }
    if (chunk.choices !== undefined && !Array.isArray(chunk.choices)) throw new Error("Invalid WorkBuddy choices");
    for (const piece of chunk.choices || []) {
      if (!Number.isSafeInteger(piece.index) || piece.index < 0) throw new Error("Invalid WorkBuddy choice index");
      let choice = choices.get(piece.index);
      if (!choice) {
        choice = { index: piece.index, message: { role: "assistant", content: null }, finish_reason: null, tools: new Map() };
        choices.set(piece.index, choice);
      }
      const delta = piece.delta || {};
      for (const key of ["content", "reasoning_content", "refusal"]) {
        if (typeof delta[key] === "string") choice.message[key] = (choice.message[key] || "") + delta[key];
      }
      if (delta.function_call) {
        const call = choice.message.function_call ||= { name: "", arguments: "" };
        for (const key of ["name", "arguments"]) if (typeof delta.function_call[key] === "string") call[key] += delta.function_call[key];
      }
      for (const part of delta.tool_calls || []) {
        if (!Number.isSafeInteger(part.index) || part.index < 0) throw new Error("Invalid WorkBuddy tool index");
        const tool = choice.tools.get(part.index) || { id: "", type: "function", function: { name: "", arguments: "" } };
        if (part.id) tool.id = part.id;
        if (part.type) tool.type = part.type;
        for (const key of ["name", "arguments"]) if (typeof part.function?.[key] === "string") tool.function[key] += part.function[key];
        choice.tools.set(part.index, tool);
      }
      if (piece.finish_reason != null) choice.finish_reason = piece.finish_reason;
    }
  }
  if (!done || !choices.size || [...choices.values()].some(choice => !choice.finish_reason)) throw new Error("Incomplete WorkBuddy stream");
  result.choices = [...choices.values()].sort((a, b) => a.index - b.index).map(({ tools, ...choice }) => {
    if (tools.size) choice.message.tool_calls = [...tools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => tool);
    return choice;
  });
  return result;
}
function isMessagesModel(kind, model) {
  // WorkBuddy's China build serves only its Claude models on Messages; the
  // international build has no /v1/messages route (magpie-community 0.1.32).
  return kind === "workbuddy" && /^claude-/i.test(String(model || ""));
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => typeof part === "string" ? part : part?.type === "text" ? String(part.text || "") : "").join("");
}
function imageBlock(part) {
  const url = part?.image_url?.url || part?.image_url;
  if (typeof url !== "string" || !url) return null;
  const match = /^data:([^;,]+);base64,(.+)$/.exec(url);
  return match
    ? { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } }
    : { type: "image", source: { type: "url", url } };
}
function chatToMessages(body) {
  const system = [];
  const messages = [];
  let toolResults = [];
  const flushResults = () => {
    if (!toolResults.length) return;
    messages.push({ role: "user", content: toolResults });
    toolResults = [];
  };
  for (const row of body.messages || []) {
    if (!row || typeof row !== "object") continue;
    if (row.role === "system" || row.role === "developer") {
      const text = textOf(row.content);
      if (text) system.push(text);
      continue;
    }
    if (row.role === "tool") {
      toolResults.push({ type: "tool_result", tool_use_id: String(row.tool_call_id || ""), content: textOf(row.content) });
      continue;
    }
    flushResults();
    if (row.role === "assistant") {
      const content = [];
      const text = textOf(row.content);
      if (text) content.push({ type: "text", text });
      for (const call of row.tool_calls || []) {
        let input = {};
        try { input = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments) : call.function?.arguments || {}; } catch { input = {}; }
        content.push({ type: "tool_use", id: String(call.id || `toolu_${crypto.randomUUID()}`), name: String(call.function?.name || "unknown"), input });
      }
      if (content.length) messages.push({ role: "assistant", content });
      continue;
    }
    if (row.role !== "user") continue;
    const content = [];
    if (Array.isArray(row.content)) {
      for (const part of row.content) {
        if (part?.type === "image_url") { const image = imageBlock(part); if (image) content.push(image); }
        else if (part?.type === "tool_result") content.push({ type: "tool_result", tool_use_id: String(part.tool_use_id || ""), content: textOf(part.content), ...(part.is_error ? { is_error: true } : {}) });
        else content.push({ type: "text", text: String(part?.text ?? part?.content ?? "") });
      }
    } else if (row.content != null) content.push({ type: "text", text: String(row.content) });
    if (content.length) messages.push({ role: "user", content });
  }
  flushResults();
  const request = {
    model: body.model,
    messages,
    max_tokens: Number(body.max_tokens) > 0 ? Number(body.max_tokens) : Number(body.max_completion_tokens) > 0 ? Number(body.max_completion_tokens) : 8192,
    stream: true,
  };
  if (system.length) request.system = system.join("\n\n");
  if (Number.isFinite(Number(body.temperature))) request.temperature = Number(body.temperature);
  if (Number.isFinite(Number(body.top_p))) request.top_p = Number(body.top_p);
  if (Array.isArray(body.stop) && body.stop.length) request.stop_sequences = body.stop;
  if (Array.isArray(body.tools) && body.tools.length) {
    request.tools = body.tools.filter(tool => tool?.function?.name).map(tool => ({
      name: tool.function.name, description: tool.function.description || "", input_schema: tool.function.parameters || { type: "object" },
    }));
  }
  const choice = body.tool_choice;
  if (choice === "none") request.tool_choice = { type: "none" };
  else if (choice === "auto") request.tool_choice = { type: "auto" };
  else if (choice === "required") request.tool_choice = { type: "any" };
  else if (choice?.function?.name) request.tool_choice = { type: "tool", name: choice.function.name };
  const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort.toLowerCase() : "";
  if (["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    request.thinking = { type: "adaptive" };
    request.output_config = { effort };
  }
  return request;
}
function openAiUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const input = Number(usage.input_tokens) || 0, read = Number(usage.cache_read_input_tokens) || 0;
  const write = Number(usage.cache_creation_input_tokens) || 0, output = Number(usage.output_tokens) || 0;
  if (!input && !read && !write && !output) return undefined;
  return { prompt_tokens: input + read + write, completion_tokens: output, total_tokens: input + read + write + output,
    prompt_tokens_details: { cached_tokens: read, cache_creation_tokens: write } };
}
function stopReason(value) {
  return value === "tool_use" ? "tool_calls" : value === "max_tokens" ? "length" : value === "refusal" ? "content_filter" : "stop";
}
async function collectMessagesCompletion(response, model) {
  const result = { id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: null }] };
  const choice = result.choices[0], tools = new Map();
  let rawUsage = {}, stop = null, bytes = 0;
  for await (const event of events(response)) {
    bytes += Buffer.byteLength(event);
    if (bytes > 16 * 1024 * 1024) throw new Error("WorkBuddy response exceeds size limit");
    let value; try { value = JSON.parse(event); } catch { throw new Error("Invalid WorkBuddy stream"); }
    if (value?.type === "message_start") {
      result.id = value.message?.id || result.id;
      result.model = value.message?.model || result.model;
      rawUsage = { ...rawUsage, ...(value.message?.usage || {}) };
    } else if (value?.type === "content_block_start") {
      const block = value.content_block || {};
      if (block.type === "tool_use") {
        tools.set(value.index, { id: String(block.id || ""), type: "function", function: { name: String(block.name || "unknown"), arguments: "" } });
      }
    } else if (value?.type === "content_block_delta") {
      const delta = value.delta || {};
      if (delta.type === "text_delta") choice.message.content = (choice.message.content || "") + String(delta.text || "");
      else if (delta.type === "thinking_delta") choice.message.reasoning_content = (choice.message.reasoning_content || "") + String(delta.thinking || "");
      else if (delta.type === "input_json_delta") { const tool = tools.get(value.index); if (tool) tool.function.arguments += String(delta.partial_json || ""); }
    } else if (value?.type === "message_delta") {
      if (value.delta?.stop_reason) stop = value.delta.stop_reason;
      rawUsage = { ...rawUsage, ...(value.usage || {}) };
    } else if (value?.type === "error") {
      throw new Error("WorkBuddy stream failed");
    }
  }
  if (!stop) throw new Error("Incomplete WorkBuddy stream");
  choice.finish_reason = stopReason(stop);
  if (tools.size) choice.message.tool_calls = [...tools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => tool);
  const usage = openAiUsage(rawUsage);
  if (usage) result.usage = usage;
  return result;
}
async function pipeMessagesStream(response, res, model) {
  // Hold the 200 until the first real SSE event parses. A build that answers
  // with plain JSON then fails while headers are still unsent, so the caller
  // can fall back to chat instead of truncating a "successful" stream.
  const write = value => {
    if (!res.headersSent) {
      res.writeHead(response.statusCode, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    }
    res.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  const state = { id: `chatcmpl-${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model, rawUsage: {}, stop: null, tools: new Map(), nextTool: 0, roleSent: false };
  let bytes = 0;
  for await (const event of events(response)) {
    bytes += Buffer.byteLength(event);
    if (bytes > 16 * 1024 * 1024) throw new Error("WorkBuddy response exceeds size limit");
    let value; try { value = JSON.parse(event); } catch { throw new Error("Invalid WorkBuddy stream"); }
    if (value?.type === "message_start") {
      state.id = value.message?.id || state.id;
      state.model = value.message?.model || state.model;
      state.rawUsage = { ...state.rawUsage, ...(value.message?.usage || {}) };
      if (!state.roleSent) { state.roleSent = true; write({ id: state.id, object: "chat.completion.chunk", created: state.created, model: state.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }); }
    } else if (value?.type === "content_block_start") {
      const block = value.content_block || {};
      if (block.type === "tool_use") {
        const index = state.nextTool++;
        state.tools.set(value.index, { index, tool: { id: String(block.id || ""), type: "function", function: { name: String(block.name || "unknown"), arguments: "" } } });
        write({ id: state.id, object: "chat.completion.chunk", created: state.created, model: state.model, choices: [{ index: 0, delta: { tool_calls: [{ index, id: String(block.id || ""), type: "function", function: { name: String(block.name || "unknown"), arguments: "" } }] }, finish_reason: null }] });
      }
    } else if (value?.type === "content_block_delta") {
      const delta = value.delta || {};
      let next = null;
      if (delta.type === "text_delta") next = { content: String(delta.text || "") };
      else if (delta.type === "thinking_delta") next = { reasoning_content: String(delta.thinking || "") };
      else if (delta.type === "input_json_delta") {
        const entry = state.tools.get(value.index);
        if (entry) { entry.tool.function.arguments += String(delta.partial_json || ""); next = { tool_calls: [{ index: entry.index, function: { arguments: String(delta.partial_json || "") } }] }; }
      }
      if (next) write({ id: state.id, object: "chat.completion.chunk", created: state.created, model: state.model, choices: [{ index: 0, delta: next, finish_reason: null }] });
    } else if (value?.type === "message_delta") {
      if (value.delta?.stop_reason) state.stop = value.delta.stop_reason;
      state.rawUsage = { ...state.rawUsage, ...(value.usage || {}) };
    } else if (value?.type === "error") {
      throw new Error("WorkBuddy stream failed");
    }
  }
  if (!state.stop) throw new Error("Incomplete WorkBuddy stream");
  const usage = openAiUsage(state.rawUsage);
  write({ id: state.id, object: "chat.completion.chunk", created: state.created, model: state.model,
    choices: [{ index: 0, delta: {}, finish_reason: stopReason(state.stop) }], ...(usage ? { usage } : {}) });
  res.end("data: [DONE]\n\n");
  return true;
}
async function forward({ kind, req, res, body, signal, options, pipeline }) {
  const config = await state.settings(options);
  if (!config[kind]?.models.includes(body.model) || !Array.isArray(body.messages)) throw new Error("WorkBuddy model not selected");
  if (body.tools?.some(tool => !/^[A-Za-z0-9_-]{1,64}$/.test(tool.function?.name || ""))) {
    res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "unsupported_tool_name", message: "WorkBuddy requires ASCII tool names; tool names and instructions are preserved" } })); return;
  }
  const account = await current(kind, options);
  const session = req.headers["x-magpie-session"] || req.headers["session_id"];
  const conversation = typeof session === "string" && session.length <= 128 ? session : JSON.stringify(body.messages.find(row => row.role === "user")?.content || crypto.randomUUID());
  const turn = body.messages.map((row, index) => row.role === "user" ? index : -1).filter(index => index >= 0).at(-1);
  const refusal = (statusCode) => {
    // Refusals often echo system text. Fixed errors keep bodies out of logs.
    res.writeHead(statusCode, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: statusCode === 429 ? "insufficient_quota" : "upstream_error", code: `workbuddy_http_${statusCode}`, message: "WorkBuddy refused this request; instructions were preserved. Check login, quota or choose another provider." } }));
  };
  // Chat and Messages sign per-request headers, so the 401 renewal cannot
  // reuse authorizedCall directly: one renewal under the same account-file
  // lock, then one re-signed resend. Nothing has been written to the client
  // before the first response arrives, so a mid-stream failure is never retried.
  const signedHeaders = (current) => {
    const signed = headers(kind, current);
    signed.accept = "text/event-stream";
    signed["x-request-id"] = crypto.randomUUID();
    signed["x-conversation-id"] = crypto.createHmac("sha256", config.token).update(conversation).digest("hex").slice(0, 32);
    signed["x-conversation-request-id"] = crypto.createHmac("sha256", config.token).update(conversation).update(JSON.stringify([turn, body.messages[turn]?.content])).digest("hex").slice(0, 32);
    signed["x-conversation-message-id"] = signed["x-request-id"];
    return signed;
  };
  const sendChat = (current, allowRenew) => new Promise((resolve, reject) => {
    const upstream = (options.streamRequest || https.request)(site(kind) + "/v2/chat/completions", { method: "POST", signal, headers: signedHeaders(current), agent: false }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); return reject(new Error("WorkBuddy redirect refused")); }
      if (response.statusCode >= 400) {
        response.resume();
        if (allowRenew && response.statusCode === 401 && current.source !== "desktop" && current.refresh) {
          const error = new Error(`WorkBuddy HTTP ${response.statusCode}`); error.status = response.statusCode; return reject(error);
        }
        refusal(response.statusCode); resolve(); return;
      }
      if (body.stream === true) {
        res.writeHead(response.statusCode, { "content-type": response.headers["content-type"] || "text/event-stream" });
        pipeline(response, res, { signal }).then(resolve, reject);
      } else {
        collectCompletion(response, body.model).then(completion => {
          res.writeHead(response.statusCode, { "content-type": "application/json" });
          res.end(JSON.stringify(completion)); resolve();
        }, reject);
      }
    });
    upstream.on("error", reject);
    upstream.end(JSON.stringify({ ...body, stream: true, stream_options: { ...body.stream_options, include_usage: true } }));
  });
  const sendMessages = (current, allowRenew) => new Promise((resolve, reject) => {
    const signed = signedHeaders(current);
    signed["anthropic-version"] ||= "2023-06-01";
    const upstream = (options.streamRequest || https.request)(site(kind) + "/v1/messages", { method: "POST", signal, headers: signed, agent: false }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); return reject(new Error("WorkBuddy redirect refused")); }
      if (response.statusCode >= 400) {
        response.resume();
        if (allowRenew && response.statusCode === 401 && current.source !== "desktop" && current.refresh) {
          const error = new Error(`WorkBuddy HTTP ${response.statusCode}`); error.status = response.statusCode; return reject(error);
        }
        // Only a missing route means this build/account cannot serve Messages.
        // Quota, rate-limit and upstream failures must surface instead of
        // silently spending a second full chat request.
        if ([404, 405, 415, 501].includes(response.statusCode)) { resolve({ fallback: true }); return; }
        refusal(response.statusCode); resolve({ fallback: false }); return;
      }
      const done = body.stream === true
        ? pipeMessagesStream(response, res, body.model)
        : collectMessagesCompletion(response, body.model).then(completion => {
            res.writeHead(response.statusCode, { "content-type": "application/json" });
            res.end(JSON.stringify(completion));
          });
      done.then(() => resolve({ fallback: false }), error => {
        // The Messages protocol failed before any bytes were written; chat can
        // still answer this request. Once headers are out, a retry would splice
        // two responses together, so the error propagates to the proxy layer.
        if (!res.headersSent) resolve({ fallback: true });
        else reject(error);
      });
    });
    upstream.on("error", reject);
    upstream.end(JSON.stringify(chatToMessages(body)));
  });
  const messagesModel = isMessagesModel(kind, body.model);
  const attempt = async (current, allowRenew) => {
    if (!messagesModel) return sendChat(current, allowRenew);
    const result = await sendMessages(current, allowRenew);
    if (result?.fallback) await sendChat(current, false);
    return result;
  };
  try {
    await attempt(account, true);
  } catch (error) {
    if (error.status !== 401) throw error;
    const target = file(kind, options);
    try {
      const renewed = await withFileLock(target, async () => {
        let latest = await state.read(target);
        if (!latest || latest.source === "desktop" || typeof latest.access !== "string" || !latest.access) throw error;
        if (latest.access !== account.access && latest.expires && latest.expires > Date.now() + 60000) return latest;
        if (!latest.refresh || (latest.refreshExpiresAt && latest.refreshExpiresAt < Date.now())) throw new Error("WorkBuddy login expired; sign in again");
        const token = await call(kind, "/v2/plugin/auth/token/refresh", { account: latest, extra: { "x-refresh-token": latest.refresh, "x-auth-refresh-source": "plugin" } }, options);
        latest = merged(latest, token); await state.write(target, latest); return latest;
      });
      await attempt(renewed, false);
    } catch (renewError) {
      if (renewError === error || (renewError && renewError.status === 401)) { refusal(401); return; }
      throw renewError;
    }
  }
}
module.exports = { SITES, headers, merged, desktopFile, desktop, useDesktop, begin, poll, current, catalog, quotaOf, quota, status, configure, forget, forward, isMessagesModel, chatToMessages };
