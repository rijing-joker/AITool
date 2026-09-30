"use strict";

// AITOOL_BIND_HOST support (Docker / reverse-proxy deployments): the serve
// command and the proxy bootstrap config must follow the override while the
// default stays loopback-only.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const YAML = require("yaml");
const { test, beforeEach, afterEach } = require("node:test");

let tmpHome;
let prevHome;
let prevUserProfile;
const prevBindHost = process.env.AITOOL_BIND_HOST;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-bind-host-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.AITOOL_BIND_HOST;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevBindHost === undefined) delete process.env.AITOOL_BIND_HOST;
  else process.env.AITOOL_BIND_HOST = prevBindHost;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function freshServe() {
  delete require.cache[require.resolve("../src/commands/serve")];
  return require("../src/commands/serve");
}

function freshProxyConfig() {
  // proxy/paths resolves ~/.aitool at require time — reload both after HOME
  // changes so every test sees its own temp directory.
  delete require.cache[require.resolve("../src/lib/proxy/paths")];
  delete require.cache[require.resolve("../src/lib/proxy/config")];
  return require("../src/lib/proxy/config");
}

function readConfigHost() {
  const configPath = path.join(tmpHome, ".aitool", "proxy", "config.yaml");
  if (!fs.existsSync(configPath)) return null;
  return YAML.parse(fs.readFileSync(configPath, "utf8"))?.server?.host ?? null;
}

function writeConfigHost(host) {
  const configPath = path.join(tmpHome, ".aitool", "proxy", "config.yaml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify({ "config-version": 8, server: { host, port: 8318 } }));
}

test("resolveBindHost: loopback default, AITOOL_BIND_HOST override, whitespace ignored", () => {
  const serve = freshServe();
  assert.equal(serve.resolveBindHost({}), "127.0.0.1");
  assert.equal(serve.resolveBindHost({ AITOOL_BIND_HOST: "" }), "127.0.0.1");
  assert.equal(serve.resolveBindHost({ AITOOL_BIND_HOST: "   " }), "127.0.0.1");
  assert.equal(serve.resolveBindHost({ AITOOL_BIND_HOST: "0.0.0.0" }), "0.0.0.0");
  assert.equal(serve.resolveBindHost({ AITOOL_BIND_HOST: "192.168.1.10" }), "192.168.1.10");
  assert.equal(serve.resolveBindHost(process.env), "127.0.0.1");
});

test("proxy config: default bootstrap stays loopback-only", () => {
  const config = freshProxyConfig();
  config.ensureConfig();
  assert.equal(readConfigHost(), "127.0.0.1");
});

test("proxy config: AITOOL_BIND_HOST applies to fresh bootstrap and reconciles existing config", () => {
  process.env.AITOOL_BIND_HOST = "0.0.0.0";

  let config = freshProxyConfig();
  config.ensureConfig();
  assert.equal(readConfigHost(), "0.0.0.0", "fresh bootstrap follows the override");

  // A config.yaml carried over from a loopback-only host must follow the
  // override instead of silently keeping the container unreachable.
  writeConfigHost("127.0.0.1");
  config = freshProxyConfig();
  config.ensureConfig();
  assert.equal(readConfigHost(), "0.0.0.0", "existing config reconciled to the override");

  // Without the override an existing host value is never touched.
  delete process.env.AITOOL_BIND_HOST;
  writeConfigHost("127.0.0.1");
  config = freshProxyConfig();
  config.ensureConfig();
  assert.equal(readConfigHost(), "127.0.0.1", "no override: existing host untouched");
});
