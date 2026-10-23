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
async function catalog(kind, options = {}) {
  const account = await current(kind, options);
  const config = await call(kind, "/v3/config", { account, method: "GET" }, options);
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
  const sum = await call(kind, "/billing/meter/get-user-resource-summary", { account }, options);
  const personal = quotaOf(sum); if (personal) return personal;
  if (account.enterpriseId) {
    const value = await call(kind, "/billing/meter/get-enterprise-user-usage", { account }, options);
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
async function forward({ kind, req, res, body, signal, options, pipeline }) {
  const config = await state.settings(options);
  if (!config[kind]?.models.includes(body.model) || !Array.isArray(body.messages)) throw new Error("WorkBuddy model not selected");
  if (body.tools?.some(tool => !/^[A-Za-z0-9_-]{1,64}$/.test(tool.function?.name || ""))) {
    res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "unsupported_tool_name", message: "WorkBuddy requires ASCII tool names; tool names and instructions are preserved" } })); return;
  }
  const account = await current(kind, options);
  const signed = headers(kind, account); signed.accept = "text/event-stream"; signed["x-conversation-id"] = crypto.randomUUID(); signed["x-request-id"] = crypto.randomUUID();
  const session = req.headers["x-magpie-session"] || req.headers["session_id"];
  const conversation = typeof session === "string" && session.length <= 128 ? session : JSON.stringify(body.messages.find(row => row.role === "user")?.content || crypto.randomUUID());
  signed["x-conversation-id"] = crypto.createHmac("sha256", config.token).update(conversation).digest("hex").slice(0, 32);
  const turn = body.messages.map((row, index) => row.role === "user" ? index : -1).filter(index => index >= 0).at(-1);
  signed["x-conversation-request-id"] = crypto.createHmac("sha256", config.token).update(conversation).update(JSON.stringify([turn, body.messages[turn]?.content])).digest("hex").slice(0, 32);
  signed["x-conversation-message-id"] = signed["x-request-id"];
  await new Promise((resolve, reject) => {
    const upstream = (options.streamRequest || https.request)(site(kind) + "/v2/chat/completions", { method: "POST", signal, headers: signed, agent: false }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); return reject(new Error("WorkBuddy redirect refused")); }
      if (response.statusCode >= 400) {
        // Refusals often echo system text. Fixed errors keep bodies out of logs.
        response.resume(); res.writeHead(response.statusCode, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: response.statusCode === 429 ? "insufficient_quota" : "upstream_error", code: `workbuddy_http_${response.statusCode}`, message: "WorkBuddy refused this request; instructions were preserved. Check login, quota or choose another provider." } })); resolve(); return;
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
}
module.exports = { SITES, headers, merged, desktopFile, desktop, useDesktop, begin, poll, current, catalog, quotaOf, quota, status, configure, forget, forward };
