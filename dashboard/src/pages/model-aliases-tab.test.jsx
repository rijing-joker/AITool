import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelAliasesTab } from "./model-aliases-tab";
import { fetchAliasEditContext, loadAliasState, submitCreateAlias } from "../lib/easy-aliases";

vi.mock("../lib/copy", () => ({ copy: (key, values) => values ? `${key} ${JSON.stringify(values)}` : key }));
vi.mock("../lib/easy-aliases", async (original) => ({
  ...await original(), loadAliasState: vi.fn(), fetchAliasEditContext: vi.fn(), submitCreateAlias: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("renders each mapping and explains the shared protocol scope when editing", async () => {
  const source = { id: "source", model: "model", displayName: null, provider: "relay", kind: "codex-api", protocol: "codex", reasoningLevels: ["high"] };
  const entries = [0, 1].map((keyIndex) => ({ mappingId: `mapping-${keyIndex}`, revision: "revision", alias: "shared", sourceModel: "model", provider: "relay", kind: "codex-api", protocol: "codex", keyIndex, effort: "high" }));
  const state = { thinkingEntries: entries, speedEntries: [], baseSources: [source], thinkingSources: [source], speedSources: [source] };
  loadAliasState.mockResolvedValue(state);
  fetchAliasEditContext.mockResolvedValue({ mappingId: "mapping-1", revision: "fresh", source, effort: "high", fast: false });
  submitCreateAlias.mockResolvedValue(state);
  render(<ModelAliasesTab />);
  await waitFor(() => expect(screen.getAllByText("shared")).toHaveLength(2));
  expect(screen.getByText('proxy.alias.source.keyScope {"index":2}')).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "proxy.upstream.common.edit" })[1]);
  expect(await screen.findByText('proxy.alias.aliasName.sharedParameters {"count":1,"protocol":"codex"}')).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "proxy.upstream.common.save" }));
  await waitFor(() => expect(submitCreateAlias).toHaveBeenCalledWith(expect.objectContaining({ editingEntry: expect.objectContaining({ mappingId: "mapping-1", revision: "fresh" }), editingRevision: "fresh" })));
});

it("closes an untouched alias immediately but protects an edited alias", async () => {
  const source = { id: "source", model: "model", provider: "relay", kind: "codex-api", protocol: "codex", reasoningLevels: ["high"] };
  const entry = { mappingId: "mapping", revision: "revision", alias: "original", sourceModel: "model", provider: "relay", kind: "codex-api", protocol: "codex", effort: "high" };
  loadAliasState.mockResolvedValue({ thinkingEntries: [entry], speedEntries: [], baseSources: [source], thinkingSources: [source], speedSources: [source] });
  fetchAliasEditContext.mockResolvedValue({ mappingId: "mapping", revision: "revision", source, effort: "high", fast: false });
  render(<ModelAliasesTab />);
  fireEvent.click(await screen.findByRole("button", { name: "proxy.upstream.common.edit" }));
  fireEvent.click(await screen.findByRole("button", { name: "proxy.upstream.common.close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.queryByText("shared.unsaved.title")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "proxy.upstream.common.edit" }));
  const name = await screen.findByDisplayValue("original");
  fireEvent.change(name, { target: { value: "modified" } });
  fireEvent.click(screen.getByRole("button", { name: "proxy.upstream.common.cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "shared.unsaved.keep_editing" }));
  expect(name).toHaveValue("modified");
  fireEvent.click(screen.getByRole("button", { name: "proxy.upstream.common.cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "shared.unsaved.discard" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(submitCreateAlias).not.toHaveBeenCalled();
});
