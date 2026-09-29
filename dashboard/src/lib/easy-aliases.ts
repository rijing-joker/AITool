// Client + ported pure helpers for EasyCLIProxyAPI's ThinkingAliasesPage
// (model aliases: plain / reasoning-effort / fast service-tier). The YAML
// engine itself runs Node-side in src/lib/proxy/alias-config.js; this module
// carries the page-level helpers (combine/default/unique alias, search scoring)
// verbatim from the original TSX.

import { copy } from "./copy";
import { getLocalApiAuthHeaders } from "./local-api-auth";

export type ThinkingAliasEntry = {
  sourceModel: string;
  alias: string;
  effort: string | null;
  provider: string;
  kind: string;
  oauthChannel?: string | null;
  section?: string | null;
  providerIndex?: number | null;
  modelIndex?: number | null;
};

export type SpeedAliasEntry = {
  sourceModel: string;
  alias: string;
  serviceTier: string;
  provider: string;
  kind: string;
  oauthChannel?: string | null;
  section?: string | null;
  providerIndex?: number | null;
  modelIndex?: number | null;
};

export type AliasListEntry = ThinkingAliasEntry & {
  serviceTier: string | null;
};

export type ThinkingAliasSource = {
  id: string;
  model: string;
  displayName: string | null;
  provider: string;
  kind: string;
  protocol: string;
  reasoningLevels: string[];
};

export type ModelAliasSource = ThinkingAliasSource & {
  supportsReasoning: boolean;
  supportsFast: boolean;
};

export type ModelAliasEditContext = {
  source: ThinkingAliasSource;
  revision: string;
  effort: string | null;
  fast: boolean;
};

export type AliasState = {
  thinkingEntries: ThinkingAliasEntry[];
  speedEntries: SpeedAliasEntry[];
  baseSources: ThinkingAliasSource[];
  thinkingSources: ThinkingAliasSource[];
  speedSources: ThinkingAliasSource[];
};

type AliasRequest = Record<string, unknown> & { action: string };

async function aliasConfig<T>(body: AliasRequest): Promise<T> {
  const headers = await getLocalApiAuthHeaders();
  const response = await fetch("/api/proxy/alias-config", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | { ok: boolean; state?: AliasState; context?: ModelAliasEditContext; error?: string }
    | null;
  if (!payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  if (body.action === "load") return payload.state as T;
  if (body.action === "edit-source") return payload.context as T;
  return payload.state as T;
}

export const loadAliasState = () => aliasConfig<AliasState>({ action: "load" });

export const fetchAliasEditContext = (entry: {
  alias: string;
  oauthChannel?: string | null;
  section?: string | null;
  providerIndex?: number | null;
  modelIndex?: number | null;
}) => aliasConfig<ModelAliasEditContext>({
  action: "edit-source",
  alias: entry.alias,
  section: entry.section ?? undefined,
  providerIndex: entry.providerIndex ?? undefined,
  modelIndex: entry.modelIndex ?? undefined,
});

const aliasLocationArgs = (entry: {
  oauthChannel?: string | null;
  section?: string | null;
  providerIndex?: number | null;
  modelIndex?: number | null;
}) => ({
  oauthChannel: entry.oauthChannel ?? undefined,
  section: entry.section ?? undefined,
  providerIndex: entry.providerIndex ?? undefined,
  modelIndex: entry.modelIndex ?? undefined,
});

export const submitCreateAlias = (input: {
  sourceId: string;
  alias: string;
  effort: string;
  fast: boolean;
  editingEntry: AliasListEntry | null;
  editingRevision: string | null;
}) => {
  if (input.editingEntry) {
    return aliasConfig<AliasState>({
      action: "create",
      sourceId: input.sourceId,
      alias: input.alias,
      effort: input.effort,
      fast: input.fast,
      originalAlias: input.editingEntry.alias,
      expectedRevision: input.editingRevision ?? undefined,
      ...aliasLocationArgs(input.editingEntry),
    });
  }
  return aliasConfig<AliasState>({
    action: "create",
    sourceId: input.sourceId,
    alias: input.alias,
    effort: input.effort,
    fast: input.fast,
  });
};

export const submitDeleteAlias = (entry: AliasListEntry) =>
  aliasConfig<AliasState>({
    action: "delete",
    alias: entry.alias,
    kind: entry.effort || !entry.serviceTier ? "thinking" : "speed",
    ...aliasLocationArgs(entry),
  });

// ---------------------------------------------------------------------------
// ThinkingAliasesPage pure helpers (verbatim)
// ---------------------------------------------------------------------------

export const combineModelAliasEntries = (
  thinkingEntries: ThinkingAliasEntry[],
  speedEntries: SpeedAliasEntry[],
): AliasListEntry[] => {
  const entries = new Map<string, AliasListEntry>();
  const entryKey = (
    entry: Pick<ThinkingAliasEntry, "kind" | "provider" | "sourceModel" | "alias" | "oauthChannel">,
  ) => (
    [entry.oauthChannel ?? "", entry.kind, entry.provider, entry.sourceModel, entry.alias]
      .map((value) => value.toLocaleLowerCase())
      .join("\u0000")
  );

  thinkingEntries.forEach((entry) => {
    entries.set(entryKey(entry), { ...entry, serviceTier: null });
  });
  speedEntries.forEach((entry) => {
    const key = entryKey(entry);
    const current = entries.get(key);
    entries.set(key, current
      ? { ...current, serviceTier: entry.serviceTier }
      : { ...entry, effort: null });
  });

  return [...entries.values()].sort((left, right) => (
    left.provider.localeCompare(right.provider)
      || left.alias.localeCompare(right.alias)
  ));
};

export const combineModelAliasSources = (
  baseSources: ThinkingAliasSource[],
  thinkingSources: ThinkingAliasSource[],
  speedSources: ThinkingAliasSource[],
): ModelAliasSource[] => {
  const reasoningSourceIds = new Set(thinkingSources.map((source) => source.id));
  const speedSourceIds = new Set(speedSources.map((source) => source.id));
  const sources = new Map<string, ModelAliasSource>();
  [...baseSources, ...speedSources, ...thinkingSources].forEach((source) => {
    sources.set(source.id, {
      ...source,
      supportsReasoning: reasoningSourceIds.has(source.id),
      supportsFast: speedSourceIds.has(source.id),
    });
  });
  return [...sources.values()];
};

export const defaultModelAlias = (
  model: string | null | undefined,
  effort: string,
  fast: boolean,
) => {
  const normalizedModel = model?.trim() ?? "";
  const normalizedEffort = effort.trim().toLowerCase();
  if (!normalizedModel) return "";
  if (!normalizedEffort && !fast) return `${normalizedModel}-alias`;
  return `${normalizedModel}${normalizedEffort ? `-${normalizedEffort}` : ""}${fast ? "-fast" : ""}`;
};

export const uniqueModelAlias = (
  alias: string,
  existingModelNames: string[],
) => {
  const normalizedAlias = alias.trim();
  if (!normalizedAlias) return "";
  const existingNames = new Set(
    existingModelNames
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!existingNames.has(normalizedAlias.toLowerCase())) return normalizedAlias;

  let suffix = 2;
  let candidate = `${normalizedAlias}-${suffix}`;
  while (existingNames.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${normalizedAlias}-${suffix}`;
  }
  return candidate;
};

export const usableModelAlias = (value: string | undefined | null): string => {
  const alias = value?.trim() ?? "";
  if (!alias || alias.length > 240) return "";
  for (const character of alias) {
    const code = character.charCodeAt(0);
    if (character.trim() === "" || code < 32 || code === 127) return "";
  }
  return alias;
};

export const thinkingAliasSourceKindLabel = (kind: string) => {
  if (kind === "codex-oauth") return "Codex OAuth";
  if (kind === "antigravity-oauth") return "Antigravity OAuth";
  if (kind === "claude-oauth") return "Claude OAuth";
  if (kind === "aistudio-oauth") return "AI Studio OAuth";
  if (kind === "vertex-oauth") return "Vertex OAuth";
  if (kind === "kimi-oauth") return "Kimi OAuth";
  if (kind === "xai-oauth") return "xAI OAuth";
  if (kind === "devin-oauth") return "Devin OAuth";
  if (kind === "codex-api") return "Codex API";
  if (kind === "claude-api") return "Claude API";
  if (kind === "gemini-api") return "Gemini API";
  if (kind === "openai-compatible") return copy("proxy.alias.source.openAiCompatible");
  return copy("proxy.alias.source.other");
};

export const thinkingAliasProviderDetail = (kind: string, provider: string) => (
  provider === thinkingAliasSourceKindLabel(kind)
    ? copy("proxy.alias.source.available")
    : provider
);

export type PresetEffortOption = { value: string; label: string; hintKey: string };

export const EFFORT_OPTIONS: PresetEffortOption[] = [
  { value: "low", label: "Low", hintKey: "proxy.alias.effort.low" },
  { value: "medium", label: "Medium", hintKey: "proxy.alias.effort.medium" },
  { value: "high", label: "High", hintKey: "proxy.alias.effort.high" },
  { value: "xhigh", label: "XHigh", hintKey: "proxy.alias.effort.xhigh" },
  { value: "max", label: "Max", hintKey: "proxy.alias.effort.max" },
];

export const scoreAliasSources = (
  sources: ModelAliasSource[],
  query: string,
): ModelAliasSource[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return sources;
  return sources
    .map((source, index) => {
      const model = source.model.toLowerCase();
      const displayName = (source.displayName ?? "").toLowerCase();
      const haystack = `${model} ${displayName} ${source.provider} ${thinkingAliasSourceKindLabel(source.kind)}`
        .toLowerCase();
      let score = 5;
      if (model === normalized) score = 0;
      else if (displayName === normalized) score = 1;
      else if (model.startsWith(normalized)) score = 2;
      else if (displayName.startsWith(normalized)) score = 3;
      else if (haystack.includes(normalized)) score = 4;
      return { source, index, score };
    })
    .filter((item) => item.score < 5)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((item) => item.source);
};
