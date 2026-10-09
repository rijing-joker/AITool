// Run against a dashboard dev/preview server:
// node dashboard/scripts/verify-cli-session-scroll.mjs http://127.0.0.1:5173
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = new URL("/cli-sessions", process.argv[2] || "http://127.0.0.1:5173");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
});

// ResizeObserver runs between layout and paint. Wait through several frames so
// hidden rows have time to report zero sizes before returning to the list.
const settleLayout = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}));

const snapshot = (list) => list.evaluate((element) => {
  const viewport = element.getBoundingClientRect();
  const buttons = [...element.querySelectorAll("[data-session-key]")];
  const firstVisible = buttons.find((button) => {
    const rect = button.getBoundingClientRect();
    return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
  });
  return {
    top: element.scrollTop,
    height: element.scrollHeight,
    key: firstVisible?.dataset.sessionKey,
    rendered: buttons.length,
  };
});

try {
  for (const width of [1280, 390]) {
    for (const count of [250, 40]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, locale: "en-US" });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem("tokentracker-locale", "en"));
      const sessions = Array.from({ length: count }, (_, index) => ({
        appId: "claude",
        sessionId: `session-${index}`,
        title: `Session ${index}`,
        summary: "Session summary",
        projectDir: "/fixture/project",
        lastActiveAt: Date.now() - index * 10000,
        sourcePath: `/fixture/session-${index}.jsonl`,
      }));
      // Use only synthetic sessions and prevent any external dashboard traffic.
      await page.route("**/*", async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin !== url.origin) return route.abort();
        if (requestUrl.pathname === "/api/cli-sessions")
          return route.fulfill({ json: { ok: true, apps: [{ id: "claude", available: true }] } });
        if (requestUrl.pathname === "/api/cli-sessions/list")
          return route.fulfill({ json: { ok: true, sessions } });
        if (requestUrl.pathname === "/api/cli-sessions/read")
          return route.fulfill({ json: { ok: true, messages: [
            { role: "user", content: "A fixture question" },
            { role: "assistant", content: "A fixture answer" },
          ] } });
        if (requestUrl.pathname.startsWith("/api/") || requestUrl.pathname.startsWith("/functions/"))
          return route.fulfill({ json: { ok: true } });
        return route.continue();
      });

      try {
        await page.goto(url.href);
        await page.getByText("Session 0", { exact: true }).waitFor();
        const list = page.locator("div.overflow-y-auto")
          .filter({ has: page.locator("[data-session-key]") }).last();
        await list.evaluate((element) => {
          element.scrollTop = Math.min(8000, element.scrollHeight * 0.6);
        });
        await settleLayout(page);
        const before = await snapshot(list);
        assert.ok(before.top > 0 && before.key, "fixture must open a scrolled, visible session");
        if (count > 80) assert.ok(before.rendered < count, "large lists must remain virtualized");

        for (let cycle = 0; cycle < 3; cycle += 1) {
          await page.locator(`[data-session-key=${JSON.stringify(before.key)}]`).click();
          await page.getByLabel("Find in transcript", { exact: true }).waitFor();
          await settleLayout(page);
          // Cover the delayed scroll-end observer as well as quick returns.
          if (cycle === 0) await page.waitForTimeout(250);
          await page.getByLabel("Back to list", { exact: true }).click();
          await settleLayout(page);
          const after = await snapshot(list);
          assert.ok(Math.abs(after.top - before.top) <= 1,
            `${count} sessions at ${width}px, return ${cycle + 1}: scrollTop ${before.top} → ${after.top}`);
          assert.equal(after.key, before.key, "return must show the same session");
          assert.equal(after.height, before.height, "hidden row measurements must not shrink the list");
        }
        assert.deepEqual(errors, []);
        console.log(`PASS: ${count} sessions at ${width}px, three returns preserve scrollTop=${before.top}`);
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
