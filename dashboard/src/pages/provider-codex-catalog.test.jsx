import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexCatalogEditor } from "./provider-codex-catalog";
import { showToast } from "../ui/components/Toast";
vi.mock("../lib/copy", () => ({ copy: (key) => key }));
vi.mock("../ui/components/Toast", () => ({ showToast: vi.fn() }));

// Normalized ids mirror the backend pricing store keys.
const metadata = {
  "kimi-k3": { contextWindow: 262144, maxOutputTokens: 32768, reasoningEfforts: ["low", "medium", "bogus"] },
};

const baseProps = {
  fetchState: "done",
  onFetch: () => {},
  defaultModel: "",
  onAddToMapping: () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

it("picker appears only with fetched models and adds rows filled from models.dev metadata", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <CodexCatalogEditor {...baseProps} models={[]} onChange={onChange} fetchedModels={null} modelMetadata={metadata} />,
  );
  expect(screen.queryByText("pswitch.catalog.picker_title")).toBeNull();

  rerender(
    <CodexCatalogEditor
      {...baseProps}
      models={[]}
      onChange={onChange}
      fetchedModels={["vendor/kimi-k3[1m]", "other-model"]}
      modelMetadata={metadata}
    />,
  );
  // Vendor prefix / variant / [1m] markers resolve to the same store entry.
  fireEvent.click(screen.getByLabelText("vendor/kimi-k3[1m]"));
  fireEvent.click(screen.getByLabelText("other-model"));
  fireEvent.click(screen.getByText("pswitch.catalog.picker_add_selected"));

  expect(onChange).toHaveBeenCalledTimes(1);
  const rows = onChange.mock.calls[0][0];
  expect(rows.map((row) => row.model)).toEqual(["vendor/kimi-k3[1m]", "other-model"]);
  expect(rows[0].displayName).toBe("vendor/kimi-k3[1m]");
  expect(rows[0].contextWindow).toBe("262144");
  // Intersected with Codex's own level order; unknown values dropped.
  expect(rows[0].reasoningLevels).toEqual(["low", "medium"]);
  expect(rows[1].contextWindow).toBe("");
  expect(showToast).toHaveBeenCalledWith({ title: "pswitch.catalog.filled_many" });
});

it("picker search filters and configured ids are disabled", () => {
  const onChange = vi.fn();
  render(
    <CodexCatalogEditor
      {...baseProps}
      models={[{ model: "other-model", displayName: "Other", contextWindow: "", reasoningLevels: [], defaultReasoningLevel: "" }]}
      onChange={onChange}
      fetchedModels={["kimi-k3", "other-model"]}
      modelMetadata={metadata}
    />,
  );
  expect(screen.getByLabelText("other-model")).toBeDisabled();
  const search = screen.getByLabelText("pswitch.catalog.picker_search");
  fireEvent.change(search, { target: { value: "kimi" } });
  expect(screen.queryByLabelText("other-model")).toBeNull();
  fireEvent.click(screen.getByLabelText("kimi-k3"));
  fireEvent.click(screen.getByText("pswitch.catalog.picker_add_selected"));
  const rows = onChange.mock.calls[0][0];
  expect(rows).toHaveLength(2);
  expect(rows[1].model).toBe("kimi-k3");
});

it("per-row dropdown fills only blank fields and leaves user values alone", () => {
  const onChange = vi.fn();
  render(
    <CodexCatalogEditor
      {...baseProps}
      models={[{ model: "", displayName: "Kept name", contextWindow: "999", reasoningLevels: [], defaultReasoningLevel: "" }]}
      onChange={onChange}
      fetchedModels={["kimi-k3"]}
      modelMetadata={metadata}
    />,
  );
  fireEvent.click(screen.getByLabelText("pswitch.models.dropdown_aria"));
  // The picker lists the same id as a label; the dropdown option is a button.
  fireEvent.click(screen.getByRole("button", { name: "kimi-k3" }));
  const row = onChange.mock.calls[0][0][0];
  expect(row.model).toBe("kimi-k3");
  expect(row.displayName).toBe("Kept name");
  expect(row.contextWindow).toBe("999");
  expect(row.reasoningLevels).toEqual(["low", "medium"]);
  expect(showToast).toHaveBeenCalledWith({ title: "pswitch.catalog.filled" });
});

it("fill stays silent when the model has no metadata entry", () => {
  const onChange = vi.fn();
  render(
    <CodexCatalogEditor
      {...baseProps}
      models={[]}
      onChange={onChange}
      fetchedModels={["unknown-model"]}
      modelMetadata={metadata}
    />,
  );
  fireEvent.click(screen.getByLabelText("unknown-model"));
  fireEvent.click(screen.getByText("pswitch.catalog.picker_add_selected"));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(showToast).not.toHaveBeenCalled();
});
