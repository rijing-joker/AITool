"use strict";
// Kimi Code official OAuth, ported from cc-switch's services/kimi_oauth
// (7da2553..cdd2190, MIT). Device-code login against region-fixed official
// hosts (mainland https://auth.kimi.com / global https://auth.kimi.ai; the
// model API rides https://api.kimi.com|ai/coding/v1). The first login takes
// Kimi's own default slot (managed:kimi-code / credentials/kimi-code.json);
// further accounts get kimi-code-ccs-<8-hex> slots named "Kimi Subscription
// <nickname>". Credentials live only in ~/.kimi-code/credentials (0600) and
// never enter cloud sync; the identity cache is AiTool-local.
//
// Refresh follows Kimi's own cross-process protocol: take the slot lock
// (oauth/<slot>.lock directory, stale after 5s), re-read the credential, and
// on rejection adopt a token another process rotated before tombstoning.

const fsSync = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { writeFileAtomic, chmod600IfPossible } = require("../fs");
const paths = require("./paths");
const kimi = require("./kimi");

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const REGIONS = {
  cn: { id: "cn", oauthHost: "https://auth.kimi.com", baseUrl: "https://api.kimi.com/coding/v1" },
  global: { id: "global", oauthHost: "https://auth.kimi.ai", baseUrl: "https://api.kimi.ai/coding/v1" },
};
const LOCK_STALE_MS = 5000;
const USER_AGENT = "aitool/kimi";

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function accountSuffix(region, userId) {
  return sha256Hex(`${region}:${userId}`).slice(0, 8);
}

function tokenMarker(credential) {
  const refresh = typeof credential?.refresh_token === "string" && credential.refresh_token ? credential.refresh_token : null;
  return refresh ? sha256Hex(refresh).slice(0, 16) : null;
}

// Kimi's own default reference omits storage/host; separate slots pin them.
function nativeOauthRef(region) {
  if (region === REGIONS.cn) return { key: "oauth/kimi-code" };
  return { storage: "file", key: "oauth/kimi-code", oauth_host: REGIONS.global.oauthHost };
}

function regionOfProvider(provider) {
  if (provider?.oauth?.oauth_host === REGIONS.global.oauthHost ||
    String(provider?.base_url || "").startsWith("https://api.kimi.ai/")) return REGIONS.global;
  return REGIONS.cn;
}

// The credential slot referenced by a provider's oauth.key; keyring-backed
// logins belong to Kimi Code itself and are never touched here.
function credentialPathFor(home, oauth) {
  const key = typeof oauth?.key === "string" && oauth.key ? oauth.key : null;
  if (!key) throw new Error("Missing Kimi OAuth reference");
  const name = key.startsWith("oauth/") ? key.slice(6) : key;
  if (!name || name.startsWith(".") || !/^[\w-]+$/.test(name)) throw new Error("Invalid Kimi OAuth credential name");
  if (oauth.storage !== undefined && oauth.storage !== "file") throw new Error("This Kimi login uses a keyring; manage it in Kimi Code");
  return path.join(home, "credentials", `${name}.json`);
}

function slotNameOf(credentialPath) {
  return path.basename(credentialPath).replace(/\.json$/, "");
}

// Kimi's cross-process lock: a directory whose mtime goes stale after 5s.
async function withSlotLock(home, slot, action) {
  if (process.platform === "win32") return action();
  const dir = path.join(home, "oauth", `${slot}.lock`);
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.mkdir(dir);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fsp.stat(dir).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs < LOCK_STALE_MS && attempt < 20) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(dir).catch(() => {});
    }
    try {
      return await action();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function createManager({
  root = paths.providerSwitchRoot(),
  home = kimi.homeOf(),
  env = process.env,
  fetchImpl = fetch,
  platform = process.platform,
  now = Date.now,
} = {}) {
  const storeFile = path.join(root, "kimi-accounts.json");
  let pending = Promise.resolve();
  let flow = null;
  const serial = (action) => {
    const next = pending.catch(() => {}).then(action);
    pending = next;
    return next;
  };

  const loadStore = async () => {
    try {
      const value = JSON.parse(await fsp.readFile(storeFile, "utf8"));
      if (!isPlainObject(value) || !isPlainObject(value.accounts) || !Array.isArray(value.dismissed)) throw new Error("shape");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, accounts: {}, dismissed: [] };
      throw new Error("Cannot read the Kimi account store");
    }
  };
  const saveStore = async (value) => {
    await fsp.mkdir(root, { recursive: true });
    await writeFileAtomic(storeFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod600IfPossible(storeFile);
  };
  const updateStore = async (change) => {
    const value = await loadStore();
    change(value);
    await saveStore(value);
  };

  const deviceId = async () => {
    const file = path.join(home, "device-id");
    try {
      const value = (await fsp.readFile(file, "utf8")).trim();
      if (/^[\w-]{8,128}$/.test(value)) return value;
    } catch { /* create below */
    }
    const value = crypto.randomUUID();
    await fsp.mkdir(home, { recursive: true });
    await writeFileAtomic(file, value, { mode: 0o600 });
    return value;
  };

  const identifyHeaders = (device) => ({
    accept: "application/json",
    "user-agent": USER_AGENT,
    "x-msh-platform": "kimi_code_cli",
    "x-msh-version": "1.0",
    "x-msh-device-id": device,
    "x-msh-device-name": "Unknown",
    "x-msh-device-model": `${os.platform()} ${os.arch()}`,
    "x-msh-os-version": os.platform(),
  });

  async function postForm(url, form, device, { token } = {}) {
    const body = new URLSearchParams(form);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { ...identifyHeaders(device), "content-type": "application/x-www-form-urlencoded", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
      signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }

  async function getJson(url, device, token) {
    const response = await fetchImpl(url, { headers: { ...identifyHeaders(device), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }

  async function fetchIdentity(baseUrl, token, device) {
    const { status, body } = await getJson(`${baseUrl.replace(/\/$/, "")}/me`, device, token);
    if (status !== 200) throw new Error(`Kimi account lookup failed (HTTP ${status})`);
    const pick = (key) => {
      const value = body[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
      return null;
    };
    const userId = pick("user_id") || pick("id");
    if (!userId) throw new Error("Kimi account lookup returned no user id");
    return { userId, nickname: pick("nickname"), avatar: pick("avatar") };
  }

  function parseCredential(payload) {
    const access = typeof payload.access_token === "string" ? payload.access_token : "";
    const refresh = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
    const seconds = Number(payload.expires_in);
    if (!access || !refresh || !(Number.isFinite(seconds) && seconds > 0 && seconds <= 31536000)) {
      throw new Error("Kimi response has no usable token");
    }
    return {
      access_token: access,
      refresh_token: refresh,
      expires_at: Math.floor(now() / 1000) + seconds,
      expires_in: seconds,
      token_type: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
      scope: typeof payload.scope === "string" ? payload.scope : "",
    };
  }

  // GET /models → native model aliases for the official node (cc-switch
  // parse_models); capability vocabulary passes through as strings.
  function parseModels(payload) {
    const data = Array.isArray(payload?.data) && payload.data.length ? payload.data : null;
    if (!data) throw new Error("No models available for Kimi Code");
    const models = {};
    for (const model of data) {
      const id = typeof model?.id === "string" && model.id ? model.id : null;
      if (!id) throw new Error("Kimi model list has no id");
      const context = Number(model?.limit?.context);
      if (!(Number.isFinite(context) && context > 0)) throw new Error(`Kimi model '${id}' has no valid context length`);
      const capabilities = [];
      if (model.supports_tool_use !== false) capabilities.push("tool_use");
      for (const [modality, capability] of [["image", "image_in"], ["video", "video_in"], ["audio", "audio_in"]]) {
        if (Array.isArray(model.modalities?.input) && model.modalities.input.includes(modality)) capabilities.push(capability);
      }
      const thinking = model.reasoning?.type;
      if (thinking === "only" || thinking === "both") capabilities.push("thinking");
      if (thinking === "only") capabilities.push("always_thinking");
      if (model.tools?.dynamic_load === true) capabilities.push("dynamically_loaded_tools");
      const alias = { provider: kimi.OFFICIAL_PROVIDER_ID, model: id, max_context_size: context, capabilities };
      if (typeof model.display_name === "string") alias.display_name = model.display_name;
      if (model.protocol === "response" || model.protocol === "anthropic") {
        alias.protocol = model.protocol === "response" ? "openai_responses" : "anthropic";
        if (model.protocol === "anthropic") {
          alias.beta_api = true;
          if (thinking === "only" || thinking === "both") alias.adaptive_thinking = true;
        }
      }
      const efforts = Array.isArray(model.reasoning?.effort?.valid)
        ? model.reasoning.effort.valid.filter((value) => typeof value === "string" && value)
        : [];
      if (efforts.length) {
        const fallback = model.reasoning.effort.default;
        if (typeof fallback === "string" && efforts.includes(fallback)) alias.default_effort = fallback;
        alias.support_efforts = efforts;
      }
      models[`kimi-code/${id}`] = alias;
    }
    return models;
  }

  // Re-scope the official catalog to the account it belongs to: separate
  // accounts carry <slot>/<model> aliases and nickname-marked display names.
  function scopeModels(models, accountId, slot, nickname) {
    const scoped = {};
    for (const [key, model] of Object.entries(models)) {
      const next = { ...model, provider: accountId };
      if (accountId === kimi.OFFICIAL_PROVIDER_ID) {
        scoped[key] = next;
        continue;
      }
      if (nickname) {
        const base = typeof model.display_name === "string" && model.display_name ? model.display_name : model.model;
        next.display_name = `${base} (${nickname})`;
      }
      scoped[`${slot}/${model.model}`] = next;
    }
    return scoped;
  }

  function readableProviderId(doc, nickname) {
    const clean = String(nickname || "").replace(/[^\p{L}\p{N}\-_ ]+/gu, " ").split(/\s+/).filter(Boolean).join(" ");
    if (!clean) return null;
    const taken = (id) => isPlainObject(doc.providers) && doc.providers[id] !== undefined;
    for (let n = 1; ; n += 1) {
      const id = n === 1 ? `Kimi Subscription ${clean}` : `Kimi Subscription ${clean} ${n}`;
      if (!taken(id)) return id;
    }
  }

  async function readConfigDoc() {
    return kimi.readDocument({ home });
  }

  // Where a finished login lands: the same account re-signs in place; an
  // explicit re-login keeps its slot for the same user; anything else is new
  // — Kimi's default slot while free, else a stable separate slot.
  async function resolveTarget(region, explicit, identity) {
    if (!identity) {
      if (explicit) return explicit;
      const doc = await readConfigDoc();
      const occupied = kimi.isOfficialProvider(doc.providers?.[kimi.OFFICIAL_PROVIDER_ID]) &&
        await credentialExists(credentialPathFor(home, doc.providers[kimi.OFFICIAL_PROVIDER_ID].oauth));
      if (occupied) {
        const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
        const slot = `kimi-code-ccs-${suffix}`;
        return { accountId: slot, oauth: { storage: "file", key: `oauth/${slot}`, oauth_host: region.oauthHost } };
      }
      return { accountId: kimi.OFFICIAL_PROVIDER_ID, oauth: nativeOauthRef(region) };
    }
    const doc = await readConfigDoc();
    const store = await loadStore();
    const suffix = accountSuffix(region.id, identity.userId);
    const separate = `kimi-code-ccs-${suffix}`;
    const separateKey = `oauth/${separate}`;
    for (const [id, provider] of Object.entries(isPlainObject(doc.providers) ? doc.providers : {})) {
      if (!kimi.isOfficialProvider(provider)) continue;
      if (regionOfProvider(provider).id !== region.id) continue;
      const known = store.accounts[id];
      if ((known && known.userId === identity.userId) || id === separate || provider.oauth?.key === separateKey) {
        return { accountId: id, oauth: provider.oauth };
      }
    }
    if (explicit) {
      const known = store.accounts[explicit.accountId];
      if (!known || known.userId === identity.userId) return explicit;
    }
    const occupied = kimi.isOfficialProvider(doc.providers?.[kimi.OFFICIAL_PROVIDER_ID]) &&
      await credentialExists(credentialPathFor(home, doc.providers[kimi.OFFICIAL_PROVIDER_ID].oauth));
    if (!occupied) return { accountId: kimi.OFFICIAL_PROVIDER_ID, oauth: nativeOauthRef(region) };
    const id = readableProviderId(doc, identity.nickname) || separate;
    return { accountId: id, oauth: { storage: "file", key: `oauth/${separate}`, oauth_host: region.oauthHost } };
  }

  async function credentialExists(file) {
    try {
      await fsp.access(file);
      return true;
    } catch {
      return false;
    }
  }

  async function readCredential(file) {
    let text;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { state: "missing" };
      throw new Error("Cannot read Kimi Code credentials");
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return { state: "revoked" };
    }
    if (!value.access_token && !value.refresh_token) return { state: "revoked" };
    return { state: "valid", value };
  }

  const accessValid = (credential) =>
    typeof credential.access_token === "string" && credential.access_token !== "" &&
    Number(credential.expires_at) > Math.floor(now() / 1000);

  // Kimi's rule: refresh once less than max(5min, half the lifetime) remains.
  const shouldRefresh = (credential) => {
    const expiresAt = Number(credential.expires_at) || 0;
    if (!expiresAt) return false;
    const lifetime = Number(credential.expires_in) || 0;
    const threshold = lifetime > 0 ? Math.max(300, lifetime / 2) : 300;
    return expiresAt - Math.floor(now() / 1000) < threshold;
  };

  const tombstone = (prior) => ({
    access_token: "", refresh_token: "", expires_at: 0, expires_in: 0,
    scope: typeof prior.scope === "string" ? prior.scope : "",
    token_type: typeof prior.token_type === "string" ? prior.token_type : "Bearer",
  });

  // A usable access token for an account's provider, refreshing under the
  // slot lock with re-read/adopt/tombstone semantics (see file header).
  async function accessTokenFor(provider, device) {
    const file = credentialPathFor(home, provider.oauth);
    const first = await readCredential(file);
    if (first.state !== "valid") return { state: first.state === "missing" ? "needsReauth" : "needsReauth", token: null };
    if (!shouldRefresh(first.value)) return { state: "ok", token: first.value.access_token };
    if (platform === "win32") {
      return accessValid(first.value) ? { state: "ok", token: first.value.access_token } : { state: "expired", token: null };
    }
    const slot = slotNameOf(file);
    return withSlotLock(home, slot, async () => {
      const current = await readCredential(file);
      if (current.state !== "valid") return { state: "needsReauth", token: null };
      if (!shouldRefresh(current.value)) return { state: "ok", token: current.value.access_token };
      const refresh = current.value.refresh_token;
      if (!refresh) return { state: "needsReauth", token: null };
      const host = typeof provider.oauth.oauth_host === "string" ? provider.oauth.oauth_host : regionOfProvider(provider).oauthHost;
      const { status, body } = await postForm(`${host}/api/oauth/token`, {
        client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refresh,
      }, device);
      if (status === 200) {
        const refreshed = parseCredential(body);
        await writeFileAtomic(file, `${JSON.stringify(refreshed, null, 2)}\n`, { mode: 0o600 });
        await chmod600IfPossible(file);
        return { state: "ok", token: refreshed.access_token };
      }
      if (status === 401 || status === 403 || body.error === "invalid_grant") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const recovered = await readCredential(file);
        if (recovered.state === "valid" && recovered.value.refresh_token !== refresh) {
          return { state: "ok", token: recovered.value.access_token };
        }
        await writeFileAtomic(file, `${JSON.stringify(tombstone(current.value), null, 2)}\n`, { mode: 0o600 });
        return { state: "needsReauth", token: null };
      }
      throw new Error(`Kimi token refresh failed (HTTP ${status})`);
    });
  }

  // Best-effort /me for accounts whose cached identity is stale, using only
  // still-valid access tokens — never refresh just for a name.
  async function identifyAccounts() {
    let doc;
    try {
      doc = await readConfigDoc();
    } catch {
      return;
    }
    const store = await loadStore().catch(() => null);
    if (!store) return;
    let device = null;
    for (const [id, provider] of Object.entries(isPlainObject(doc.providers) ? doc.providers : {})) {
      if (!kimi.isOfficialProvider(provider)) continue;
      let file;
      try {
        file = credentialPathFor(home, provider.oauth);
      } catch {
        continue;
      }
      const read = await readCredential(file).catch(() => null);
      if (!read || read.state !== "valid" || !accessValid(read.value)) continue;
      const marker = tokenMarker(read.value);
      if (store.accounts[id]?.token === marker) continue;
      if (!device) device = await deviceId().catch(() => null);
      if (!device) return;
      try {
        const identity = await fetchIdentity(provider.base_url, read.value.access_token, device);
        await updateStore((value) => {
          value.accounts[id] = { ...identity, token: marker };
        });
      } catch { /* naming is best-effort */
      }
    }
  }

  const status = () => serial(async () => {
    await identifyAccounts().catch(() => {});
    const doc = await readConfigDoc();
    const store = await loadStore();
    const accounts = [];
    for (const [id, provider] of Object.entries(isPlainObject(doc.providers) ? doc.providers : {})) {
      if (!kimi.isOfficialProvider(provider)) continue;
      const identity = store.accounts[id];
      if (store.dismissed.includes(id) || (identity && store.dismissed.includes(identity.userId))) continue;
      const region = regionOfProvider(provider);
      let account;
      try {
        const file = credentialPathFor(home, provider.oauth);
        const read = await readCredential(file);
        const expiresAt = read.state === "valid" ? Number(read.value.expires_at) || null : null;
        const hasAccess = read.state === "valid" && read.value.access_token !== "";
        const canRefresh = read.state === "valid" && read.value.refresh_token !== "";
        account = {
          id,
          name: kimi.officialProviderName(id, identity?.nickname || null),
          nickname: identity?.nickname || null,
          avatarUrl: identity?.avatar || null,
          primary: id === kimi.OFFICIAL_PROVIDER_ID,
          region: region.id,
          authenticated: canRefresh || (hasAccess && expiresAt !== null && expiresAt > Math.floor(now() / 1000)),
          expiresAt,
          error: null,
        };
      } catch (error) {
        account = {
          id, name: kimi.officialProviderName(id, identity?.nickname || null), nickname: identity?.nickname || null,
          avatarUrl: identity?.avatar || null, primary: id === kimi.OFFICIAL_PROVIDER_ID, region: region.id,
          authenticated: false, expiresAt: null, error: error.message,
        };
      }
      accounts.push(account);
    }
    const current = kimi.currentProviderKey(doc);
    return {
      accounts,
      currentAccountId: accounts.some((account) => account.id === current) ? current : null,
      primaryHidden: (() => {
        const primaryIdentity = store.accounts[kimi.OFFICIAL_PROVIDER_ID];
        return (store.dismissed.includes(kimi.OFFICIAL_PROVIDER_ID) ||
          (primaryIdentity && store.dismissed.includes(primaryIdentity.userId))) &&
          kimi.isOfficialProvider(doc.providers?.[kimi.OFFICIAL_PROVIDER_ID]);
      })(),
    };
  });

  const startLogin = (regionId, accountId = null) => serial(async () => {
    cancelFlow();
    const region = REGIONS[regionId] || REGIONS.cn;
    let target = null;
    if (accountId) {
      const doc = await readConfigDoc();
      const provider = doc.providers?.[accountId];
      if (!kimi.isOfficialProvider(provider)) throw new Error("Kimi official account not found");
      credentialPathFor(home, provider.oauth);
      const accountRegion = regionOfProvider(provider);
      const oauth = { ...provider.oauth };
      if (oauth.oauth_host !== undefined || accountRegion.id === "global") oauth.oauth_host = accountRegion.oauthHost;
      target = { accountId, oauth, region: accountRegion };
    }
    const effectiveRegion = target ? target.region : region;
    const device = await deviceId();
    const { status: code, body } = await postForm(`${effectiveRegion.oauthHost}/api/oauth/device_authorization`, { client_id: CLIENT_ID }, device);
    if (code !== 200) throw new Error(`Kimi device authorization failed (HTTP ${code})`);
    const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
    const userCode = typeof body.user_code === "string" ? body.user_code : "";
    const rawUri = typeof body.verification_uri_complete === "string" && body.verification_uri_complete ? body.verification_uri_complete : body.verification_uri;
    if (!deviceCode || !userCode || typeof rawUri !== "string" || !rawUri) throw new Error("Kimi authorization response is incomplete");
    let uri;
    try {
      uri = new URL(rawUri);
    } catch {
      throw new Error("Invalid Kimi verification URL");
    }
    if (uri.protocol !== "https:" || !uri.hostname) throw new Error("Invalid Kimi verification URL");
    const expires = Number(body.expires_in);
    const interval = Number(body.interval);
    flow = {
      id: crypto.randomUUID(),
      deviceCode,
      region: effectiveRegion,
      target,
      device,
      expiresAt: now() + (Number.isFinite(expires) && expires > 0 && expires <= 31536000 ? expires : 600) * 1000,
      intervalMs: (Number.isFinite(interval) && interval > 0 && interval <= 3600 ? interval : 5) * 1000,
      nextPollAt: 0,
      polling: false,
      identity: null,
      credential: null,
    };
    return { flowId: flow.id, userCode, verificationUri: rawUri, expiresIn: Math.round((flow.expiresAt - now()) / 1000), interval: flow.intervalMs / 1000 };
  });

  function cancelFlow() {
    if (flow) flow = null;
  }

  const pollLogin = (flowId) => serial(async () => {
    if (!flow || flow.id !== flowId) return { status: "cancelled" };
    if (now() >= flow.expiresAt) {
      flow = null;
      return { status: "expired" };
    }
    if (flow.polling || now() < flow.nextPollAt) return { status: "pending", interval: flow.intervalMs / 1000 };
    flow.polling = true;
    try {
      const outcome = await advance();
      if (!flow || flow.id !== flowId) return { status: "cancelled" };
      if (outcome.state === "pending") {
        flow.nextPollAt = now() + flow.intervalMs;
        return { status: "pending", interval: flow.intervalMs / 1000 };
      }
      if (outcome.state === "ended") {
        flow = null;
        return { status: outcome.reason };
      }
      await commit(outcome.models);
      flow = null;
      return { status: "success" };
    } catch (error) {
      // Keep the exchanged token: a retry repeats discovery/persistence only.
      if (flow) flow.polling = false;
      throw error;
    } finally {
      if (flow) flow.polling = false;
    }
  });

  async function advance() {
    flow.nextPollAt = now() + flow.intervalMs;
    if (!flow.credential) {
      const { status, body } = await postForm(`${flow.region.oauthHost}/api/oauth/token`, {
        client_id: CLIENT_ID,
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }, flow.device);
      if (status === 200) {
        flow.credential = parseCredential(body);
      } else {
        const error = typeof body.error === "string" ? body.error : "";
        if (error === "authorization_pending") return { state: "pending" };
        if (error === "slow_down") {
          flow.intervalMs += 5000;
          return { state: "pending" };
        }
        if (error === "expired_token") return { state: "ended", reason: "expired" };
        if (error === "access_denied") return { state: "ended", reason: "denied" };
        throw new Error(`Kimi token request failed (HTTP ${status})`);
      }
    }
    if (!flow.identity) {
      flow.identity = await fetchIdentity(flow.region.baseUrl, flow.credential.access_token, flow.device).catch(() => null);
    }
    const { status, body } = await getJson(`${flow.region.baseUrl.replace(/\/$/, "")}/models`, flow.device, flow.credential.access_token);
    if (status !== 200) throw new Error(`Kimi model discovery failed (HTTP ${status})`);
    return { state: "ready", models: parseModels(body) };
  }

  async function commit(models) {
    const { accountId, oauth } = await resolveTarget(flow.region, flow.target, flow.identity);
    const credentialPath = credentialPathFor(home, oauth);
    const nickname = flow.identity?.nickname || null;
    const slot = slotNameOf(credentialPath);
    const scoped = scopeModels(models, accountId, slot, nickname);
    await withSlotLock(home, slot, () => kimi.saveOauthLogin({
      accountId,
      credentialPath,
      credential: flow.credential,
      baseUrl: flow.region.baseUrl,
      oauth,
      models: scoped,
    }, { home }));
    if (flow.identity) {
      const identity = { ...flow.identity, token: tokenMarker(flow.credential) };
      await updateStore((value) => {
        value.accounts[accountId] = identity;
        const dismissedKey = identity.userId;
        value.dismissed = value.dismissed.filter((key) => key !== dismissedKey && key !== accountId);
      }).catch(() => {});
    }
  }

  const quota = (accountId) => serial(async () => {
    const doc = await readConfigDoc();
    const provider = doc.providers?.[accountId];
    if (!kimi.isOfficialProvider(provider)) {
      return { credentialStatus: "notFound", tiers: [] };
    }
    const file = credentialPathFor(home, provider.oauth);
    if (!(await credentialExists(file))) return { credentialStatus: "notFound", tiers: [] };
    const device = await deviceId();
    const access = await accessTokenFor(provider, device);
    if (access.state === "expired") {
      return { credentialStatus: "refreshPending", message: "Use this account once in Kimi Code, then refresh", tiers: [] };
    }
    if (access.state === "needsReauth") {
      return { credentialStatus: "expired", message: "Sign in again", tiers: [] };
    }
    const base = String(provider.base_url || "").replace(/\/$/, "");
    if (!base) throw new Error("Kimi account has no base URL");
    const response = await fetchImpl(`${base}/usages`, {
      headers: { authorization: `Bearer ${access.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401 || response.status === 403) {
      return { credentialStatus: "expired", message: "Sign in again", tiers: [] };
    }
    if (!response.ok) throw new Error(`Kimi quota failed (HTTP ${response.status})`);
    const body = await response.json().catch(() => null);
    if (!isPlainObject(body)) throw new Error("Unrecognized Kimi quota");
    const tiers = [];
    for (const item of Array.isArray(body.limits) ? body.limits : []) {
      const detail = isPlainObject(item.detail) ? item.detail : null;
      if (!detail) continue;
      const limit = Number(detail.limit);
      const remaining = Number(detail.remaining);
      if (!Number.isFinite(limit) || !Number.isFinite(remaining)) continue;
      const used = Math.max(0, limit - remaining);
      tiers.push({ id: "five_hour", label: "5h", usedPercent: limit > 0 ? (used / limit) * 100 : 0, resetsAt: resetTimeOf(detail.resetTime) });
    }
    if (isPlainObject(body.usage)) {
      const limit = Number(body.usage.limit);
      const remaining = Number(body.usage.remaining);
      const used = Math.max(0, limit - remaining);
      tiers.push({ id: "weekly_limit", label: "weekly", usedPercent: limit > 0 ? (used / limit) * 100 : 0, resetsAt: resetTimeOf(body.usage.resetTime) });
    }
    return { credentialStatus: "valid", tiers };
  });

  function resetTimeOf(value) {
    if (typeof value !== "string" || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  const useAccount = (accountId) => serial(async () => {
    const doc = await readConfigDoc();
    const provider = doc.providers?.[accountId];
    if (!kimi.isOfficialProvider(provider)) throw new Error("Kimi official account not found");
    const read = await readCredential(credentialPathFor(home, provider.oauth));
    const usable = read.state === "valid" && (read.value.refresh_token !== "" || accessValid(read.value));
    if (!usable) throw new Error("Sign in to Kimi Code first");
    return kimi.useOauthAccount(accountId, { home });
  });

  // Separate accounts lose provider node, models and (ccs-owned) credential.
  // Kimi's own default login is only hidden — AiTool never logs Kimi out.
  const remove = (accountId) => serial(async () => {
    if (flow?.target?.accountId === accountId) cancelFlow();
    const doc = await readConfigDoc();
    const provider = doc.providers?.[accountId];
    if (!kimi.isOfficialProvider(provider)) throw new Error("Kimi official account not found");
    if (accountId === kimi.OFFICIAL_PROVIDER_ID) {
      const store = await loadStore();
      const key = store.accounts[accountId]?.userId || accountId;
      await updateStore((value) => {
        if (!value.dismissed.includes(key)) value.dismissed.push(key);
      });
      return { id: accountId, dismissed: true };
    }
    const file = credentialPathFor(home, provider.oauth);
    const owned = slotNameOf(file).startsWith("kimi-code-ccs-");
    await kimi.removeOauthAccount(accountId, { home });
    if (owned) {
      await withSlotLock(home, slotNameOf(file), async () => {
        await fsp.unlink(file).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      });
    }
    await updateStore((value) => {
      delete value.accounts[accountId];
    });
    return { id: accountId };
  });

  return {
    status,
    startLogin,
    pollLogin: (flowId) => pollLogin(flowId),
    cancel: () => { cancelFlow(); },
    quota,
    useAccount,
    remove,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

let manager;
module.exports = {
  REGIONS,
  CLIENT_ID,
  accountSuffix,
  credentialPathFor,
  createManager,
  manager: () => manager ||= createManager(),
};
