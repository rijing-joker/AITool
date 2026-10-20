const { sha256Hex, maskApiKey } = require("./usage-record");

const text = (value) => String(value ?? "").trim();
const sections = { grok: "xai-api-key", xai: "xai-api-key", codex: "codex-api-key", claude: "claude-api-key", anthropic: "claude-api-key", gemini: "gemini-api-key", vertex: "vertex-api-key", meta: "meta-api-key", interactions: "interactions-api-key" };

function upstreamIdentity(row) {
  const index = text(row.auth_index);
  return index ? `auth:${index}` : `provider:${text(row.provider)}`;
}

// Notes are presentation only. Never use a raw source (possibly a secret) as
// a label or filter identity; ambiguous notes fall back to the route identity.
function createUsageLabeler({ keys = [], remarks = {}, providerRemarks = [], credentials = [] } = {}) {
  const keyLabels = new Map();
  for (const value of keys) {
    const key = text(typeof value === "string" ? value : value?.key);
    if (key) keyLabels.set(sha256Hex(key), { api_key_display: maskApiKey(key), api_key_remark: text(remarks[key]) });
  }
  const notes = new Map();
  for (const file of credentials) {
    const index = text(file.auth_index);
    const note = text(file.note);
    if (!index || !note) continue;
    if (!notes.has(index)) notes.set(index, note);
    else if (notes.get(index) !== note) notes.set(index, null);
  }
  return (row) => {
    const current = keyLabels.get(row.api_key_hash);
    const index = text(row.auth_index);
    const provider = text(row.provider);
    const section = sections[provider.toLowerCase()] || "openai-compatibility";
    const keyHash = text(row.source_hash) || sha256Hex(text(row.source));
    const candidates = new Set(providerRemarks.filter((entry) => entry.section === section && entry.keyHash === keyHash).map((entry) => text(entry.remark)).filter(Boolean));
    // Unknown/custom routes cannot resolve a group note from key alone.
    const apiNote = sections[provider.toLowerCase()] && candidates.size === 1 ? [...candidates][0] : "";
    const note = notes.get(index) || apiNote;
    const base = [provider, note].filter(Boolean).join(" · ") || "—";
    return {
      ...row, ...current,
      upstream: upstreamIdentity(row),
      source_display: index ? `${base} · ${index.slice(-6)}` : provider || "—",
    };
  };
}

function usageFilterOptions(rows) {
  const keys = new Map(), upstreams = new Map();
  for (const row of rows) {
    if (row.api_key_hash && !keys.has(row.api_key_hash)) keys.set(row.api_key_hash, {
      key: row.api_key_hash, label: row.api_key_remark || row.api_key_display || row.api_key_hash.slice(0, 12),
    });
    if (!upstreams.has(row.upstream)) upstreams.set(row.upstream, { key: row.upstream, label: row.source_display });
  }
  return {
    keys: [...keys.values()], upstreams: [...upstreams.values()],
    models: [...new Set(rows.map((row) => text(row.response_model || row.model)).filter(Boolean))],
    providers: [...new Set(rows.map((row) => text(row.provider)).filter(Boolean))],
  };
}

module.exports = { upstreamIdentity, createUsageLabeler, usageFilterOptions };
