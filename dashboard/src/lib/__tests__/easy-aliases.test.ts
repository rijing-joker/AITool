import { afterEach, expect, it, vi } from "vitest";
import { combineModelAliasEntries, fetchAliasEditContext, submitCreateAlias, submitDeleteAlias } from "../easy-aliases";
vi.mock("../local-api-auth", () => ({ getLocalApiAuthHeaders: async () => ({}) }));
afterEach(() => vi.unstubAllGlobals());

const base = { alias: "shared", sourceModel: "model", provider: "relay", kind: "codex-api", effort: "high", serviceTier: null };

it("keeps duplicate alias mappings separate and combines options only for the same mapping", () => {
  const rows = combineModelAliasEntries([
    { ...base, mappingId: "group" }, { ...base, mappingId: "key", keyIndex: 0 },
  ], [{ ...base, mappingId: "key", serviceTier: "priority" }]);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.mappingId === "group")?.serviceTier).toBeNull();
  expect(rows.find((row) => row.mappingId === "key")?.serviceTier).toBe("priority");
  expect(combineModelAliasEntries([base], [{ ...base, serviceTier: "priority" }])).toHaveLength(1);
});

it("sends concrete mapping identity and its revision through existing routes", async () => {
  const fetcher = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, state: {}, context: {} }) });
  vi.stubGlobal("fetch", fetcher);
  const entry = { ...base, mappingId: "key", revision: "revision-a", section: "codex-api-key", providerIndex: 0, modelIndex: 1 };
  await fetchAliasEditContext(entry);
  await submitCreateAlias({ sourceId: "source", alias: "edited", effort: "high", fast: true, editingEntry: entry, editingRevision: "revision-b" });
  await submitDeleteAlias(entry);
  const bodies = fetcher.mock.calls.map(([, options]) => JSON.parse(options.body));
  expect(bodies.every((body) => body.mappingId === "key")).toBe(true);
  expect(bodies[0]).toMatchObject({ action: "edit-source", revision: "revision-a" });
  expect(bodies[1]).toMatchObject({ action: "create", originalAlias: "shared", expectedRevision: "revision-b" });
  expect(bodies[2]).toMatchObject({ action: "delete", revision: "revision-a" });
});
