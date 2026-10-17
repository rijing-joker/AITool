import { expect, it } from "vitest";
import { formatCost, formatCostUsd } from "./cost-format";

it("converts displayed estimates and exact tooltips without changing USD export formatting", () => {
  const yen = { rate: 155, symbol: "¥" };
  expect(formatCost(0.01, yen)).toBe("¥1.55");
  expect(formatCost(0.01, yen, true)).toBe("¥1.550000");
  expect(formatCostUsd(0.01)).toBe("$0.01");
  expect(formatCost(0.0000001, yen)).toBe("<¥0.0001");
  expect(formatCost(null, yen)).toBeNull();
  expect(formatCost(0, yen)).toBe("¥0");
});
