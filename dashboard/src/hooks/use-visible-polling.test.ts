import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useVisiblePolling } from "./use-visible-polling";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("keeps the configured cadence, pauses hidden pages, resumes immediately and coalesces manual refreshes", async () => {
  vi.useFakeTimers();
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
  let finish: (() => void) | undefined;
  const refresh = vi.fn((_signal: AbortSignal) => new Promise<void>((resolve) => { finish = resolve; }));
  const { result, unmount } = renderHook(() => useVisiblePolling(refresh, 10_000));
  await act(async () => {});
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { void result.current(); await vi.advanceTimersByTimeAsync(10_000); });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { finish?.(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => { finish?.(); });
  visibility = "hidden";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(60_000); });
  expect(refresh).toHaveBeenCalledTimes(2);
  visibility = "visible";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(refresh).toHaveBeenCalledTimes(3);
  const signal = refresh.mock.calls[2][0];
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { finish?.(); await vi.advanceTimersByTimeAsync(60_000); });
  expect(refresh).toHaveBeenCalledTimes(3);
});

it("aborts old filters and starts a fresh request when the callback changes", async () => {
  const first = vi.fn(async (_signal: AbortSignal) => {});
  const second = vi.fn(async (_signal: AbortSignal) => {});
  const { rerender, unmount } = renderHook(({ refresh }) => useVisiblePolling(refresh, 10_000), { initialProps: { refresh: first } });
  await act(async () => {});
  rerender({ refresh: second });
  await act(async () => {});
  expect(first.mock.calls[0][0].aborted).toBe(true);
  expect(second).toHaveBeenCalledTimes(1);
  unmount();
});
