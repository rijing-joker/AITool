// Synthetic browser regressions for nested output search and outline tracking.
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=... node dashboard/scripts/verify-cli-session-reader.mjs http://127.0.0.1:5173
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = new URL("/cli-sessions", process.argv[2] || "http://127.0.0.1:5173");
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
const output = Array.from({ length: 450 }, (_, index) => index === 440 ? "SEARCHTAIL output" : `line ${index + 1}`).join("\n");
const messages = Array.from({ length: 100 }, (_, index) => [
  { role: "user", content: `Question ${index + 1}` },
  { role: "assistant", content: `Answer ${index + 1}` },
]).flat();
messages.splice(179, 0,
  { role: "assistant", content: "", toolCalls: [{ id: "long", name: "exec_command", arguments: '{"cmd":"npm test"}' }] },
  { role: "tool", content: output, toolResults: [{ callId: "long", output, status: "failed", exitCode: 1 }] },
);
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("tokentracker-locale", "en"));
    await page.route("**/*", async route => {
      const request = new URL(route.request().url());
      if (request.origin !== url.origin) return route.abort();
      if (request.pathname === "/api/cli-sessions") return route.fulfill({ json: { ok: true, apps: [{ id: "claude", available: true }] } });
      if (request.pathname === "/api/cli-sessions/list") return route.fulfill({ json: { ok: true, sessions: [{ appId: "claude", sessionId: "fixture", sourcePath: "/fixture/session.jsonl", title: "Reader fixture" }] } });
      if (request.pathname === "/api/cli-sessions/read") return route.fulfill({ json: { ok: true, messages } });
      if (request.pathname.startsWith("/api/") || request.pathname.startsWith("/functions/")) return route.fulfill({ json: { ok: true } });
      return route.continue();
    });
    await page.goto(url.href);
    await page.getByText("Reader fixture", { exact: true }).click();
    await page.getByLabel("Find in transcript", { exact: true }).fill("SEARCHTAIL");
    await page.waitForTimeout(600);
    const bounds = await page.locator("mark").first().evaluate(mark => {
      const pre = mark.closest("pre"), hit = mark.getBoundingClientRect(), pane = pre.getBoundingClientRect();
      return { hitTop: hit.top, hitBottom: hit.bottom, paneTop: pane.top, paneBottom: pane.bottom, scroll: pre.scrollTop, height: innerHeight };
    });
    assert.ok(bounds.scroll > 0 && bounds.hitTop >= bounds.paneTop && bounds.hitBottom <= bounds.paneBottom && bounds.hitTop > 0 && bounds.hitBottom < bounds.height, JSON.stringify(bounds));
    await page.getByLabel("Clear transcript search").click();
    await page.getByRole("button", { name: "Outline", exact: true }).click();
    await page.getByRole("button", { name: "1 Question 1", exact: true }).click();
    await page.waitForTimeout(400);
    await page.locator('[data-turn-key="turn-0"]').evaluate(section => { section.closest(".overflow-y-auto").scrollTop = 6000; });
    await page.waitForTimeout(250);
    if (width < 768) await page.getByRole("button", { name: "Outline", exact: true }).click();
    const current = await page.locator('nav button[aria-current="location"]').innerText();
    assert.ok(!current.endsWith("Question 1"), current);
    await page.getByRole("button", { name: "Jump to reply in turn 21" }).click();
    await page.waitForTimeout(400);
    const answer = await page.locator("[data-turn-part=answer]").getByText("Answer 21", { exact: true }).boundingBox();
    assert.ok(answer && answer.y > 0 && answer.y + answer.height < 844, JSON.stringify(answer));
    assert.deepEqual(errors, []);
    console.log(`PASS: ${width}px, nested search visible, outline follows scroll, reply jump visible`);
    await page.close();
  }
} finally { await browser.close(); }
