import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsageHeatmap } from "./usage-heatmap";
vi.mock("../lib/copy", () => ({ copy: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) }));
vi.mock("../hooks/use-visible-polling", async () => {
  const { useEffect } = await import("react");
  return {
    // Mirror the real hook: the effect is keyed on the callback identity and
    // fires it immediately, so an unstable callback would loop forever here.
    useVisiblePolling: (refresh, intervalMs) => {
      useEffect(() => { void refresh(new AbortController().signal); }, [refresh, intervalMs]);
    },
  };
});

const days = [
  { date: "2026-10-01", requests: 4, tokens: 1200, costUsd: 0.02 },
  { date: "2026-10-02", requests: 40, tokens: 120000, costUsd: 2 },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ ok: true, days }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("renders the 53-week grid with metric switching and tooltips", async () => {
  render(<UsageHeatmap />);
  // Titles are the mocked copy's JSON payloads; future days carry no title,
  // so count loosely (53×7 minus the tail after today).
  await vi.waitFor(() => expect(screen.getAllByTitle(/tokens/).length).toBeGreaterThan(360));
  // Quartiles over the two non-zero days: 1200 lands on level 1, 120000 on 4.
  const light = screen.getAllByTitle(/"tokens":"1\.2K"/)[0];
  const heavy = screen.getAllByTitle(/"tokens":"120K"/)[0];
  expect(light.className).toContain("bg-oai-brand-500/25");
  expect(heavy.className).toContain("bg-oai-brand-500");
  expect(light.className).not.toContain("bg-oai-brand-500/45");

  // Switching to requests changes the tooltip metric.
  fireEvent.click(screen.getByText("proxy.heatmap.metric.requests"));
  await vi.waitFor(() => {
    expect(screen.getAllByTitle(/"requests":"40"/).length).toBeGreaterThan(0);
  });
});
