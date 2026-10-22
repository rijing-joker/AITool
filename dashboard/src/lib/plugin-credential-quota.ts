import { isRecord, managementApi, readString } from './easy-providers';
import { authFileCooldownResetIndex, type AuthFileRecord } from './easy-auth';
// EasyCLIProxyAPI pluginCredentialQuota, 9fc0a33b6528 (MIT).
export type QuotaLine = { label: string; remainingPercent: number | null; detail?: string; reset?: string };
export function supportsPluginQuota(file: AuthFileRecord) {
  if (file.supportsQuota === false || file.supports_quota === false) return false;
  return Boolean(readString(file, 'quota_plugin_id', 'quotaPluginId')) || [true, 'true', '1'].includes((file.supportsQuota ?? file.supports_quota) as boolean | string);
}
export function resolveQuotaPlugin(plugins: unknown[], provider: string) {
  const normalize = (value: unknown) => String(value || '').trim().toLowerCase().replace(/_/g, '-');
  const target = normalize(provider); if (!target) return '';
  const available = plugins.filter(isRecord).filter(row => row.registered === true && row.supportsQuota === true);
  for (const field of ['quotaProvider', 'id', 'oauthProvider']) {
    const matched = available.filter(row => normalize(row[field]) === target);
    if (matched.length === 1) return readString(matched[0], 'id');
    if (matched.length > 1) return '';
  }
  return '';
}
export function parsePluginQuota(payload: unknown): QuotaLine[] {
  if (!isRecord(payload) || (payload.groups !== undefined && !Array.isArray(payload.groups))) throw new Error('Invalid plugin quota response');
  const rows: QuotaLine[] = [];
  for (const group of Array.isArray(payload.groups) ? payload.groups : []) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      if (!isRecord(bucket)) continue;
      const fraction = bucket.remainingFraction ?? bucket.remaining_fraction;
      rows.push({ label: [readString(group, 'displayName', 'display_name'), readString(bucket, 'window', 'bucketId', 'bucket_id')].filter(Boolean).join(' · '),
        remainingPercent: typeof fraction === 'number' && Number.isFinite(fraction) ? Math.max(0, Math.min(100, fraction * 100)) : null,
        reset: readString(bucket, 'resetTime', 'reset_time') || undefined, detail: readString(bucket, 'description') || undefined });
    }
  }
  for (const metric of Array.isArray(payload.summary) ? payload.summary : []) {
    if (!isRecord(metric) || typeof metric.value !== 'number' || !Number.isFinite(metric.value)) continue;
    let detail = String(metric.value);
    if (metric.format === 'currency' && typeof metric.currency === 'string') {
      try { detail = new Intl.NumberFormat(undefined, { style: 'currency', currency: metric.currency }).format(metric.value); } catch { /* Unknown currency retains its numeric value. */ }
    } else if (typeof metric.unit === 'string') detail += ` ${metric.unit}`;
    rows.push({ label: readString(metric, 'label', 'key'), remainingPercent: null, detail });
  }
  return rows;
}
let pending: Promise<unknown> | null = null;
export async function loadPluginQuota(file: AuthFileRecord) {
  if (!supportsPluginQuota(file) || file.disabled === true) throw new Error('Plugin quota is unavailable');
  const authIndex = authFileCooldownResetIndex(file);
  if (!authIndex) throw new Error('Credential has no runtime index');
  let plugin = readString(file, 'quota_plugin_id', 'quotaPluginId');
  if (!plugin) {
    const provider = readString(file, 'quotaProvider', 'quota_provider');
    if (!provider) throw new Error('Credential has no quota provider');
    if (!pending) pending = managementApi.get('/plugins').finally(() => { pending = null; });
    const result = await pending;
    plugin = resolveQuotaPlugin(isRecord(result) && Array.isArray(result.plugins) ? result.plugins : [], provider);
  }
  if (!plugin) throw new Error('No unambiguous plugin quota route');
  return parsePluginQuota(await managementApi.post(`/plugins/${encodeURIComponent(plugin)}/quota`, { auth_index: authIndex }));
}
