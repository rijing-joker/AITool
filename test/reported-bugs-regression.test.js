const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { parseGeminiIncremental, parseOpencodeIncremental } = require("../src/lib/rollout");
const { updateJsonLocked } = require("../src/lib/fs");
const { getOrCreateMachineId } = require("../src/lib/machine-id");
const toml = require("../src/lib/provider-switch/toml");
const { projectCodex } = require("../src/lib/provider-switch/targets");

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-regression-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function rows(file) {
  return (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}
function message(id, input) {
  return { id, model: "gemini-3-flash-preview", timestamp: "2026-09-30T08:05:00Z", tokens: { input, output: 5, total: input + 5 } };
}

for (const failProject of [false, true]) {
  test(`parser cursor transaction retries a failed ${failProject ? "project" : "hourly"} append`, async (t) => {
    const dir = await temp(t);
    await fs.mkdir(path.join(dir, ".git"));
    await fs.writeFile(path.join(dir, ".git/config"), '[remote "origin"]\nurl = https://github.com/acme/repo.git\n');
    const session = path.join(dir, "session.json");
    const queuePath = path.join(dir, "queue.jsonl");
    const projectQueuePath = path.join(dir, "project.jsonl");
    const cursors = {};
    const options = { sessionFiles: [session], cursors, queuePath, projectQueuePath,
      publicRepoResolver: async ({ projectRef }) => ({ status: "public_verified", projectKey: "acme/repo", projectRef }) };
    await fs.writeFile(session, JSON.stringify({ messages: [message("m1", 10)] }));
    await parseGeminiIncremental(options);
    const baseline = structuredClone(cursors);
    await fs.writeFile(session, JSON.stringify({ messages: [message("m1", 10), message("m2", 30)] }));
    const append = fs.appendFile;
    const mocked = t.mock.method(fs, "appendFile", async (file, ...args) => {
      if (file === (failProject ? projectQueuePath : queuePath)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return append(file, ...args);
    });
    await assert.rejects(parseGeminiIncremental(options), /disk full/);
    assert.deepEqual(cursors, baseline, "neither file offsets nor shared buckets may commit early");
    mocked.mock.restore();
    await parseGeminiIncremental(options);
    assert.equal((await rows(queuePath)).at(-1).input_tokens, 30);
    assert.equal((await rows(projectQueuePath)).at(-1).input_tokens, 30);
    const again = await parseGeminiIncremental(options);
    assert.equal(again.bucketsQueued, 0);
    assert.equal(again.projectBucketsQueued, 0);
  });
}

test("Gemini retains counted messages across transcript truncation and atomic replacement", async (t) => {
  const dir = await temp(t);
  const session = path.join(dir, "session.json");
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};
  const options = { sessionFiles: [session], cursors, queuePath };
  const messages = [message("m1", 10), message("m2", 30)];
  await fs.writeFile(session, JSON.stringify({ messages }));
  await parseGeminiIncremental(options);
  await fs.writeFile(session, JSON.stringify({ messages: messages.slice(0, 1) }));
  assert.equal((await parseGeminiIncremental(options)).eventsAggregated, 0);
  await fs.writeFile(`${session}.new`, JSON.stringify({ messages }));
  await fs.rename(`${session}.new`, session);
  assert.equal((await parseGeminiIncremental(options)).eventsAggregated, 0);
  assert.equal((await rows(queuePath)).at(-1).input_tokens, 30);
  await fs.writeFile(session, JSON.stringify({ messages: [messages[1]] }));
  assert.equal((await parseGeminiIncremental(options)).eventsAggregated, 0);
  await fs.writeFile(session, JSON.stringify({ messages: [messages[0], message("m3", 40)] }));
  await parseGeminiIncremental(options);
  assert.equal((await rows(queuePath)).at(-1).input_tokens, 40);
});

test("OpenCode JSON downward corrections replace the prior message contribution", async (t) => {
  const dir = await temp(t);
  const file = path.join(dir, "msg.json");
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};
  const msg = { id: "m1", sessionID: "s1", modelID: "gpt-5.4", time: { created: Date.parse("2026-09-30T08:00:00Z") }, tokens: { input: 100, output: 20, cache: { read: 0, write: 0 } } };
  await fs.writeFile(file, JSON.stringify(msg));
  await parseOpencodeIncremental({ messageFiles: [file], cursors, queuePath });
  msg.tokens.input = 60;
  await fs.writeFile(file, JSON.stringify(msg));
  await parseOpencodeIncremental({ messageFiles: [file], cursors, queuePath });
  const latest = (await rows(queuePath)).at(-1);
  assert.equal(latest.input_tokens, 60);
  assert.equal(latest.output_tokens, 20);
  assert.equal(latest.conversation_count, 1);
});

test("Gemini upgrades index-only cursors without replaying their counted prefix", async (t) => {
  const dir = await temp(t);
  const session = path.join(dir, "session.json");
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};
  const options = { sessionFiles: [session], cursors, queuePath };
  await fs.writeFile(session, JSON.stringify({ messages: [message("m1", 10)] }));
  await parseGeminiIncremental(options);
  delete cursors.files[session].seenMessages;
  await fs.writeFile(`${session}.new`, JSON.stringify({ messages: [message("m1", 10), message("m2", 30)] }));
  await fs.rename(`${session}.new`, session);
  await parseGeminiIncremental(options);
  assert.equal((await rows(queuePath)).at(-1).input_tokens, 30);
  assert.equal((await parseGeminiIncremental(options)).bucketsQueued, 0);
});

test("TOML projections preserve arrays, multiline strings, and unrelated array tables", () => {
  const original = 'notify = [\n  ["nested", "array"],\n]\nnotes = """\n[model_providers.custom]\n"""\n[model_providers.custom]\nbase_url = "old"\n[[agents]]\nname = "keep"\n';
  const keyed = toml.setTopLevelKey(original, "model", "gpt-5.4");
  assert.ok(keyed.startsWith('notify = [\n  ["nested", "array"],\n]\n'));
  assert.ok(keyed.includes('"""\nmodel = "gpt-5.4"\n[model_providers.custom]'));
  const next = toml.setTable(keyed, "model_providers.custom", { base_url: "new" });
  assert.ok(next.includes('notes = """\n[model_providers.custom]\n"""'));
  assert.ok(next.includes('[[agents]]\nname = "keep"'));
  assert.equal(toml.getTableEntries(next, "model_providers.custom").base_url, "new");
  assert.ok(toml.setTable(next, "model_providers.custom", null).includes('[[agents]]\nname = "keep"'));
});

test("Codex switching preserves unowned tables and projects structured credentials", () => {
  const liveToml = '[model_providers.custom]\nbase_url = "user-owned"\n';
  assert.equal(projectCodex({ liveToml, target: { category: "official", settingsConfig: {} } }).configToml, liveToml);
  const headers = { Authorization: "Bearer fixture", "X-Api-Key": "key\nline" };
  const result = projectCodex({ liveToml, target: { settingsConfig: { config: { model_providers: { custom: { base_url: "https://example.test", http_headers: headers } } } } } });
  const table = toml.getTableEntries(result.configToml, "model_providers.custom");
  assert.deepEqual(table.http_headers, headers);
  assert.equal(table.requires_openai_auth, undefined);
});

test("JSON updates preserve corrupt files and serialize identity with device-token writes", async (t) => {
  const dir = await temp(t);
  const config = path.join(dir, "config.json");
  await fs.writeFile(config, '{"deviceToken":"keep",');
  await assert.rejects(updateJsonLocked(config, (current) => ({ ...current, cloudSync: true })), SyntaxError);
  assert.equal(await fs.readFile(config, "utf8"), '{"deviceToken":"keep",');
  await fs.writeFile(config, '{"baseUrl":"https://example.test"}');
  const [machineId] = await Promise.all([
    getOrCreateMachineId(path.join(dir, "queue.jsonl"), { seedPath: path.join(dir, "seed"), stableMachineId: "stable-fixture-id" }),
    updateJsonLocked(config, (current) => ({ ...current, deviceToken: "fresh-token" })),
  ]);
  assert.deepEqual(JSON.parse(await fs.readFile(config, "utf8")), { baseUrl: "https://example.test", machineId, deviceToken: "fresh-token" });
});

test("Skills JWT verification accepts RS256 without a legacy secret and rejects tampering", async () => {
  const source = await fs.readFile(path.join(__dirname, "../dashboard/edge-patches/tokentracker-account-skills.ts"), "utf8");
  const body = source.slice(source.indexOf("function b64urlToBytes"), source.indexOf("function cleanText"));
  const js = require("esbuild").transformSync(body, { loader: "ts" }).code;
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = { JWT_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }) };
  const verify = new Function("crypto", "Deno", "atob", "TextEncoder", "TextDecoder", `${js}; return verifiedUserIdFromJwt;`)(crypto.webcrypto, { env: { get: (key) => env[key] } }, atob, TextEncoder, TextDecoder);
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "fixture-user", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url");
  assert.equal(await verify(`Bearer ${data}.${signature}`), "fixture-user");
  assert.equal(await verify(`Bearer ${header}.${Buffer.from('{"sub":"other"}').toString("base64url")}.${signature}`), null);
});

test("context day keys and metadata scans use positive-east offsets", () => {
  const { timestampDayKey, isConservativeRangeCandidate } = require("../src/lib/codex-rollout-parser");
  assert.equal(timestampDayKey("2026-09-30T16:30:00Z", { offsetMinutes: 480 }), "2026-10-01");
  assert.equal(timestampDayKey("2026-10-01T02:00:00Z", { offsetMinutes: -420 }), "2026-09-30");
  const touched = Date.parse("2026-09-30T16:30:00Z");
  assert.equal(isConservativeRangeCandidate("/sessions/2026/09/30/rollout.jsonl", { mtimeMs: touched, ctimeMs: touched }, { from: "2026-10-01", to: "2026-10-01", timeZoneContext: { offsetMinutes: 480 } }), true);
});

test("health probes cancel open SSE bodies on success and size errors", async (t) => {
  const { probe } = require("../src/lib/proxy/provider-health");
  for (const oversized of [false, true]) {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(oversized ? "x".repeat(300_000) : 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')); },
      cancel() { cancelled = true; },
    });
    const mock = t.mock.method(global, "fetch", async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const result = probe({ url: "https://example.test", protocol: "openai-chat", data: "{}" });
    if (oversized) await assert.rejects(result, /within the limit/);
    else assert.ok((await result).firstTokenLatencyMs > 0);
    assert.equal(cancelled, true);
    mock.mock.restore();
  }
});

test("project purge rejects write failures without changing cursors or retaining temp files", async (t) => {
  const dir = await temp(t);
  const queue = path.join(dir, "projects.jsonl");
  await fs.writeFile(queue, '{"project_key":"keep"}\n');
  const state = { buckets: { "drop|codex|hour": { totals: {} } } };
  const baseline = structuredClone(state);
  const { Writable } = require("node:stream");
  t.mock.method(require("node:fs"), "createWriteStream", () => new Writable({ write(_chunk, _encoding, callback) { callback(new Error("disk full")); } }));
  await assert.rejects(require("../src/lib/project-usage-purge").purgeProjectUsage({ projectKey: "drop", projectQueuePath: queue, projectQueueStatePath: path.join(dir, "state.json"), projectState: state }), /disk full/);
  assert.deepEqual(state, baseline);
  assert.deepEqual(await fs.readdir(dir), ["projects.jsonl"]);
});


test("quoted dotted sibling tables are not children of the managed provider", () => {
  const text = '[model_providers.custom]\nbase_url = "old"\n[model_providers."custom.backup"]\nbase_url = "keep"\n';
  assert.ok(toml.setTable(text, "model_providers.custom", null).includes('[model_providers."custom.backup"]\nbase_url = "keep"'));
});
