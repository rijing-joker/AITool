import { expect, it } from "vitest";

it("propagates cancellation to native Requests in the DOM test environment", () => {
  const controller = new AbortController();
  const request = new Request("https://example.test/", { signal: controller.signal });
  expect(request.signal).toBeInstanceOf(AbortSignal);
  expect(request.signal.aborted).toBe(false);

  const reason = new Error("Navigation canceled");
  controller.abort(reason);
  expect(request.signal.aborted).toBe(true);
  expect(request.signal.reason).toBe(reason);
});
