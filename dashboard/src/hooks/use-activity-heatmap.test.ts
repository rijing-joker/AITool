import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCloudUsageDaily, fetchCloudUsageHeatmap } from "../lib/api";
import { isMockEnabled } from "../lib/mock-data";
import { useActivityHeatmap } from "./use-activity-heatmap";

vi.mock("../lib/api", () => ({
  fetchCloudUsageDaily: vi.fn(),
  fetchCloudUsageHeatmap: vi.fn(),
  getUsageDaily: vi.fn(),
  getUsageHeatmap: vi.fn(),
}));
vi.mock("../lib/auth-token", () => ({
  isAccessTokenReady: () => true,
  resolveAuthAccessToken: async (token: any) => token || "test-token",
}));
vi.mock("../lib/mock-data", () => ({ isMockEnabled: vi.fn(() => false) }));

describe("useActivityHeatmap request ordering", () => {
  beforeEach(() => {
    vi.mocked(fetchCloudUsageHeatmap).mockReset();
    vi.mocked(fetchCloudUsageDaily).mockReset();
    window.localStorage.clear();
    vi.mocked(isMockEnabled).mockReturnValue(false);
  });

  it("clears the old device when the new scope has no cache and its request fails", async () => {
    let rejectNew: (reason: Error) => void = () => {};
    vi.mocked(fetchCloudUsageHeatmap).mockImplementation(({ device }: any) => device === "old"
      ? Promise.resolve({ weeks: [[{ day: "2026-08-20", level: 2, total_tokens: 100 }]], marker: "old" })
      : new Promise((_resolve, reject) => { rejectNew = reject; }));
    vi.mocked(fetchCloudUsageDaily).mockRejectedValue(new Error("offline"));
    const now = new Date("2026-08-20T12:00:00Z");
    const { result, rerender } = renderHook(({ deviceId }) => useActivityHeatmap({
      baseUrl: "https://app.tokentracker.cc", cacheKey: "scope-clear", accountView: true,
      accountAccessToken: "jwt", deviceId, now,
    }), { initialProps: { deviceId: "old" } });
    await waitFor(() => expect(result.current.heatmap?.marker).toBe("old"));
    rerender({ deviceId: "new" });
    await waitFor(() => expect(fetchCloudUsageHeatmap).toHaveBeenCalledTimes(2));
    expect(result.current.heatmap).toBeNull();
    expect(result.current.daily).toEqual([]);
    await act(async () => rejectNew(new Error("offline")));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.heatmap).toBeNull();
  });

  it("does not persist mock heatmap responses", async () => {
    vi.mocked(isMockEnabled).mockReturnValue(true);
    vi.mocked(fetchCloudUsageHeatmap).mockResolvedValue({ weeks: [[{ day: "2026-08-20", level: 1 }]] });
    const now = new Date("2026-08-20T12:00:00Z");
    const { result } = renderHook(() => useActivityHeatmap({
      baseUrl: "https://app.tokentracker.cc", cacheKey: "mock", accountView: true,
      accountAccessToken: "jwt", now,
    }));
    await waitFor(() => expect(result.current.heatmap).not.toBeNull());
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith("tokentracker.heatmap."))).toEqual([]);
  });

  it("ignores a late response from a previous device scope", async () => {
    let resolveOld: (value: any) => void = () => {};
    let resolveNew: (value: any) => void = () => {};
    vi.mocked(fetchCloudUsageHeatmap).mockImplementation(({ device }: any) =>
      new Promise((resolve) => {
        if (device === "old-device") resolveOld = resolve;
        else resolveNew = resolve;
      }),
    );

    const { result, rerender } = renderHook(
      ({ deviceId }) =>
        useActivityHeatmap({
          baseUrl: "https://app.tokentracker.cc",
          cacheKey: "heatmap-race",
          weeks: 4,
          timeZone: "UTC",
          accountView: true,
          accountAccessToken: "jwt-token",
          deviceId,
          now: new Date("2026-08-20T12:00:00Z"),
        }),
      { initialProps: { deviceId: "old-device" } },
    );

    await waitFor(() => expect(fetchCloudUsageHeatmap).toHaveBeenCalledTimes(1));
    rerender({ deviceId: "new-device" });
    await waitFor(() => expect(fetchCloudUsageHeatmap).toHaveBeenCalledTimes(2));

    await act(async () =>
      resolveNew({
        weeks: [[{ day: "2026-08-20", level: 2, total_tokens: 200 }]],
        active_days: 1,
        marker: "new",
      }),
    );
    await waitFor(() => expect(result.current.heatmap?.marker).toBe("new"));

    await act(async () =>
      resolveOld({
        weeks: [[{ day: "2026-08-20", level: 1, total_tokens: 100 }]],
        active_days: 1,
        marker: "old",
      }),
    );
    expect(result.current.heatmap?.marker).toBe("new");
    expect(result.current.loading).toBe(false);
  });

  it("only applies the newest of overlapping manual refreshes", async () => {
    const resolvers: Array<(value: any) => void> = [];
    vi.mocked(fetchCloudUsageHeatmap).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );

    const { result } = renderHook(() =>
      useActivityHeatmap({
        baseUrl: "https://app.tokentracker.cc",
        cacheKey: "heatmap-manual-race",
        weeks: 4,
        timeZone: "UTC",
        accountView: true,
        accountAccessToken: "jwt-token",
        now: new Date("2026-08-20T12:00:00Z"),
      }),
    );
    await waitFor(() => expect(fetchCloudUsageHeatmap).toHaveBeenCalledTimes(1));

    let firstRefresh: Promise<void> = Promise.resolve();
    let secondRefresh: Promise<void> = Promise.resolve();
    await act(async () => {
      firstRefresh = result.current.refresh();
    });
    await waitFor(() => expect(fetchCloudUsageHeatmap).toHaveBeenCalledTimes(2));

    await act(async () => {
      secondRefresh = result.current.refresh();
    });
    await waitFor(() => expect(fetchCloudUsageHeatmap).toHaveBeenCalledTimes(3));

    await act(async () =>
      resolvers[2]?.({
        weeks: [[{ day: "2026-08-20", level: 2, total_tokens: 200 }]],
        marker: "latest",
      }),
    );
    await waitFor(() => expect(result.current.heatmap?.marker).toBe("latest"));
    await act(async () =>
      resolvers[1]?.({
        weeks: [[{ day: "2026-08-20", level: 1, total_tokens: 100 }]],
        marker: "stale",
      }),
    );
    await firstRefresh;
    await secondRefresh;

    // Release the mount request as well so the test leaves no pending work.
    await act(async () =>
      resolvers[0]?.({
        weeks: [[{ day: "2026-08-20", level: 1, total_tokens: 100 }]],
        marker: "mount",
      }),
    );

    expect(result.current.heatmap?.marker).toBe("latest");
    expect(result.current.loading).toBe(false);
  });
});
