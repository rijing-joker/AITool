"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const copilot = require("../src/lib/proxy/copilot");
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-copilot-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const options = { home, env: {}, platform: "linux", port: 12345, executable: "/opt/bin/copilot", commandRunner: async () => ({ status: 0, stdout: "GitHub Copilot CLI 1.0.0" }) };
  return { home, options };
}
test("CLI updates preserve custom fields and restore the first image after key rotation", async (t) => {
  const { options } = await fixture(t);
  const files = copilot.locations("cli", options);
  await fs.mkdir(path.dirname(files.target), { recursive: true });
  await fs.writeFile(files.target, JSON.stringify({ custom: "keep", model: "previous" }));
  await copilot.connect("cli", { apiKey: "fixture-key", model: "first" }, options);
  await copilot.connect("cli", { apiKey: "rotated-key", model: "second" }, options);
  const value = JSON.parse(await fs.readFile(files.target));
  assert.equal(value.custom, "keep"); assert.equal(value.baseUrl, "http://127.0.0.1:12345/v1");
  const statuses = await copilot.status(options);
  assert.equal(statuses[0].model, "second"); assert.doesNotMatch(JSON.stringify(statuses), /fixture-key|rotated-key/);
  value.userAdded = true; await fs.writeFile(files.target, JSON.stringify(value));
  await copilot.restore("cli", options);
  assert.deepEqual(JSON.parse(await fs.readFile(files.target)), { custom: "keep", model: "previous", userAdded: true });
});
test("restoration protects provider fields edited outside AiTool", async (t) => {
  const { options } = await fixture(t);
  await copilot.connect("cli", { apiKey: "fixture-key", model: "first" }, options);
  const files = copilot.locations("cli", options);
  const value = JSON.parse(await fs.readFile(files.target)); value.model = "user-edit";
  await fs.writeFile(files.target, JSON.stringify(value));
  await assert.rejects(copilot.restore("cli", options), /COPILOT_CONFIG_CONFLICT/);
  assert.equal(JSON.parse(await fs.readFile(files.target)).model, "user-edit");
});
test("VS Code native handoff is private, nonce checked, cached and removes temporary files", async (t) => {
  const { options } = await fixture(t);
  const files = copilot.locations("vscode", options);
  const other = { name: "User provider", vendor: "openai", apiKey: "${input:user-key}" };
  await fs.mkdir(path.dirname(files.target), { recursive: true }); await fs.writeFile(files.target, JSON.stringify([other]));
  let setups = 0;
  options.executable = "/opt/bin/code";
  options.commandRunner = async (_cmd, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "1.141.0\ncommit\nx64" };
    setups++;
    assert.equal(args[0], "--new-window"); assert.doesNotMatch(args.join(" "), /fixture-key|install-extension/);
    const helper = args[1].slice("--extensionDevelopmentPath=".length);
    const directory = path.dirname(helper);
    const requestPath = path.join(directory, "request.json");
    const request = JSON.parse(await fs.readFile(requestPath));
    assert.equal(request.configPath, files.target); assert.equal(request.apiKey, "fixture-key");
    assert.equal((await fs.stat(requestPath)).mode & 0o777, 0o600);
    await fs.writeFile(path.join(directory, "response.json"), JSON.stringify({ id: request.id, secretReference: "${input:chat.lm.secret.native}" }));
    return { status: 0 };
  };
  await copilot.connect("vscode", { apiKey: "fixture-key", model: "model-1", contextWindow: 200000, vision: true }, options);
  const groups = JSON.parse(await fs.readFile(files.target));
  assert.deepEqual(groups[0], other); assert.equal(groups[1].apiKey, "${input:chat.lm.secret.native}");
  assert.equal(groups[1].models[0].contextWindow, 200000); assert.equal(groups[1].models[0].vision, true);
  assert.doesNotMatch(await fs.readFile(files.credential, "utf8"), /fixture-key/);
  assert.equal((await fs.readdir(files.state)).some((name) => name.startsWith("setup-")), false);
  await copilot.connect("vscode", { apiKey: "fixture-key", model: "model-2" }, options);
  assert.equal(setups, 1);
  await copilot.restore("vscode", options); assert.deepEqual(JSON.parse(await fs.readFile(files.target)), [other]);
});
test("VS Code setup failure cleans plaintext and masks native errors", async (t) => {
  const { options } = await fixture(t);
  const files = copilot.locations("vscode", options);
  options.executable = "/opt/bin/code";
  options.commandRunner = async (_cmd, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "1.141.0" };
    const directory = path.dirname(args[1].slice("--extensionDevelopmentPath=".length));
    const request = JSON.parse(await fs.readFile(path.join(directory, "request.json")));
    await fs.writeFile(path.join(directory, "response.json"), JSON.stringify({ id: request.id, error: "fixture-secret" }));
    return { status: 0 };
  };
  await assert.rejects(copilot.connect("vscode", { apiKey: "fixture-key", model: "model" }, options), { message: "COPILOT_SETUP_FAILED" });
  assert.equal((await fs.readdir(files.state)).some((name) => name.startsWith("setup-")), false);
  await assert.rejects(fs.stat(files.target), { code: "ENOENT" });
});
test("launcher sets isolated provider env, passes arguments and never exposes the key in argv", async (t) => {
  const { options } = await fixture(t);
  await copilot.connect("cli", { apiKey: "fixture-key", model: "model" }, options);
  options.env = { COPILOT_PROVIDER_BEARER_TOKEN: "bad", COPILOT_PROVIDER_HEADERS: "bad" };
  options.spawn = (binary, args, opts) => {
    assert.equal(binary, "/opt/bin/copilot"); assert.deepEqual(args, ["--resume", "session"]);
    assert.equal(opts.env.COPILOT_PROVIDER_API_KEY, "fixture-key"); assert.equal(opts.env.COPILOT_PROVIDER_WIRE_API, "completions");
    assert.equal(opts.env.COPILOT_PROVIDER_BEARER_TOKEN, undefined); assert.equal(opts.env.COPILOT_PROVIDER_HEADERS, undefined);
    const child = new EventEmitter(); setImmediate(() => child.emit("exit", 7)); return child;
  };
  assert.equal(await copilot.launch(["--resume", "session"], options), 7);
});
test("catalog uses direct loopback HTTP despite an outbound proxy and never follows redirects", async (t) => {
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/v1/models"); assert.equal(req.headers.authorization, "Bearer fixture-key");
    res.end(JSON.stringify({ data: [{ id: "model" }, { id: "model" }, { id: 123 }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const previous = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://127.0.0.1:1";
  t.after(() => { if (previous === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previous; });
  assert.deepEqual(await copilot.models({ apiKey: "fixture-key" }, { port: server.address().port }), ["model"]);
  server.removeAllListeners("request");
  server.on("request", (_req, res) => { res.writeHead(302, { Location: "http://127.0.0.1:1" }); res.end(); });
  await assert.rejects(copilot.models({ apiKey: "fixture-key" }, { port: server.address().port }), /catalog is unavailable/);
});
test("CLI connect re-reads external edits made during the executable probe", async (t) => {
  const { options } = await fixture(t);
  const files = copilot.locations("cli", options);
  await fs.mkdir(path.dirname(files.target), { recursive: true });
  await fs.writeFile(files.target, '{"custom":"before"}');
  options.commandRunner = async () => {
    await fs.writeFile(files.target, '{"custom":"after"}');
    return { status: 0, stdout: "GitHub Copilot CLI 1.0.0" };
  };
  await copilot.connect("cli", { apiKey: "fixture-key", model: "model" }, options);
  assert.equal(JSON.parse(await fs.readFile(files.target)).custom, "after");
});
test("invalid credential JSON returns a safe error without source snippets", async (t) => {
  const { options } = await fixture(t);
  const files = copilot.locations("cli", options);
  await fs.mkdir(files.state, { recursive: true });
  await fs.writeFile(files.baseline, '{"secret":"fixture-secret" invalid}');
  await assert.rejects(copilot.connect("cli", { apiKey: "fixture-key", model: "model" }, options), { message: "Copilot configuration contains invalid JSON." });
});
test("restoration recovers a journaled target replacement before commit", async (t) => {
  const { options } = await fixture(t);
  const files = copilot.locations("cli", options);
  await copilot.connect("cli", { apiKey: "fixture-key", model: "model" }, options);
  const baseline = JSON.parse(await fs.readFile(files.baseline));
  baseline.pendingApplied = baseline.applied; delete baseline.applied;
  await fs.writeFile(files.baseline, JSON.stringify(baseline));
  assert.equal((await copilot.restore("cli", options)).restored, true);
  await assert.rejects(fs.stat(files.target), { code: "ENOENT" });
});
test("Windows npm shim launches its fixed script directly with literal metacharacters", async (t) => {
  const { home, options } = await fixture(t);
  const bin = path.join(home, "bin with spaces"), target = path.join(bin, "node_modules", "copilot", "index.js");
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, "");
  const binary = path.join(bin, "copilot.cmd"), runtime = path.join(bin, "node.exe");
  await fs.writeFile(binary, '"%dp0%\\node_modules\\copilot\\index.js" %*'); await fs.writeFile(runtime, "");
  options.platform = "win32"; options.executable = binary;
  await copilot.connect("cli", { apiKey: "fixture-key", model: "model" }, options);
  options.spawn = (command, args, opts) => {
    assert.equal(command, runtime); assert.deepEqual(args, [target, "--prompt", "a & b | c %PATH%"]);
    assert.equal(opts.shell, false); assert.equal(opts.env.COPILOT_PROVIDER_API_KEY, "fixture-key");
    const child = new EventEmitter(); setImmediate(() => child.emit("exit", 0)); return child;
  };
  assert.equal(await copilot.launch(["--prompt", "a & b | c %PATH%"], options), 0);
  await fs.writeFile(binary, '"%dp0%\\..\\outside.js" %*');
  await assert.rejects(copilot.launch([], options), /Invalid Copilot CLI launcher/);
});
