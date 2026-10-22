"use strict";
// cc-switch agy_account, 0a41250dc03a (MIT). Installed Google application
// client identity matches agy. Stored credentials never enter cloud sync.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { execFile, spawn } = require("node:child_process");
const { writeFileAtomic, chmod600IfPossible } = require("../fs");
const paths = require("./paths");
const { privateDirectory, privateFile } = require("./agy-fs");
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = ["GOCSPX-", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("");
const scopes = ["openid", "cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs", "aicode"].map(s => s === "openid" ? s : `https://www.googleapis.com/auth/${s}`);
const encode = value => "go-keyring-base64:" + Buffer.from(JSON.stringify(value)).toString("base64");
const decode = raw => JSON.parse(raw.startsWith("go-keyring-base64:") ? Buffer.from(raw.slice(18), "base64").toString("utf8") : raw);
function identity(credential) {
  try { const value = JSON.parse(Buffer.from(credential.id_token.split(".")[1], "base64url")); return typeof value.sub === "string" && value.sub ? value : null; } catch { return null; }
}
const systemLogin = {
  read: () => new Promise((resolve, reject) => execFile("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], { timeout: 10000, maxBuffer: 65536 }, (error, stdout) => error?.code === 44 ? resolve(null) : error ? reject(new Error("Cannot read Antigravity keychain")) : resolve(stdout.trimEnd()))),
  write: raw => new Promise((resolve, reject) => {
    const line = `add-generic-password -U -s gemini -a antigravity -w "${raw}"\n`;
    if (!/^[\w+/:=-]+$/.test(raw) || line.length > 4000) { reject(new Error("Antigravity keychain value exceeds the supported size")); return; }
    const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", bytes => { errorText += bytes.toString(); });
    child.once("error", () => reject(new Error("Cannot update Antigravity keychain")));
    child.once("exit", code => code || errorText.trim() ? reject(new Error("Cannot update Antigravity keychain")) : resolve());
    child.stdin.on("error", () => {}); child.stdin.end(line);
  }),
};
function createManager({ root = paths.providerSwitchRoot(), login = systemLogin, supported = process.platform === "darwin", fetchImpl = fetch, now = Date.now } = {}) {
  let pending = Promise.resolve(); let flow;
  const serial = action => { const next = pending.catch(() => {}).then(action); pending = next; return next; };
  const storeFile = path.join(root, "agy-accounts.json");
  const load = async () => { try { await privateDirectory(root, root); await privateFile(storeFile); const value = JSON.parse(await fs.readFile(storeFile, "utf8")); if (!value.accounts || typeof value.accounts !== "object" || Array.isArray(value.accounts) || Object.values(value.accounts).some(row => !row || row.id !== identity(row.credential)?.sub || !row.credential.token)) throw new Error("Invalid account store"); return value; } catch (error) { if (error.code === "ENOENT") return { version: 1, accounts: {}, dismissed: [] }; throw new Error("Cannot read Antigravity account store"); } };
  const save = async value => { await privateDirectory(root, root); await privateFile(storeFile); await writeFileAtomic(storeFile, JSON.stringify(value) + "\n", { mode: 0o600 }); await chmod600IfPossible(storeFile); };
  const publicRow = row => ({ id: row.id, email: row.email || null, name: row.name || null, requiresReauth: row.requiresReauth === true });
  const upsert = (store, credential) => {
    const claims = identity(credential); if (!claims) throw new Error("Antigravity login has no account identity");
    const row = { id: claims.sub, email: claims.email, name: claims.name, credential, requiresReauth: false };
    Object.defineProperty(store.accounts, row.id, { value: row, writable: true, enumerable: true, configurable: true }); store.dismissed = (store.dismissed || []).filter(id => id !== row.id); return row;
  };
  const capture = async (store, switching = false) => {
    const raw = await login.read(); if (!raw) return null;
    let value; try { value = decode(raw); } catch {}
    const claims = identity(value);
    if (claims && value.token) {
      if (switching || !(store.dismissed || []).includes(claims.sub)) {
        const previous = Object.hasOwn(store.accounts, claims.sub) ? store.accounts[claims.sub] : null;
        if (!previous || previous.credential.token.refresh_token !== value.token.refresh_token) upsert(store, value);
      }
      return claims.sub;
    }
    if (switching) { const stash = path.join(root, "agy-login-stash.json"); await privateDirectory(root, root); await privateFile(stash); await writeFileAtomic(stash, JSON.stringify({ raw }) + "\n", { mode: 0o600 }); await chmod600IfPossible(stash); }
    return null;
  };
  const requirePlatform = () => { if (!supported) throw new Error("Antigravity account switching currently requires macOS"); };
  async function jsonResponse(url, options, maximum = 262144) {
    const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(20000) });
    let raw;
    if (response.body?.getReader) {
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > maximum) throw new Error("Antigravity response is too large"); chunks.push(Buffer.from(item.value)); } }
      catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      raw = Buffer.concat(chunks).toString("utf8");
    } else { raw = await response.text(); if (Buffer.byteLength(raw) > maximum) throw new Error("Antigravity response is too large"); }
    let body; try { body = JSON.parse(raw); } catch { throw new Error("Invalid Antigravity response"); }
    return { response, body };
  }
  const token = async fields => {
    const { response, body } = await jsonResponse("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...fields }), headers: { "content-type": "application/x-www-form-urlencoded" } }, 65536);
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) { const error = new Error(body.error === "invalid_grant" ? "Antigravity login expired; sign in again" : "Antigravity token exchange failed"); error.code = body.error === "invalid_grant" ? "REAUTH" : "TOKEN"; throw error; }
    return body;
  };
  const newCredential = tokens => ({ token: { access_token: tokens.access_token, refresh_token: tokens.refresh_token, token_type: tokens.token_type || "Bearer", expires_in: tokens.expires_in || 3599, expiry: new Date(now() + (tokens.expires_in || 3599) * 1000).toISOString() }, auth_method: "consumer", id_token: tokens.id_token });
  const status = () => serial(async () => { const store = await load(); const current = supported ? await capture(store) : null; if (supported) await save(store); return { supported, currentAccountId: current, accounts: Object.values(store.accounts).map(publicRow) }; });
  const switchAccount = id => serial(async () => { requirePlatform(); const store = await load(); if (!Object.hasOwn(store.accounts, id)) throw new Error("Account not found"); if (store.accounts[id].requiresReauth) throw new Error("Antigravity login expired; sign in again"); await capture(store, true); await save(store); await login.write(encode(store.accounts[id].credential)); const written = await login.read(); if (!written || identity(decode(written))?.sub !== id) throw new Error("Antigravity account switch did not verify"); return { currentAccountId: id }; });
  const remove = id => serial(async () => { const store = await load(); delete store.accounts[id]; store.dismissed = [...new Set([...(store.dismissed || []), id])]; await save(store); });
  const quota = id => serial(async () => {
    const store = await load(); const row = Object.hasOwn(store.accounts, id) ? store.accounts[id] : null; if (!row) throw new Error("Account not found");
    const refresh = async () => {
      try { const tokens = await token({ grant_type: "refresh_token", refresh_token: row.credential.token.refresh_token }); row.credential.token.access_token = tokens.access_token; row.credential.token.expiry = new Date(now() + (tokens.expires_in || 3599) * 1000).toISOString(); if (tokens.id_token) row.credential.id_token = tokens.id_token; row.requiresReauth = false; await save(store); }
      catch (error) { if (error.code === "REAUTH") { row.requiresReauth = true; await save(store); } throw error; }
    };
    if (!(Date.parse(row.credential.token.expiry) > now() + 120000)) await refresh();
    const post = method => jsonResponse(`https://cloudcode-pa.googleapis.com/v1internal:${method}`, { method: "POST", headers: { Authorization: `Bearer ${row.credential.token.access_token}`, "User-Agent": "aitool (antigravity)", "content-type": "application/json" }, body: JSON.stringify(method === "loadCodeAssist" ? { metadata: { ideType: "ANTIGRAVITY" } } : {}) });
    let result = await post("retrieveUserQuotaSummary");
    if (result.response.status === 401) { await refresh(); result = await post("retrieveUserQuotaSummary"); }
    if (result.response.status === 403) { const eligibility = await post("loadCodeAssist"); const reason = eligibility.body.ineligibleTiers?.map(row => row.reasonMessage).filter(value => typeof value === "string").join("; "); if (reason) throw new Error(reason.slice(0, 512)); }
    if (!result.response.ok) throw new Error(`Antigravity quota failed (HTTP ${result.response.status})`);
    if (!Array.isArray(result.body.groups)) throw new Error("Unrecognized Antigravity quota");
    return { groups: result.body.groups.map(group => ({ displayName: String(group.displayName || ""), buckets: (Array.isArray(group.buckets) ? group.buckets : []).map(bucket => ({ bucketId: String(bucket.bucketId || ""), remainingFraction: Number.isFinite(bucket.remainingFraction) ? Math.max(0, Math.min(1, bucket.remainingFraction)) : null, resetTime: typeof bucket.resetTime === "string" ? bucket.resetTime : null })) })) };
  });
  const cancel = () => { if (flow) { clearTimeout(flow.timer); flow.server.close(); flow = null; } };
  async function startLogin() {
    requirePlatform(); cancel();
    const state = crypto.randomBytes(24).toString("hex"); const verifier = crypto.randomBytes(32).toString("base64url");
    const current = { id: state, status: "pending", server: null, timer: null }; flow = current;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== "/oauth-callback" || url.searchParams.get("state") !== state) { res.writeHead(400); res.end("Expired sign-in link"); return; }
      if (current.status !== "pending") { res.writeHead(409); res.end(); return; }
      current.status = "working"; clearTimeout(current.timer); server.close();
      try {
        const code = url.searchParams.get("code"); if (!code || code.length > 8192 || url.searchParams.has("error")) throw new Error("Sign-in cancelled");
        const tokens = await token({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier });
        if (!tokens.refresh_token || !identity({ id_token: tokens.id_token })) throw new Error("Sign-in response has no renewable identity");
        if (flow !== current) throw new Error("Sign-in cancelled");
        await serial(async () => { if (flow !== current) throw new Error("Sign-in cancelled"); const store = await load(); upsert(store, newCredential(tokens)); await save(store); });
        current.status = "success"; res.end("Signed in. Return to AiTool.");
      } catch { current.status = "error"; res.writeHead(400); res.end("Sign-in did not complete. Return to AiTool."); }
    });
    server.maxHeadersCount = 32; server.requestTimeout = 10000; server.headersTimeout = 10000; current.server = server;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); server.unref();
    const redirect = `http://127.0.0.1:${server.address().port}/oauth-callback`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [key, value] of Object.entries({ client_id: CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: scopes.join(" "), state, code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", access_type: "offline", prompt: "select_account consent" })) url.searchParams.set(key, value);
    current.timer = setTimeout(() => { if (flow === current) { current.status = "expired"; server.close(); } }, 600000); current.timer.unref();
    return { flowId: state, authUrl: url.toString(), expiresIn: 600 };
  }
  return { status, switchAccount, remove, quota, startLogin, cancel, pollLogin: id => { if (!flow || flow.id !== id) throw new Error("Sign-in link expired"); return { status: flow.status }; } };
}
let manager;
module.exports = { createManager, identity, encode, decode, manager: () => manager ||= createManager() };
