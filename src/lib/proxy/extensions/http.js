"use strict";
const http = require("node:http");
const https = require("node:https");
// Native agents bypass HTTP(S)_PROXY; redirects never receive credentials.
function request(url, { method = "GET", headers = {}, body, signal, maxBytes = 4 * 1024 * 1024, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) return reject(new Error("Invalid upstream URL"));
    const req = (target.protocol === "https:" ? https : http).request(target, { method, headers, signal, agent: false, timeout }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return reject(new Error("Upstream redirect refused")); }
      let size = 0; const buffers = [];
      res.on("data", chunk => { size += chunk.length; if (size > maxBytes) res.destroy(new Error("Upstream response too large")); else buffers.push(chunk); });
      res.on("error", reject); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(buffers) }));
    });
    req.on("timeout", () => req.destroy(new Error("Upstream timeout"))); req.on("error", reject);
    req.end(body);
  });
}
async function json(url, options) {
  const response = await request(url, options);
  if (response.status < 200 || response.status >= 300) throw new Error(`Upstream HTTP ${response.status}`);
  try { return JSON.parse(response.body); } catch { throw new Error("Invalid upstream JSON"); }
}
module.exports = { request, json };
