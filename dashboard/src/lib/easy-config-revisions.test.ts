import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { providerGroupsApi } from "./easy-providers";

vi.mock("./local-api-auth", () => ({ getLocalApiAuthHeaders: async () => ({}) }));
vi.mock("./copy", () => ({ copy: (key: string) => key }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

it("uses the edited array's revision even after another view loads newer config", async () => {
  let reads = 0;
  let sentRevision;
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    const request = JSON.parse(options.body).request;
    if (request.method === "GET") {
      reads++;
      return { json: async () => ({ ok: true, etag: `"${reads}"`, value: [{ name: "group", keys: [{ "api-key": `key-${reads}` }] }] }) };
    }
    sentRevision = request.ifMatch;
    return { status: 412, json: async () => ({ ok: false, error: "PROXY_CONFIG_CONFLICT" }) };
  }));
  const first = await providerGroupsApi.get("codex-api-key");
  await providerGroupsApi.get("codex-api-key");
  await expect(providerGroupsApi.put("codex-api-key", [{ ...first[0], name: "edited" }], first)).rejects.toThrow("proxy.settings.conflict");
  expect(sentRevision).toBe('"1"');
});

it("resolves an initially missing section from a versioned root snapshot before adding a group", async () => {
  const calls: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    const request = JSON.parse(options.body).request;
    calls.push(request);
    if (calls.length === 1) return { json: async () => ({ ok: false, error: "Management API error (404): not_found" }) };
    if (request.method === "GET") return { json: async () => ({ ok: true, etag: '"root"', value: { "api-keys": {} } }) };
    return { json: async () => ({ ok: true, etag: '"next"', value: {} }) };
  }));
  const first = await providerGroupsApi.get("claude-api-key");
  expect(first).toEqual([]);
  await providerGroupsApi.put("claude-api-key", [{ name: "new", keys: [] }], first);
  expect(calls[1].path).toBe("/config");
  expect(calls[2].ifMatch).toBe('"root"');
});
