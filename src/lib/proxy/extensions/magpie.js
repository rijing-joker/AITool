"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const state = require("../managed-upstream");
const direct = require("./http");
function directory(options = {}) {
  const env = options.env || process.env, home = options.home || os.homedir();
  const root = options.magpieDir || env.AITOOL_MAGPIE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "magpie");
  if (!path.isAbsolute(root)) throw new Error("Magpie config directory must be absolute"); return root;
}
async function audit(options = {}) {
  const root = directory(options);
  let settings, providers, settingsRaw, providersRaw;
  try {
    [settingsRaw, providersRaw] = await Promise.all([fs.readFile(path.join(root, "settings.json"), "utf8"), fs.readFile(path.join(root, "providers.json"), "utf8")]);
    if (settingsRaw.length + providersRaw.length > 8 * 1024 * 1024) throw new Error();
    settings = JSON.parse(settingsRaw); providers = JSON.parse(providersRaw);
  } catch { throw new Error("Magpie settings/providers cannot be audited; install and configure Magpie first"); }
  const port = settings.port || 3425, corePort = options.corePort || require("../config").getServerPort();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === corePort || port === (await state.settings(options)).port) throw new Error("Magpie endpoint would create a local proxy loop");
  if (!Array.isArray(providers.providers)) throw new Error("Unrecognized Magpie provider structure");
  const extensionPort = (await state.settings(options)).port;
  for (const provider of providers.providers) {
    if (provider.disabled === true) continue;
    for (const key of ["chat", "responses", "anthropic", "gemini"]) {
      if (!provider[key]) continue;
      let url; try { url = new URL(provider[key]); } catch { throw new Error("Invalid Magpie provider URL"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Magpie provider URL");
      // Fail closed without DNS/network probes during status reads. A hostname
      // can resolve to any local interface, so protected listener ports are
      // reserved regardless of host. Use a distinct port for remote gateways.
      if ([corePort, extensionPort, port].includes(Number(url.port || (url.protocol === "https:" ? 443 : 80)))) throw new Error("Magpie provider uses an AiTool or Magpie listener port; choose a distinct upstream port to prevent loops");
    }
  }
  return { port, root, revision: crypto.createHash("sha256").update(settingsRaw).update(providersRaw).digest("hex") };
}
async function discover(options = {}) {
  const check = await audit(options), base = `http://127.0.0.1:${check.port}`;
  const hello = await direct.json(`${base}/api/hello`);
  if (hello.name !== "magpie") throw new Error("The detected service is not Magpie");
  const catalog = await direct.json(`${base}/v1/models`, { headers: { authorization: "Bearer magpie-aitool" } });
  const seen = new Set();
  const models = (catalog.data || []).flatMap(row => {
    if (typeof row.id !== "string" || !row.id || row.id.length > 256 || /[\x00-\x1f]/.test(row.id) || seen.has(row.id)) return [];
    seen.add(row.id); return [{ id: row.id, name: String(row.display_name || row.id).slice(0, 256), reasoning: row.reasoning === true, images: row.modalities?.input?.includes("image") === true }];
  });
  if (!models.length || models.length > 1000) throw new Error("Magpie has no usable model catalog");
  if ((await audit(options)).revision !== check.revision) throw new Error("Magpie configuration changed during discovery");
  return { ...check, version: String(hello.version || "").slice(0, 64), models };
}
async function status(options = {}) {
  const config = await state.settings(options), value = config.magpie;
  let error = null;
  if (value) try { if ((await audit(options)).revision !== value.revision) error = "Magpie configuration changed; rediscover before sending more requests"; } catch (failure) { error = failure.message; }
  return { enabled: config.enabled.magpie === true, models: value?.models || [], directory: directory(options), error, protocol: "chat", accounting: "core" };
}
async function configure(input, options = {}) {
  if (typeof input.enabled !== "boolean") throw new Error("enabled must be boolean");
  const runtime = options.runtime || require("./runtime");
  if (!input.enabled) {
    await state.configure("aitool-magpie", null, options);
    await state.saveSettings(value => ({ ...value, enabled: { ...value.enabled, magpie: false } }), options); return status(options);
  }
  const found = await discover(options);
  if (found.revision !== input.revision) throw new Error("Magpie discovery is stale; rediscover models");
  if (!Array.isArray(input.models) || !input.models.length || input.models.length > 100 || input.models.some(id => !found.models.some(row => row.id === id))) throw new Error("Select discovered Magpie models");
  const port = await runtime.start(options), config = await state.settings(options);
  const models = [...new Set(input.models)];
  await state.configure("aitool-magpie", { "base-url": `http://127.0.0.1:${port}/magpie/v1`, keys: [{ "api-key": config.token, "proxy-url": "direct" }], models: models.map(id => ({ name: id, alias: id })) }, options);
  await state.saveSettings(value => ({ ...value, enabled: { ...value.enabled, magpie: true }, magpie: { port: found.port, models, revision: found.revision } }), options);
  return status(options);
}
async function forward({ req: incoming, res, body, signal, options, pipeline }) {
  const config = await state.settings(options), target = config.magpie;
  if (!target?.models.includes(body.model)) throw new Error("Magpie model not selected");
  const auditResult = await audit(options);
  if (auditResult.revision !== target.revision || auditResult.port !== target.port) throw new Error("Magpie configuration changed");
  await new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${target.port}/v1/chat/completions`, { method: "POST", signal, agent: false,
      headers: { authorization: "Bearer magpie-aitool", "content-type": "application/json", "user-agent": "AiTool/1", "x-aitool-extension-hop": "1",
        ...(typeof incoming?.headers?.["x-magpie-session"] === "string" && incoming.headers["x-magpie-session"].length <= 128 ? { "x-magpie-session": incoming.headers["x-magpie-session"] } : {}) } }, upstream => {
      if (upstream.statusCode >= 300 && upstream.statusCode < 400) { upstream.resume(); return reject(new Error("Magpie redirect refused")); }
      if (upstream.statusCode >= 400) {
        upstream.resume(); res.writeHead(upstream.statusCode, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: `magpie_http_${upstream.statusCode}`, message: "Magpie refused this request; check its provider and routing settings" } })); resolve(); return;
      }
      res.writeHead(upstream.statusCode, { "content-type": upstream.headers["content-type"] || "application/json" });
      pipeline(upstream, res, { signal }).then(resolve, reject);
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
}
module.exports = { directory, audit, discover, status, configure, forward };
