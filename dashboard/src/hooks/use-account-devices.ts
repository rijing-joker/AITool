import { useCallback, useEffect, useState } from "react";
import { resolveAuthAccessToken } from "../lib/auth-token";
import { fetchAccountDevices } from "../lib/api";
import { useLatestRequestGuard } from "./use-latest-request-guard";

/**
 * Lists the signed-in account's active devices with per-device usage totals
 * for [from, to]. Only fetches in account view (cross-device cloud reads);
 * outside it the dashboard is single-device and there is nothing to compare.
 */
export function useAccountDevices({
  from,
  to,
  timeZone,
  tzOffsetMinutes,
  accountView = false,
  accountAccessToken = null,
  accountRevision = 0,
}: any = {}) {
  const enabled = Boolean(accountView && accountAccessToken);
  const [devices, setDevices] = useState<any[]>([]);
  // Account-level sources (e.g. Cursor) have no device attribution; the edge
  // returns their account-wide totals separately so the card can still show
  // them (otherwise its total is short of the dashboard total by their share).
  const [accountSources, setAccountSources] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beginRequest = useLatestRequestGuard([
    enabled,
    from,
    to,
    timeZone,
    tzOffsetMinutes,
    accountAccessToken,
    accountRevision,
  ]);

  const refresh = useCallback(async () => {
    const isCurrent = beginRequest();
    if (!enabled) {
      setDevices([]);
      setAccountSources([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const token = await resolveAuthAccessToken(accountAccessToken);
      if (!isCurrent()) return;
      const res = await fetchAccountDevices({ from, to, timeZone, tzOffsetMinutes, accessToken: token });
      if (!isCurrent()) return;
      setDevices(Array.isArray(res?.devices) ? res.devices : []);
      setAccountSources(Array.isArray(res?.account_sources) ? res.account_sources : []);
    } catch (e: any) {
      if (!isCurrent()) return;
      setError(e?.message || String(e));
      setDevices([]);
      setAccountSources([]);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [enabled, accountAccessToken, from, to, timeZone, tzOffsetMinutes, accountRevision, beginRequest]);

  useEffect(() => {
    // Device totals are range-bound; clear them before loading a new range so
    // the selector cannot expose an old range under the current period.
    setDevices([]);
    setAccountSources([]);
    setError(null);
    if (enabled) setLoading(true);
    refresh();
  }, [enabled, refresh]);

  return { devices, accountSources, loading, error, refresh };
}
