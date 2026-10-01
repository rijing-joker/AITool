import { afterEach, describe, expect, it, vi } from "vitest";
import { buildActivityHeatmap } from "./activity-heatmap";

afterEach(() => vi.unstubAllEnvs());
describe("heatmap calendar-day alignment", () => {
  it.each(["America/Los_Angeles", "Asia/Shanghai", "UTC"])("keeps Sunday labels aligned in %s", (zone) => {
    vi.stubEnv("TZ", zone);
    const result = buildActivityHeatmap({ weeks: 2, to: "2026-09-27", weekStartsOn: "sun", dailyRows: [] });
    expect(result.from).toBe("2026-09-20");
    expect(result.weeks[0][0]?.day).toBe(result.from);
    expect(result.to).toBe("2026-09-27");
  });
});
