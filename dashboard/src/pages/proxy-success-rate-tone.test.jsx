import { expect, it } from "vitest";
import { successRateTone } from "./ProxyPage";

// easy 5183cf2: the proxy overview's success-rate tile is tinted by band —
// ≥95 healthy (green), ≥80 degraded (amber), below that failing (red).
it("bands the success-rate tone at 95 and 80", () => {
  expect(successRateTone(100)).toContain("text-emerald-600");
  expect(successRateTone(95)).toContain("text-emerald-600");
  expect(successRateTone(94.9)).toContain("text-amber-600");
  expect(successRateTone(80)).toContain("text-amber-600");
  expect(successRateTone(79.9)).toContain("text-red-600");
  expect(successRateTone(0)).toContain("text-red-600");
});

it("stays neutral without a measurable rate", () => {
  expect(successRateTone(null)).toBe("");
  expect(successRateTone(undefined)).toBe("");
  expect(successRateTone(Number.NaN)).toBe("");
});
