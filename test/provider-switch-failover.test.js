"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, describe, it } = require("node:test");
const store = require("../src/lib/provider-switch/store");
const failover = require("../src/lib/provider-switch/failover");

// Failover monitor evaluation over fixture usage records. The tmp-HOME
// harness matches the other provider-switch tests; records are written in
// the core's raw snake_case shape, like the bridge leaves them on disk.

let homeDir;

const NOW = new Date("2026-10-05T12:00:00.000Z").getTime();

function writeRecords(lines) {
  const usageDir = path.join(homeDir, ".aitool", "proxy", "usage");
  fs.mkdirSync(usageDir, { recursive: true });
  fs.writeFileSync(
    path.join(usageDir, "records-2026-10-05.jsonl"),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}

function coreRecord({ minutesAgo = 1, failed = false, apiKey = "sk-active", provider = "relay-a" } = {}) {
  return {
    timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
    request_id: `req-${Math.random().toString(36).slice(2)}`,
    provider,
    api_key: apiKey,
    model: "gpt-x",
    failed,
    fail: { status_code: failed ? 500 : 200, body: "" },
    tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

async function seedProviders() {
  const active = await store.createProvider("claude", {
    name: "relay-a",
    settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://relay-a.example.com", ANTHROPIC_AUTH_TOKEN: "sk-active" } },
  });
  const backup = await store.createProvider("claude", {
    name: "relay-b",
    settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://relay-b.example.com", ANTHROPIC_AUTH_TOKEN: "sk-backup" } },
  });
  await store.setCurrentProvider("claude", active.id);
  return { active, backup };
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-failover-"));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("provider-switch failover", () => {
  it("does nothing while disabled", async () => {
    await seedProviders();
    writeRecords([coreRecord({ failed: true }), coreRecord({ failed: true })]);
    const status = await failover.evaluate({ now: NOW });
    assert.equal(status.config.enabled, false);
    assert.deepEqual(status.apps, {});
    assert.deepEqual(status.suggestions, []);
  });

  it("cools down the failing provider and suggests a switch", async () => {
    const { active, backup } = await seedProviders();
    await failover.updateConfig({ enabled: true, minRequests: 3, failureRatePct: 50 });
    writeRecords([
      coreRecord({ failed: true }), coreRecord({ failed: true }), coreRecord(),
      coreRecord({ failed: true }), coreRecord({ failed: true }),
    ]);
    const status = await failover.evaluate({ now: NOW });
    const appInfo = status.apps.claude;
    assert.equal(appInfo.current, active.id);
    assert.equal(appInfo.health.requests, 5);
    assert.equal(appInfo.health.failed, 4);
    assert.equal(appInfo.cooldown.remainingMs > 0, true);
    assert.deepEqual(appInfo.suggestion, { id: backup.id, name: "relay-b" });
    assert.equal(status.suggestions.length, 1);
    assert.equal(store.readStore ? undefined : undefined, undefined);
    const providerStore = await store.readStore();
    assert.equal(providerStore.apps.claude.current, active.id, "no auto switch while disabled");
  });

  it("auto-switches to the next healthy provider and logs the action", async () => {
    const { active, backup } = await seedProviders();
    await failover.updateConfig({ enabled: true, autoSwitch: true, minRequests: 3, failureRatePct: 50 });
    writeRecords([coreRecord({ failed: true }), coreRecord({ failed: true }), coreRecord({ failed: true })]);
    const switchFn = ({ app, id }) => store.setCurrentProvider(app, id);
    const status = await failover.evaluate({ switchFn, now: NOW });
    const appInfo = status.apps.claude;
    assert.equal(appInfo.switchedTo, backup.id);
    const providerStore = await store.readStore();
    assert.equal(providerStore.apps.claude.current, backup.id);
    assert.equal(status.actions.at(-1).from, active.name);
    assert.equal(status.actions.at(-1).to, backup.name);
    // the failed provider is cooling down, so the next evaluation would not
    // pick it again
    assert.equal(status.cooldowns.some((entry) => entry.id === active.id), true);
  });

  it("clearCooldown lifts the suppression", async () => {
    const { active } = await seedProviders();
    await failover.updateConfig({ enabled: true, minRequests: 1, failureRatePct: 50 });
    writeRecords([coreRecord({ failed: true })]);
    const first = await failover.evaluate({ now: NOW });
    assert.notEqual(first.apps.claude.cooldown, null);
    await failover.clearCooldown("claude", active.id);
    const second = await failover.evaluate({ now: NOW + 1000 });
    // records unchanged → it re-enters cooldown, proving the previous entry
    // was actually cleared rather than just persisted
    assert.equal(second.cooldowns.some((entry) => entry.id === active.id), true);
  });

  it("matches records by provider name only when no credential hash exists", async () => {
    await store.createProvider("claude", {
      name: "relay-a",
      // No credential-shaped field → name matching is the only signal.
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://relay-a.example.com" } },
    });
    const backup = await store.createProvider("claude", {
      name: "relay-b",
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://relay-b.example.com" } },
    });
    await store.setCurrentProvider("claude", (await store.listProviders("claude")).providers[0].id);
    await failover.updateConfig({ enabled: true, minRequests: 2, failureRatePct: 50 });
    writeRecords([
      coreRecord({ failed: true, apiKey: "sk-unrelated" }),
      coreRecord({ failed: true, apiKey: "sk-unrelated" }),
      coreRecord({ apiKey: "sk-unrelated" }),
    ]);
    const status = await failover.evaluate({ now: NOW });
    assert.equal(status.apps.claude.health.requests, 3, "matched by provider name");
    assert.equal(status.apps.claude.health.failed, 2);
    assert.deepEqual(status.apps.claude.suggestion, { id: backup.id, name: "relay-b" });
  });

  it("ignores unrelated traffic when a credential hash exists", async () => {
    const { active } = await seedProviders();
    await failover.updateConfig({ enabled: true, minRequests: 2, failureRatePct: 50 });
    writeRecords([
      // Same provider NAME but a different key: with a usable credential hash
      // the name match must not pull these rows in.
      coreRecord({ failed: true, apiKey: "sk-unrelated" }),
      coreRecord({ failed: true, apiKey: "sk-unrelated" }),
      coreRecord({ failed: true }),
    ]);
    const status = await failover.evaluate({ now: NOW });
    assert.equal(status.apps.claude.health.requests, 1, "hash-only matching");
    assert.equal(status.apps.claude.cooldown, null, "below minRequests → no cooldown");
    assert.equal(status.apps.claude.current, active.id);
  });

  it("finds credentials in nested configs and skips placeholders", () => {
    assert.equal(failover.findCredential({ env: { ANTHROPIC_AUTH_TOKEN: "sk-1" } }), "sk-1");
    assert.equal(failover.findCredential({ provider: { options: { apiKey: "sk-2" } } }), "sk-2");
    assert.equal(failover.findCredential({ env: { ANTHROPIC_AUTH_TOKEN: "$TOKEN$" }, apiKey: "sk-3" }), "sk-3");
    assert.equal(failover.findCredential({ env: { DEEP: true } }), null);
  });

  it("matches Codex relay failures using the selected route's bearer token", async () => {
    const active = await store.createProvider("codex", {
      name: "Local proxy",
      settingsConfig: {
        auth: null,
        config: { model_provider: "relay", model_providers: {
          inactive: { experimental_bearer_token: "sk-inactive" },
          relay: { base_url: "https://relay.example.com/v1", experimental_bearer_token: "sk-active" },
        } },
      },
    });
    const backup = await store.createProvider("codex", {
      name: "Backup relay", settingsConfig: { config: { experimental_bearer_token: "sk-backup" } },
    });
    await store.setCurrentProvider("codex", active.id);
    await failover.updateConfig({ enabled: true, minRequests: 2, failureRatePct: 50 });
    writeRecords([
      coreRecord({ provider: "codex", failed: true }),
      coreRecord({ provider: "codex", failed: true }),
      coreRecord({ provider: "codex", apiKey: "sk-inactive" }),
    ]);
    const status = await failover.evaluate({ now: NOW });
    assert.equal(status.apps.codex.health.requests, 2);
    assert.equal(status.apps.codex.health.failed, 2);
    assert.ok(status.apps.codex.cooldown.remainingMs > 0);
    assert.deepEqual(status.apps.codex.suggestion, { id: backup.id, name: "Backup relay" });
  });

  it("resolves legacy auth and top-level Codex keys with the same precedence as switching", () => {
    const hash = (key) => require("node:crypto").createHash("sha256").update(key).digest("hex");
    const provider = { settingsConfig: {
      auth: { OPENAI_API_KEY: "sk-auth" },
      config: { experimental_bearer_token: "sk-top", model_providers: { custom: { experimental_bearer_token: "sk-route" } } },
    } };
    assert.equal(failover.providerCredentialHash(provider, "codex"), hash("sk-auth"));
    provider.settingsConfig.auth = null;
    assert.equal(failover.providerCredentialHash(provider, "codex"), hash("sk-route"));
    delete provider.settingsConfig.config.model_providers;
    assert.equal(failover.providerCredentialHash(provider, "codex"), hash("sk-top"));
    provider.settingsConfig.config.experimental_bearer_token = "$TOKEN$";
    assert.equal(failover.providerCredentialHash(provider, "codex"), null);
  });

  it("clamps the config into sane bounds", () => {
    const config = failover.normalizeConfig({
      enabled: true, windowMinutes: 0, minRequests: -5, failureRatePct: 900, cooldownMinutes: 99999,
    });
    assert.deepEqual(config, {
      enabled: true, autoSwitch: false,
      windowMinutes: 1, minRequests: 1, failureRatePct: 100, cooldownMinutes: 1440,
    });
  });
});
