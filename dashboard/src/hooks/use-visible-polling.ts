import { useCallback, useEffect, useRef } from "react";
import { startLocalUsageAutoRefresh } from "../lib/local-usage-auto-refresh";

/** One visible, non-overlapping poll loop, also shared by manual refreshes. */
export function useVisiblePolling(refresh: (signal: AbortSignal) => Promise<unknown>, intervalMs: number) {
  const controller = useRef<ReturnType<typeof startLocalUsageAutoRefresh> | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const loop = startLocalUsageAutoRefresh({ refresh: () => refresh(abort.signal), intervalMs });
    controller.current = loop;
    void loop.run();
    return () => {
      loop.stop();
      abort.abort();
      if (controller.current === loop) controller.current = null;
    };
  }, [refresh, intervalMs]);
  return useCallback(() => controller.current?.run(), []);
}
