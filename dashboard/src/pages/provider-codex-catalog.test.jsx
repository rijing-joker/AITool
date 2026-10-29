import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexCatalogEditor } from "./provider-codex-catalog";
import { showToast } from "../ui/components/Toast";
import { ModalFrame } from "../ui/components/ModalFrame";
vi.mock("../lib/copy", () => ({ copy: (key, values) => values?.count ? `${key} ${values.count}` : key }));
vi.mock("../ui/components/Toast", () => ({ showToast: vi.fn() }));
const metadata = { "kimi-k3": { contextWindow: 262144, reasoningEfforts: ["low", "medium", "bogus"], inputModalities: ["text", "image"] } };
const baseProps = { fetchState: "done", onFetch: () => {}, defaultModel: "", onAddToMapping: () => {} };
beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const openPicker = () => {
  fireEvent.click(screen.getByRole("button", { name: "pswitch.catalog.choose" }));
  return within(screen.getByRole("dialog"));
};
it("opens after fetching and previews the parameters applied to new models", () => {
  const onChange = vi.fn();
  const { rerender } = render(React.createElement(CodexCatalogEditor, { ...baseProps, models: [], onChange, fetchedModels: null, modelMetadata: metadata }));
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<CodexCatalogEditor {...baseProps} models={[]} onChange={onChange} fetchedModels={["vendor/kimi-k3[1m]", "other"]} modelMetadata={metadata} />);
  const picker = within(screen.getByRole("dialog"));
  expect(picker.getByText("pswitch.catalog.context_preview 262144")).toBeInTheDocument();
  expect(picker.getByText("pswitch.catalog.image_preview")).toBeInTheDocument();
  fireEvent.click(picker.getByLabelText("vendor/kimi-k3[1m]"));
  fireEvent.click(picker.getByRole("button", { name: "shared.action.apply" }));
  const rows = onChange.mock.calls[0][0];
  expect(rows[0]).toMatchObject({ model: "vendor/kimi-k3[1m]", contextWindow: "262144", reasoningLevels: ["low", "medium"], inputModalities: ["text", "image"] });
  expect(showToast).not.toHaveBeenCalled();
});
it("one selection can add and remove models while preserving duplicate routes and manual settings", () => {
  const rows = [{ model: "keep", displayName: "Alias A", contextWindow: "999" }, { model: "keep", displayName: "Alias B", baseInstructions: "custom" }, { model: "retired", displayName: "Old" }];
  const onChange = vi.fn();
  render(<CodexCatalogEditor {...baseProps} models={rows} onChange={onChange} fetchedModels={["keep", "kimi-k3"]} modelMetadata={metadata} />);
  const picker = openPicker();
  expect(picker.getByText("pswitch.catalog.unavailable")).toBeInTheDocument();
  fireEvent.click(picker.getByLabelText("retired"));
  fireEvent.click(picker.getByLabelText("kimi-k3"));
  fireEvent.click(picker.getByRole("button", { name: "shared.action.apply" }));
  const next = onChange.mock.calls[0][0];
  expect(next.slice(0, 2)).toEqual(rows.slice(0, 2));
  expect(next.map(row => row.model)).toEqual(["keep", "keep", "kimi-k3"]);
});
it("cancel discards selection edits and search does not change hidden selections", () => {
  const onChange = vi.fn();
  render(<CodexCatalogEditor {...baseProps} models={[{ model: "keep" }]} onChange={onChange} fetchedModels={["keep", "kimi-k3"]} modelMetadata={metadata} />);
  const picker = openPicker();
  fireEvent.change(picker.getByLabelText("pswitch.catalog.picker_search"), { target: { value: "kimi" } });
  fireEvent.click(picker.getByRole("button", { name: "pswitch.catalog.select_all" }));
  fireEvent.click(picker.getByRole("button", { name: "shared.action.cancel" }));
  expect(onChange).not.toHaveBeenCalled();
  const reopened = openPicker();
  expect(reopened.getByLabelText("keep")).toBeChecked();
  expect(reopened.getByLabelText("kimi-k3")).not.toBeChecked();
});
it("refetch keeps draft choices and deselecting all removes the configured catalog", () => {
  const onChange = vi.fn(), onFetch = vi.fn();
  const props = { ...baseProps, onFetch, models: [{ model: "old" }], onChange };
  const { rerender } = render(<CodexCatalogEditor {...props} fetchedModels={["old", "new"]} />);
  const picker = openPicker();
  fireEvent.click(picker.getByLabelText("new"));
  fireEvent.click(picker.getByRole("button", { name: "pswitch.catalog.refetch" }));
  expect(onFetch).toHaveBeenCalledOnce();
  rerender(<CodexCatalogEditor {...props} fetchedModels={["new"]} />);
  expect(picker.getByLabelText("new")).toBeChecked();
  fireEvent.click(picker.getByRole("button", { name: "pswitch.catalog.select_none" }));
  fireEvent.click(picker.getByRole("button", { name: "shared.action.apply" }));
  expect(onChange).toHaveBeenCalledWith(undefined);
});
it("per-row dropdown fills blank parameters and preserves manual values", () => {
  const onChange = vi.fn();
  render(<CodexCatalogEditor {...baseProps} models={[{ model: "", displayName: "Kept", contextWindow: "999", reasoningLevels: [] }]} onChange={onChange} fetchedModels={["kimi-k3"]} modelMetadata={metadata} />);
  fireEvent.click(screen.getByLabelText("pswitch.models.dropdown_aria"));
  fireEvent.click(screen.getByRole("button", { name: "kimi-k3" }));
  expect(onChange.mock.calls[0][0][0]).toMatchObject({ displayName: "Kept", contextWindow: "999", reasoningLevels: ["low", "medium"] });
});

it("keyboard sorting reaches the sensor inside a modal and Escape cancels before closing", async () => {
  const rows = [{ model: "a", displayName: "Alpha", contextWindow: "999", baseInstructions: "keep" }, { model: "b", displayName: "Beta", reasoningLevels: ["high"] }];
  const onChange = vi.fn(), onClose = vi.fn();
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (this.firstElementChild?.getAttribute("aria-roledescription") !== "sortable") return measure.call(this);
    const top = this.querySelector("input").value === "Alpha" ? 100 : 200;
    return { x: 0, y: top, top, left: 0, right: 600, bottom: top + 80, width: 600, height: 80, toJSON() {} };
  });
  render(<ModalFrame open label="Catalog" onClose={onClose}><CodexCatalogEditor {...baseProps} models={rows} onChange={onChange} /></ModalFrame>);
  const handle = screen.getAllByRole("button", { name: "pswitch.provider.drag_handle" })[0];
  handle.focus();
  fireEvent.keyDown(handle, { key: " ", code: "Space" });
  await waitFor(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  fireEvent.keyDown(handle, { key: "ArrowDown", code: "ArrowDown" });
  fireEvent.keyDown(handle, { key: " ", code: "Space" });
  await waitFor(() => expect(onChange).toHaveBeenCalledWith([rows[1], rows[0]]));
  await waitFor(() => expect(handle).not.toHaveAttribute("aria-pressed", "true"));
  expect(onClose).not.toHaveBeenCalled();

  onChange.mockClear();
  fireEvent.keyDown(handle, { key: " ", code: "Space" });
  await waitFor(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  fireEvent.keyDown(handle, { key: "Escape", code: "Escape" });
  await waitFor(() => expect(handle).not.toHaveAttribute("aria-pressed", "true"));
  expect(onChange).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(handle, { key: "Escape", code: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});
