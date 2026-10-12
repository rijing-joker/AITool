// Universal providers (cc-switch's 统一供应商, provider.rs + services/provider):
// one shared base URL + API key projected into per-app child providers. The
// children are ordinary rows in the per-app stores with deterministic ids
// (universal-<app>-<id>), so switching, editor views and failover treat them
// like any other provider; sync keeps them aligned with the parent and
// re-projects the live files of whichever app currently uses the child.

const store = require("./store");

// cc-switch's to_claude_provider: unset roles fall back to the main model,
// which itself falls back to a fixed modern Sonnet id.
const CLAUDE_DEFAULT_MODEL = "claude-sonnet-4-20250514";
const CODEX_DEFAULT_MODEL = "gpt-4o";
const CODEX_DEFAULT_REASONING_EFFORT = "high";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-pro";

function sanitizeUniversalProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error("Universal provider payload required");
  }
  if (!provider.id || typeof provider.id !== "string") {
    throw new Error("Universal provider id is required");
  }
  return provider;
}

function codexBaseUrl(baseUrl) {
  // Codex/OpenAI base URLs are either a bare origin (needs /v1 appended) or
  // carry a custom path prefix (must not get a version segment forced on).
  const baseTrimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  const originOnly = (() => {
    const schemeIndex = baseTrimmed.indexOf("://");
    const rest = schemeIndex === -1 ? baseTrimmed : baseTrimmed.slice(schemeIndex + 3);
    return !rest.includes("/");
  })();
  if (baseTrimmed.endsWith("/v1")) return baseTrimmed;
  if (originOnly) return `${baseTrimmed}/v1`;
  return baseTrimmed;
}

// to_claude_provider / to_codex_provider / to_gemini_provider. Returns null
// when the app is disabled for this universal provider — sync then removes
// the stale child. The fork has no "aggregator" category; children are plain
// "custom" rows (deliberate divergence, categories here are official|custom).
function toChildProvider(app, provider) {
  if (!provider.apps?.[app]) return null;
  const childId = `universal-${app}-${provider.id}`;
  const base = {
    id: childId,
    name: provider.name,
    notes: provider.notes || "",
    websiteUrl: provider.websiteUrl || "",
    icon: provider.icon || "",
    iconColor: provider.iconColor || "",
    meta: provider.meta || undefined,
    createdAt: provider.createdAt,
    sortIndex: provider.sortIndex,
  };
  if (app === "claude") {
    const models = provider.models?.claude || {};
    const model = models.model || CLAUDE_DEFAULT_MODEL;
    return {
      ...base,
      category: "custom",
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: provider.baseUrl,
          ANTHROPIC_AUTH_TOKEN: provider.apiKey,
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haikuModel || model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: models.sonnetModel || model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: models.opusModel || model,
        },
      },
    };
  }
  if (app === "codex") {
    const models = provider.models?.codex || {};
    const model = models.model || CODEX_DEFAULT_MODEL;
    const reasoningEffort = models.reasoningEffort || CODEX_DEFAULT_REASONING_EFFORT;
    return {
      ...base,
      category: "custom",
      settingsConfig: {
        auth: { OPENAI_API_KEY: provider.apiKey },
        config: {
          model_provider: "custom",
          model,
          model_reasoning_effort: reasoningEffort,
          disable_response_storage: true,
          model_providers: {
            custom: {
              name: "NewAPI",
              base_url: codexBaseUrl(provider.baseUrl),
              wire_api: "responses",
              requires_openai_auth: true,
            },
          },
        },
      },
    };
  }
  // gemini
  const model = provider.models?.gemini?.model || GEMINI_DEFAULT_MODEL;
  return {
    ...base,
    category: "custom",
    settingsConfig: {
      env: {
        GOOGLE_GEMINI_BASE_URL: provider.baseUrl,
        GEMINI_API_KEY: provider.apiKey,
        GEMINI_MODEL: model,
      },
    },
  };
}

// Recursive JSON merge (upstream merge_json): base is the floor, patch wins
// same-named fields; everything else keeps the child's app-specific values.
function deepMerge(base, patch) {
  if (base === null || typeof base !== "object" || Array.isArray(base) || typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return patch;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

// Upstream sync_universal_to_apps, reduced to the fork's store: per app,
// either upsert the merged child or remove the stale one; re-project live
// files only when the child is that app's current provider (same interaction
// rule as editing the current provider — one broken config must not stop the
// other apps, but the failure is reported instead of returning success).
// `applyCurrent(app, childId)` is injected by api.js (the switch projection).
async function syncUniversalToApps({ id, applyCurrent }) {
  const provider = sanitizeUniversalProvider(await store.getUniversalProvider(id));
  const failures = [];
  for (const app of store.UNIVERSAL_APPS) {
    const child = toChildProvider(app, provider);
    if (child) {
      const existing = await store.getProvider(app, child.id);
      if (existing) {
        child.settingsConfig = deepMerge(existing.settingsConfig, child.settingsConfig);
        // The existing child's app-specific config and ordering are not
        // universal-managed fields (upstream keeps meta/createdAt/sortIndex).
        child.meta = existing.meta;
        child.createdAt = existing.createdAt;
        child.sortIndex = existing.sortIndex;
      }
      await store.putUniversalChildProvider(app, child);
      const state = await store.listProviders(app);
      if (state.current === child.id) {
        try {
          await applyCurrent(app, child.id);
        } catch (error) {
          failures.push(`${app}: ${error?.message || error}`);
        }
      }
    } else {
      await store.deleteProvider(app, `universal-${app}-${id}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Universal provider saved, but these apps' live files could not be written: ${failures.join("; ")}`);
  }
  return { ok: true };
}

// delete_universal: remove the parent and every child it generated.
async function deleteUniversalAndChildren(id) {
  const removed = await store.deleteUniversalProvider(id);
  if (!removed) return false;
  for (const app of store.UNIVERSAL_APPS) {
    await store.deleteProvider(app, `universal-${app}-${id}`);
  }
  return true;
}

module.exports = {
  UNIVERSAL_APPS: store.UNIVERSAL_APPS,
  codexBaseUrl,
  toChildProvider,
  deepMerge,
  syncUniversalToApps,
  deleteUniversalAndChildren,
};
