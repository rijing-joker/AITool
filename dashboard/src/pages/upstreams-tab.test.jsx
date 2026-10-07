import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { providerGroupsApi } from "../lib/easy-providers";
import { UpstreamsTab } from "./upstreams-tab";

// Smoke render for the upstreams tab: the batch-health runner references
// module-level memo state during render, so a plain mount is the regression
// guard for load-order crashes (TDZ) in this file — it has no other render
// coverage. Network-touching helpers are stubbed at the module boundary.

vi.mock("../lib/copy", () => ({ copy: (key) => key }));

const emptyRecords = { "codex-api-key": [], "openai-compatibility": [], deepseek: [], "claude-api-key": [], "gemini-api-key": [] };

const MODEL_CATALOG = [{ name: "gpt-4o" }, { name: "gpt-4o-mini", alias: "fast" }, { name: "o3-mini" }];

vi.mock("../lib/easy-providers", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    providerGroupsApi: { get: vi.fn(async () => []), put: vi.fn(async () => ({})) },
    resolveApiAccessRemarks: vi.fn(async () => []),
    managementApi: { request: vi.fn(async () => ({})), put: vi.fn(async () => ({})) },
    fetchModels: vi.fn(async () => MODEL_CATALOG),
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

const NAME_LABEL = "proxy.upstream.models.namePlaceholder";

const editDialogRecord = () => ({
  name: "OpenAI",
  "base-url": "https://api.openai.com",
  "api-key-entries": [{ "api-key": "sk-test" }],
  models: [{ name: "gpt-4o" }, { name: "gpt-4o-mini", alias: "fast" }, { name: "o3-mini" }],
});

const openEditDialog = async () => {
  const record = editDialogRecord();
  providerGroupsApi.get.mockImplementation(async (section) => {
    return section === "openai-compatibility" ? [record] : [];
  });
  render(<UpstreamsTab />);
  await waitFor(() => expect(screen.getByRole("button", { name: /proxy\.upstream\.provider\.openaiCompat/ })).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: /proxy\.upstream\.provider\.openaiCompat/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "proxy.upstream.common.edit" })).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "proxy.upstream.common.edit" }));
  return screen.findAllByLabelText(NAME_LABEL);
};

const fetchCatalogInDialog = async (inputs) => {
  fireEvent.click(screen.getByRole("button", { name: "proxy.upstream.models.fetch" }));
  const apply = await screen.findByRole("button", { name: "proxy.upstream.modelDialog.apply" });
  await waitFor(() => expect(apply).not.toHaveAttribute("disabled"));
  fireEvent.click(apply);
  await waitFor(() => expect(screen.queryByRole("button", { name: "proxy.upstream.modelDialog.apply" })).toBeNull());
  return inputs;
};

const suggestionTexts = () =>
  within(screen.getByRole("listbox", { name: NAME_LABEL })).getAllByRole("option").map((option) => option.textContent);

it("suggests the fetched model catalog in the model-name field and filters while typing", async () => {
  const inputs = await fetchCatalogInDialog(await openEditDialog());
  fireEvent.focus(inputs[0]);
  // The field starts filled with the configured name, so the open list shows
  // the exact match plus catalog entries extending it.
  expect(suggestionTexts()).toEqual(["gpt-4o", "gpt-4o-minifast"]);
  fireEvent.change(inputs[0], { target: { value: "mini" } });
  expect(suggestionTexts()).toEqual(["gpt-4o-minifast", "o3-mini"]);
});

it("fills the model name from a picked suggestion and keeps free text without suggestions", async () => {
  const inputs = await fetchCatalogInDialog(await openEditDialog());
  fireEvent.focus(inputs[0]);
  fireEvent.change(inputs[0], { target: { value: "mini" } });
  fireEvent.mouseDown(within(screen.getByRole("listbox", { name: NAME_LABEL })).getAllByRole("option")[0]);
  await waitFor(() => expect(inputs[0]).toHaveValue("gpt-4o-mini"));
  expect(screen.queryByRole("listbox", { name: NAME_LABEL })).toBeNull();

  fireEvent.change(inputs[0], { target: { value: "my-custom-model" } });
  expect(inputs[0]).toHaveValue("my-custom-model");
  expect(screen.queryByRole("listbox", { name: NAME_LABEL })).toBeNull();
});

it("completes a partial name with the keyboard and closes on Escape", async () => {
  const inputs = await fetchCatalogInDialog(await openEditDialog());
  fireEvent.focus(inputs[0]);
  fireEvent.change(inputs[0], { target: { value: "4" } });
  fireEvent.keyDown(inputs[0], { key: "ArrowDown" });
  fireEvent.keyDown(inputs[0], { key: "Enter" });
  expect(inputs[0]).toHaveValue("gpt-4o-mini");
  expect(screen.queryByRole("listbox", { name: NAME_LABEL })).toBeNull();

  fireEvent.change(inputs[0], { target: { value: "o3-m" } });
  expect(screen.getByRole("listbox", { name: NAME_LABEL })).toBeDefined();
  fireEvent.keyDown(inputs[0], { key: "Escape" });
  expect(screen.queryByRole("listbox", { name: NAME_LABEL })).toBeNull();
});

it("lets Enter fall through when the typed name is the exact top match", async () => {
  const inputs = await fetchCatalogInDialog(await openEditDialog());
  fireEvent.focus(inputs[0]);
  fireEvent.change(inputs[0], { target: { value: "gpt-4o" } });
  fireEvent.keyDown(inputs[0], { key: "Enter" });
  expect(inputs[0]).toHaveValue("gpt-4o");
  expect(screen.getByRole("listbox", { name: NAME_LABEL })).toBeDefined();
});

it("keeps the model-name field a plain input before any catalog was fetched", async () => {
  const inputs = await openEditDialog();
  fireEvent.focus(inputs[0]);
  expect(screen.queryByRole("listbox", { name: NAME_LABEL })).toBeNull();
  fireEvent.change(inputs[0], { target: { value: "custom-name" } });
  expect(inputs[0]).toHaveValue("custom-name");
  expect(screen.queryByRole("listbox", { name: NAME_LABEL })).toBeNull();
});
