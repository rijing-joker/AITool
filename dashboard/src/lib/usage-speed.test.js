import { describe, expect, it } from "vitest";
import { formatAggregateSpeed, getAggregateTokensPerSecond } from "./usage-speed";

describe("formatAggregateSpeed", () => {
  it("formats exact speed from the summed generation window", () => {
    expect(formatAggregateSpeed({ speed_output_tokens: 300, speed_generation_ms: 2600 })).toBe("115.4 t/s");
  });

  it("falls back to the estimated totals with a ≈ prefix", () => {
    expect(formatAggregateSpeed({ est_speed_output_tokens: 250, est_speed_duration_ms: 2000 })).toBe("≈ 125.0 t/s");
  });

  it("prefers exact over estimated and returns null without any totals", () => {
    expect(
      formatAggregateSpeed({ speed_output_tokens: 100, speed_generation_ms: 1000, est_speed_output_tokens: 250, est_speed_duration_ms: 2000 }),
    ).toBe("100.0 t/s");
    expect(formatAggregateSpeed({})).toBeNull();
    expect(formatAggregateSpeed(null)).toBeNull();
  });

  it("rejects zero or non-finite inputs", () => {
    expect(getAggregateTokensPerSecond(0, 1000)).toBeNull();
    expect(getAggregateTokensPerSecond(100, 0)).toBeNull();
    expect(getAggregateTokensPerSecond(NaN, 1000)).toBeNull();
    expect(getAggregateTokensPerSecond(100, -5)).toBeNull();
  });
});
