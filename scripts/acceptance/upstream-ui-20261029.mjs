import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
// Serve dashboard/dist only. All API and external requests use synthetic
// fixtures; this script never starts AiTool or accesses native account files.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = await import(pathToFileURL(path.join(repo, "dashboard/node_modules/playwright/index.mjs")).href);
const root = path.join(repo, "dashboard/dist"), output = process.env.AITOOL_UI_EVIDENCE_DIR || await fs.mkdtemp(path.join(os.tmpdir(), "aitool-ui-1029-"));
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    let file = path.join(root, decodeURIComponent(new URL(req.url, "http://localhost").pathname));
    if (!file.startsWith(root + "/")) throw Error();
    let info = await fs.stat(file).catch(() => null);
    if (!info?.isFile()) {
      file = path.join(root, "index.html");
    }
    const content = await fs.readFile(file);
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".png") ? "image/png" : "text/html");
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const appIds = ["claude", "codex", "gemini", "agy", "opencode", "openclaw", "mcode", "hermes", "pi", "grokbuild", "kimi", "omp", "dsh"];
const providerTemplate = { claude: [{ id: "official", name: "Claude official", category: "official", settingsConfig: {}, meta: { claudeAccountId: "fixture:org" } }], codex: [{ id: "catalog", name: "Codex relay", category: "third_party", settingsConfig: { auth: {}, config: { model: "fixture-a", model_provider: "custom", model_providers: { custom: { name: "Fixture", base_url: "https://fixture.invalid/v1", experimental_bearer_token: "synthetic" } } } }, meta: { codexCatalogModels: [{ model: "fixture-a", displayName: "Alpha", contextWindow: "128000", reasoningLevels: ["low", "high"] }, { model: "fixture-b", displayName: "Beta", contextWindow: "256000", reasoningLevels: ["low", "high"] }] } }] };
let browser;
const evidence = [];
try {
  browser = await chromium.launch(process.env.AITOOL_CHROMIUM_EXECUTABLE ? { executablePath: process.env.AITOOL_CHROMIUM_EXECUTABLE } : {});
  for (const variant of [{ width: 1440, theme: "light", locale: "zh" }, { width: 390, theme: "dark", locale: "zh" }, { width: 390, theme: "light", locale: "zh-TW" }]) {
    const providers = structuredClone(providerTemplate);
    const dictionary = Object.assign({}, ...await Promise.all(["core", "dashboard", "marketing"].map(async (name) => JSON.parse(await fs.readFile(path.join(repo, "dashboard/src/content/i18n", variant.locale, name + ".json"), "utf8")))));
    const context = await browser.newContext({ viewport: { width: variant.width, height: 1e3 }, reducedMotion: "reduce", locale: variant.locale });
    await context.addInitScript(({ theme, locale }) => {
      localStorage.setItem("tokentracker-theme", theme);
      localStorage.setItem("tokentracker-locale", locale);
      localStorage.setItem("tokentracker-cloud-sync", "false");
    }, variant);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.log("PAGE", e.stack);
    });
    page.on("console", (m) => {
      if (m.type() === "error") console.log("CONSOLE", m.text());
    });
    let config = { enabled: true, interruptMessage: true, maxConcurrentThreadsPerSession: 3 }, revision = "r1", hubEnabled = false, forceConflict = false, skillRecovered = false, savedCatalog = null;
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) {
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      if (url.pathname.startsWith("/_vercel/")) return route.fulfill({ contentType: "text/javascript", body: "" });
      if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/functions/")) return route.continue();
      const p = url.pathname;
      let data = { ok: true };
      if (p === "/api/local-auth") data = { token: "synthetic-local-key" };
      else if (p === "/api/provider-switch/status") data = { ok: true, visibleApps: Object.fromEntries(appIds.map((id) => [id, true])), apps: appIds.map((app) => ({ app, current: providers[app]?.[0]?.id || null, providers: providers[app] || [], files: [] })) };
      else if (p === "/api/provider-switch/claude/accounts") data = { ok: true, supported: true, switchSupported: true, currentAccountId: "fixture:org", accounts: [{ id: "fixture:org", email: "account-with-a-long-name@synthetic.example", requiresReauth: false }] };
      else if (p === "/api/provider-switch/claude/accounts/quota") data = { ok: true, quota: { ok: true, tiers: [{ id: "five-hour", label: "5h", used_percent: 21, reset_at: "2026-10-30T00:00:00Z" }] } };
      else if (p === "/api/provider-switch/codex/subagents") {
        if (request.method() === "PUT") {
          if (forceConflict) {
            forceConflict = false;
            revision = "r3";
            return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Synthetic configuration conflict" }) });
          }
          const body = request.postDataJSON();
          assert.equal(body.revision, revision);
          config = body.config;
          revision = "r2";
        }
        data = { ok: true, config, revision, path: "/synthetic/config.toml" };
      } else if (p === "/api/provider-switch/editor-view") data = { ok: true, app: "codex", authJson: {}, configToml: 'model = "fixture-a"\nmodel_provider = "custom"\n[model_providers.custom]\nname = "Fixture"\nbase_url = "https://fixture.invalid/v1"\nexperimental_bearer_token = "synthetic"\n', inactive: [] };
      else if (p === "/api/provider-switch/providers/catalog" && request.method() === "PUT") {
        const body = request.postDataJSON();
        savedCatalog = body.meta.codexCatalogModels;
        providers.codex[0] = { ...providers.codex[0], ...body };
        data = { ok: true, provider: providers.codex[0], applied: { wrote: [] } };
      } else if (p === "/api/provider-switch/codex-client") data = { ok: true, client: { supported: true, status: "fresh", clients: [] } };
      else if (p === "/api/provider-switch/mcp") data = { ok: true, servers: [{ id: "fixture", name: "Fixture MCP", server: { command: "fixture" }, apps: { claude: true, codex: true }, disabledTools: {} }], checks: {}, toolFilterApps: ["claude", "codex"], hub: { enabled: hubEnabled, address: hubEnabled ? origin + "/api/mcp/hub/all" : null, connectedApps: hubEnabled ? ["claude", "codex"] : [], recoveryRequired: false } };
      else if (p === "/api/provider-switch/mcp/hub") {
        if (request.method() === "POST") hubEnabled = request.postDataJSON().enabled;
        data = { ok: true, hub: { enabled: hubEnabled, address: hubEnabled ? origin + "/api/mcp/hub/all" : null, connectedApps: hubEnabled ? ["claude", "codex"] : [], recoveryRequired: false, failures: [] }, connection: { mcpServers: { "aitool-hub": { url: origin + "/api/mcp/hub/all", headers: { Authorization: "Bearer synthetic-hub-key" } } } } };
      } else if (p === "/api/provider-switch/diagnostics") data = { ok: true, diagnostic: { status: "applied", files: [], app: url.searchParams.get("app") } };
      else if (p === "/api/provider-switch/profiles") data = { ok: true, profiles: [], currentIds: {}, supportedApps: appIds };
      else if (p === "/api/provider-switch/universal") data = { ok: true, providers: [] };
      else if (p.includes("backups")) data = { ok: true, backups: [] };
      else if (p.includes("presets")) data = { ok: true, presets: [] };
      else if (p.includes("env-conflicts")) data = { ok: true, conflicts: [] };
      else if (p.includes("failover")) data = { ok: true, enabled: false, apps: {}, settings: {} };
      else if (p === "/functions/tokentracker-sessions") {
        await new Promise((resolve) => setTimeout(resolve, 700));
        data = { available: true, session_count: 1, returned_count: 1, sessions: [{ session_hash: "dsh", session_id: "synthetic-session", title: "DSH synthetic session", source: "dsh", project_key: "fixture", project_ref: "/synthetic/project", model: "deepseek-v4.1-flash", started_at: new Date(Date.now() - 6e5).toISOString(), ended_at: (/* @__PURE__ */ new Date()).toISOString(), duration_ms: 6e5, turns: 2, total_tokens: 12e3, cost_usd: 0.15, performance: { estimated_tokens_per_second: 25, estimated_output_tokens: 1e3, estimated_duration_ms: 4e4, estimated_request_count: 2, first_response_ms: 150 } }] };
      } else if (p === "/functions/tokentracker-skills") {
        if (request.method() === "POST") {
          const body = request.postDataJSON();
          assert.equal(body.action, "recover_shared");
          skillRecovered = true;
        }
        data = { skills: [], targets: [], sharedRecovery: skillRecovered ? [] : [{ id: "00000000-0000-0000-0000-000000000000", directory: "Synthetic Skill", direction: "hand-back", status: "prepared" }], repos: [], updates: {} };
      } else if (p === "/functions/tokentracker-usage-limits") data = { fetched_at: (/* @__PURE__ */ new Date()).toISOString(), zcode: { configured: true, plan_label: "Pro", plan_kind: "coding-plan", primary_window: { used_percent: 2 }, reset_credits: { five_hour: [{ granted_at: new Date(Date.now() - 864e5).toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString() }, { expires_at: "2000-01-01T00:00:00Z" }], weekly: [] } } };
      else data = { ok: true, available: true, entries: [], rows: [], models: [], days: [], data: [], totals: {}, breakdown: [], settings: { autoStart: false }, enabled: false };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto(origin + "/provider-switch", { waitUntil: "domcontentloaded" });
    await page.getByText("account-with-a-long-name@synthetic.example").waitFor({ timeout: 1e4 }).catch(async (error) => {
      console.log(errors);
      console.log((await page.locator("body").innerText()).slice(0, 6e3));
      await page.screenshot({ path: output + "/debug.png", fullPage: true });
      throw error;
    });
    await page.screenshot({ path: `${output}/providers-${variant.width}-${variant.theme}-${variant.locale}.png`, fullPage: true });
    const verifyOverflow = async () => {
      const bounds = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      assert.ok(bounds.document <= bounds.viewport + 1, JSON.stringify(bounds));
      return bounds;
    };
    await verifyOverflow();
    const tabs = page.getByRole("tab");
    await tabs.filter({ hasText: "Codex" }).click();
    const details = page.locator("details").filter({ hasText: variant.locale === "zh-TW" ? "\u5168\u57DF\u5B50\u4EE3\u7406\u8A2D\u5B9A" : "\u5168\u5C40\u5B50\u4EE3\u7406\u8BBE\u7F6E" });
    await details.locator("summary").click();
    await page.getByRole("spinbutton").fill("5");
    await page.getByRole("spinbutton").press("Tab");
    await page.waitForTimeout(150);
    assert.equal(config.maxConcurrentThreadsPerSession, 5);
    await page.screenshot({ path: `${output}/codex-${variant.width}-${variant.theme}-${variant.locale}.png`, fullPage: true });
    forceConflict = true;
    await page.getByRole("spinbutton").fill("6");
    await page.getByRole("spinbutton").press("Tab");
    await page.getByRole("alert").filter({ hasText: "Synthetic configuration conflict" }).waitFor();
    assert.equal(config.maxConcurrentThreadsPerSession, 5);
    await page.getByRole("button", { name: dictionary["pswitch.action.reload"], exact: true }).click();
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole("spinbutton").inputValue(), "5");
    if (variant.locale === "zh") {
      await page.getByRole("button", { name: "\u7F16\u8F91", exact: true }).click();
      await page.waitForTimeout(300);
      const advanced = page.getByRole("button", { name: "\u9AD8\u7EA7\u9009\u9879", exact: true });
      if (await advanced.getAttribute("aria-expanded") !== "true") await advanced.click();
      const handle = page.getByRole("button", { name: "\u62D6\u62FD\u8C03\u6574\u201CAlpha\u201D\u7684\u987A\u5E8F" });
      await handle.waitFor({ timeout: 5e3 }).catch(async (e) => {
        console.log((await page.locator("body").innerText()).slice(-12e3));
        await page.screenshot({ path: output + "/editor-debug.png", fullPage: true });
        throw e;
      });
      const catalogFields = page.getByRole("textbox", { name: dictionary["pswitch.catalog.col_model"], exact: true });
      assert.equal(await catalogFields.count(), 2);
      await handle.scrollIntoViewIfNeeded();
      await handle.focus();
      await page.keyboard.press("Space");
      await page.waitForTimeout(300);
      assert.equal(await handle.getAttribute("aria-pressed"), "true");
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(500);
      await page.keyboard.press("Space");
      await page.waitForTimeout(150);
      const values = await catalogFields.evaluateAll((rows) => rows.map((row) => row.value));
      assert.deepEqual(values, ["fixture-b", "fixture-a"]);
      await page.screenshot({ path: `${output}/catalog-${variant.width}-${variant.theme}.png`, fullPage: true });
      const beta = page.getByRole("button", { name: "\u62D6\u62FD\u8C03\u6574\u201CBeta\u201D\u7684\u987A\u5E8F" });
      await beta.focus();
      await page.keyboard.press("Space");
      await page.waitForTimeout(150);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      assert.notEqual(await beta.getAttribute("aria-pressed"), "true");
      assert.equal(await page.getByRole("dialog").count(), 1);
      await beta.scrollIntoViewIfNeeded();
      const from = await beta.boundingBox(), to = await handle.boundingBox();
      await page.mouse.move(from.x + 14, from.y + 20);
      await page.mouse.down();
      await page.mouse.move(to.x + 14, to.y + 20, { steps: 12 });
      await page.waitForTimeout(150);
      await page.mouse.up();
      await page.waitForTimeout(150);
      assert.deepEqual(await catalogFields.evaluateAll((rows) => rows.map((row) => row.value)), ["fixture-a", "fixture-b"]);
      await handle.focus();
      await page.keyboard.press("Space");
      await page.waitForTimeout(150);
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(500);
      await page.keyboard.press("Space");
      await page.waitForTimeout(150);
      await page.getByRole("button", { name: "\u4FDD\u5B58", exact: true }).click();
      await page.waitForTimeout(250);
      assert.deepEqual(savedCatalog.map((row) => row.model), ["fixture-b", "fixture-a"]);
      assert.equal(savedCatalog[1].contextWindow, "128000");
    }
    await tabs.filter({ hasText: /^MCP$/ }).click();
    await page.getByText("Fixture MCP", { exact: true }).waitFor();
    const toggle = page.locator("label").filter({ hasText: variant.locale === "zh-TW" ? "MCP \u5F59\u6574\u5165\u53E3" : "MCP \u805A\u5408\u5165\u53E3" }).getByRole("checkbox");
    await toggle.click();
    await page.waitForTimeout(150);
    assert.equal(hubEnabled, true);
    await page.screenshot({ path: `${output}/hub-${variant.width}-${variant.theme}-${variant.locale}.png`, fullPage: true });
    await page.getByRole("button", { name: dictionary["pswitch.mcp.hub.connect"], exact: true }).click();
    const connection = page.getByRole("textbox", { name: dictionary["pswitch.mcp.hub.connect"], exact: true });
    await connection.waitFor();
    assert.match(await connection.inputValue(), /Bearer synthetic-hub-key/);
    await page.getByRole("button", { name: dictionary["shared.dialog.close"], exact: true }).click();
    await toggle.click();
    await page.waitForTimeout(150);
    assert.equal(hubEnabled, false);
    await verifyOverflow();
    await page.goto(origin + "/sessions", { waitUntil: "domcontentloaded" });
    await page.getByTestId("sessions-skeleton").waitFor();
    assert.equal(await page.getByTestId("sessions-skeleton").getAttribute("aria-busy"), "true");
    await page.screenshot({ path: `${output}/skeleton-${variant.width}-${variant.theme}-${variant.locale}.png`, fullPage: true });
    await page.getByText("DSH synthetic session", { exact: true }).waitFor({ timeout: 1e4 });
    await page.screenshot({ path: `${output}/sessions-${variant.width}-${variant.theme}-${variant.locale}.png`, fullPage: true });
    await verifyOverflow();
    await page.goto(origin + "/limits", { waitUntil: "domcontentloaded" });
    const reset = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: dictionary["limits.zcode.reset_bank.title"] }) }).first();
    await reset.waitFor();
    const group = reset.locator("details");
    assert.equal(await group.count(), 1);
    await group.locator("summary").click();
    assert.equal(await reset.locator("li").count(), 1);
    await reset.locator("progress").waitFor();
    assert.match(await reset.locator("time").innerText(), /(?:23h|1d)/);
    await page.screenshot({ path: `${output}/limits-${variant.width}-${variant.theme}-${variant.locale}.png`, fullPage: true });
    await group.locator("summary").click();
    await verifyOverflow();
    await page.goto(origin + "/skills", { waitUntil: "domcontentloaded" });
    await page.getByText("Synthetic Skill", { exact: true }).waitFor();
    await page.screenshot({ path: `${output}/skills-${variant.width}-${variant.theme}-${variant.locale}.png`, fullPage: true });
    await page.getByRole("button", { name: dictionary["skills.shared.recover"], exact: true }).click();
    await page.getByText("Synthetic Skill", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(skillRecovered, true);
    const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(overflow.document <= overflow.viewport + 1, JSON.stringify(overflow));
    assert.deepEqual(errors, []);
    evidence.push({ ...variant, errors, overflow, checks: ["Claude account rendering", "Codex save/conflict/reload", ...(variant.locale === "zh" ? ["Catalog keyboard/pointer/save and Escape cancellation"] : []), "Hub enable/config/disable", "DSH session and skeleton", "ZCode fold/countdown/empty group", "Skill recovery action"] });
    await context.close();
  }
  await fs.writeFile(output + "/evidence.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ output, evidence }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
