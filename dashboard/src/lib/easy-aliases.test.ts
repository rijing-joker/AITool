import { expect, it } from "vitest";
import { combineModelAliasEntries } from "./easy-aliases";

// easy 209e159: rows are keyed by configuration position, not by content —
// a provider may legitimately carry two identical aliases at different
// positions, and content-keyed folding turns the losing one into an
// invisible-but-active ghost alias.
it("keeps duplicate aliases that live at different config positions", () => {
  const thinking = [
    { sourceModel: "gpt-5", alias: "gpt-5-fast", effort: "high", provider: "Provider", kind: "openai-compatible", section: "openai-compatibility", providerIndex: 0, modelIndex: 0 },
    { sourceModel: "gpt-5", alias: "gpt-5-fast", effort: "low", provider: "Provider", kind: "openai-compatible", section: "openai-compatibility", providerIndex: 1, modelIndex: 0 },
  ];
  const rows = combineModelAliasEntries(thinking, []);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.effort).sort()).toEqual(["high", "low"]);
});

it("merges the thinking and fast aliases of one position into a single row", () => {
  const thinking = [
    { sourceModel: "gpt-5", alias: "swift", effort: "medium", provider: "Provider", kind: "codex-api", section: "codex-api-key", providerIndex: 0, modelIndex: 2 },
  ];
  const speed = [
    { sourceModel: "gpt-5", alias: "swift", serviceTier: "priority", provider: "Provider", kind: "codex-api", section: "codex-api-key", providerIndex: 0, modelIndex: 2 },
  ];
  const rows = combineModelAliasEntries(thinking, speed);
  expect(rows).toHaveLength(1);
  expect(rows[0].effort).toBe("medium");
  expect(rows[0].serviceTier).toBe("priority");
});
