import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpstreamsTab } from "./upstreams-tab";

// Smoke render for the upstreams tab: the batch-health runner references
// module-level memo state during render, so a plain mount is the regression
// guard for load-order crashes (TDZ) in this file — it has no other render
// coverage. Network-touching helpers are stubbed at the module boundary.

vi.mock("../lib/copy", () => ({ copy: (key) => key }));

const emptyRecords = { "codex-api-key": [], "openai-compatibility": [], deepseek: [], "claude-api-key": [], "gemini-api-key": [] };

vi.mock("../lib/easy-providers", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    providerGroupsApi: { get: vi.fn(async () => []) },
    resolveApiAccessRemarks: vi.fn(async () => []),
    managementApi: { request: vi.fn(async () => ({})) },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

it("renders the empty upstreams list without crashing at mount", async () => {
  render(<UpstreamsTab />);
  await waitFor(() => expect(screen.getAllByText("proxy.upstream.empty.none").length).toBeGreaterThan(0));
});
