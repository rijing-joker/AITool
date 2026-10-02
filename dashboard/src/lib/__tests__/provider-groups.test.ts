import { describe, expect, it } from "vitest";

import {
  buildProviderGroupRecord,
  cleanProviderGroup,
  effectiveProviderKey,
  hasDuplicateProviderRecord,
  providerGroupKeys,
  providerGroupStatus,
  providerKeyDraft,
  providerKeyOverrides,
  rowFromRecord,
  serializeProviderKey,
  validateProviderGroupKeys,
} from "../easy-providers";

// Native v8 provider groups (EasyCLIProxyAPI be9a2b6 port): groups carry
// keys[] whose entries inherit the group's fields unless they override them
// (null = explicit inherit). Rows display groups as one unit and saves must
// round-trip the structure instead of flattening it.

const gatewayGroup = () => ({
  name: "gateway",
  "base-url": "https://example.test/v1",
  priority: 3,
  models: [{ name: "gpt-x" }],
  keys: [
    { "api-key": "first", weight: 2, priority: null },
    { "api-key": "second", weight: 5, models: null, "excluded-models": ["*"] },
    { "api-key": "third", models: [{ name: "private" }] },
  ],
});

describe("provider group helpers", () => {
  it("reads group keys and drafts copies", () => {
    const group = gatewayGroup();
    expect(providerGroupKeys(group)).toHaveLength(3);
    expect(providerGroupKeys({})).toEqual([]);
    const draft = providerKeyDraft({ "api-key": "k" });
    expect(draft.value).toEqual({ "api-key": "k" });
    draft.value["api-key"] = "mutated";
    expect(providerKeyDraft({ "api-key": "k" }).value).toEqual({ "api-key": "k" });
  });

  it("merges inherited and overriding fields per key", () => {
    const group = gatewayGroup();
    const [first, second, third] = providerGroupKeys(group);
    expect(effectiveProviderKey(group, first)).toMatchObject({
      "base-url": "https://example.test/v1",
      // null restores group inheritance even though the key lists the field
      priority: 3,
      weight: 2,
    });
    expect(effectiveProviderKey(group, third)).toMatchObject({
      models: [{ name: "private" }],
      priority: 3,
    });
    expect(second).toMatchObject({ "excluded-models": ["*"] });
  });

  it("computes group status from per-key disable states", () => {
    const group = gatewayGroup();
    // key[1] carries excluded-models ["*"] => partial
    expect(providerGroupStatus(group)).toBe("partial");
    const allOff = {
      ...group,
      keys: group.keys.map((key) => ({ ...key, "excluded-models": ["*"] })),
    };
    expect(providerGroupStatus(allOff)).toBe("disabled");
    expect(providerGroupStatus({ name: "empty", keys: [] })).toBe("enabled");
    expect(providerGroupStatus({ name: "off", disabled: true })).toBe("disabled");
  });

  it("lists per-key overrides excluding identity fields", () => {
    const key = { "api-key": "k", weight: 3, "proxy-url": "socks5://x", "auth-index": "0", models: null };
    expect(providerKeyOverrides(key)).toEqual(["proxy-url"]);
  });

  it("validates key drafts and reports the offending field", () => {
    const good = [providerKeyDraft({ "api-key": "k", weight: 5 })];
    expect(validateProviderGroupKeys(good)).toBeNull();
    expect(validateProviderGroupKeys([providerKeyDraft({ "api-key": "" })])).toBe("key");
    expect(validateProviderGroupKeys([providerKeyDraft({ "api-key": "k", weight: 2_000_000 })])).toBe("weight");
    expect(validateProviderGroupKeys([providerKeyDraft({ "api-key": "k", priority: 1.5 })])).toBe("priority");
    expect(validateProviderGroupKeys([providerKeyDraft({ "api-key": "k", models: [{ alias: "x" }] })])).toBe("models");
  });

  it("serializes drafts, applying text fields and trimming the key", () => {
    const draft = providerKeyDraft({ "api-key": "  sk-1  ", "excluded-models": [] });
    draft.text = {
      headers: "X-A: 1\nX-B: 2",
      "excluded-models": "gpt-*, o1-*",
      "cloak-words": "alpha, beta",
    };
    const value = serializeProviderKey(draft);
    expect(value["api-key"]).toBe("sk-1");
    expect(value.headers).toEqual({ "X-A": "1", "X-B": "2" });
    expect(value["excluded-models"]).toEqual(["gpt-*", "o1-*"]);
    expect(value.cloak).toEqual({ "sensitive-words": ["alpha", "beta"] });
    expect(() => serializeProviderKey({
      ...providerKeyDraft({}),
      text: { headers: "bad header line" },
    } as never)).toThrow(/Invalid key header/);
  });

  it("cleans response-only fields from groups recursively", () => {
    const group = {
      name: "g",
      "auth-index": "3",
      keys: [{ "api-key": "k", authIndex: "1", "test-model": "m" }],
    };
    const clean = cleanProviderGroup(group);
    expect(clean).toEqual({ name: "g", keys: [{ "api-key": "k" }] });
  });

  it("projects a group row with status and per-key models", () => {
    const record = gatewayGroup();
    const row = rowFromRecord("codex-api-key", record, 0);
    expect(row.name).toBe("gateway");
    expect(row.apiKeys).toEqual(["first", "second", "third"]);
    // the row shows the group's shared models; per-key model overrides only
    // surface through the effective merge (health dialog)
    expect(row.models.map((model) => model.name)).toEqual(["gpt-x"]);
    expect(row.disabled).toBe(false);
    const allOff = {
      ...record,
      keys: record.keys.map((key) => ({ ...key, "excluded-models": ["*"] })),
    };
    expect(rowFromRecord("codex-api-key", allOff, 0).disabled).toBe(true);
  });

  it("flags duplicate groups by name only", () => {
    const current = [gatewayGroup()];
    const candidate = { ...gatewayGroup(), keys: [{ "api-key": "other" }] };
    expect(hasDuplicateProviderRecord("codex-api-key", current, [candidate])).toBe(true);
    const renamed = { ...candidate, name: "other" };
    expect(hasDuplicateProviderRecord("codex-api-key", current, [renamed])).toBe(false);
  });

  it("builds a group record that preserves unedited shared fields", () => {
    const current = gatewayGroup();
    const draft = {
      groupKeys: providerGroupKeys(current).map(providerKeyDraft),
      name: "gateway",
      apiKey: "",
      remark: "",
      baseUrl: "https://example.test/v1",
      proxyUrl: "",
      priority: "3",
      models: [{ name: "gpt-x" }],
      headersText: "",
      excludedModelsText: "",
    } as never;
    const next = buildProviderGroupRecord("codex-api-key", draft, current) as Record<string, unknown>;
    expect(next.name).toBe("gateway");
    expect(next["base-url"]).toBe("https://example.test/v1");
    expect(next.priority).toBe(3);
    expect(Array.isArray(next.keys)).toBe(true);
    expect((next.keys as Record<string, unknown>[]).map((key) => key["api-key"])).toEqual(["first", "second", "third"]);
    expect(next["api-key"]).toBeUndefined();
    expect(next["api-key-entries"]).toBeUndefined();
  });
});
