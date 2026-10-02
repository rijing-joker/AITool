import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { ProviderEditDialog } from "./provider-edit-dialog";

vi.mock("../lib/copy", () => ({ copy: (key) => key }));
vi.mock("../lib/provider-switch-api", () => ({
  providerSwitchApi: { getEditorView: vi.fn(), updateProvider: vi.fn() },
}));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const base = {
  env: { ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_BASE_URL: "https://example.test" },
  permissions: { allow: ["Read"] },
};

function props() {
  return {
    open: true,
    busy: false,
    app: "claude",
    appState: { current: "current-provider" },
    presets: [{ id: "custom", group: "custom", formFields: [
      { id: "api_key", labelKey: "pswitch.field.api_key", path: "env.ANTHROPIC_AUTH_TOKEN" },
    ] }],
    editing: { id: "other-provider", name: "Fixture", category: "custom", settingsConfig: {} },
    onClose: vi.fn(),
    onSaved: vi.fn(),
    onError: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  providerSwitchApi.getEditorView.mockResolvedValue({ settings: base, inactive: [] });
});
afterEach(cleanup);

it("saves the projected config and editor base once during repeated clicks", async () => {
  const pendingSave = deferred();
  providerSwitchApi.updateProvider.mockReturnValue(pendingSave.promise);
  const callbacks = props();
  render(<ProviderEditDialog {...callbacks} />);
  const save = screen.getByRole("button", { name: "pswitch.action.save" });
  await waitFor(() => expect(save).toBeEnabled());
  expect(screen.getByLabelText("pswitch.field.api_key_name")).toHaveValue("ANTHROPIC_API_KEY");

  const edited = { ...base, permissions: { allow: ["Read", "Edit"] } };
  fireEvent.change(screen.getByRole("textbox", { name: "pswitch.provider.config" }), {
    target: { value: JSON.stringify(edited) },
  });
  act(() => { save.click(); save.click(); });

  expect(providerSwitchApi.updateProvider).toHaveBeenCalledTimes(1);
  expect(providerSwitchApi.updateProvider).toHaveBeenCalledWith("claude", "other-provider", expect.objectContaining({
    settingsConfig: edited,
    editor: { base },
  }));
  expect(save).toBeDisabled();
  await act(async () => pendingSave.resolve({ provider: { name: "Fixture" } }));
  expect(callbacks.onSaved).toHaveBeenCalledTimes(1);
  expect(callbacks.onClose).toHaveBeenCalledTimes(1);
});

it("releases the saving lock so a three-way conflict can be resolved", async () => {
  providerSwitchApi.updateProvider
    .mockRejectedValueOnce({ payload: { error: "conflict", conflicts: ["permissions"] } })
    .mockResolvedValueOnce({ provider: { name: "Fixture" } });
  const callbacks = props();
  render(<ProviderEditDialog {...callbacks} />);
  const save = screen.getByRole("button", { name: "pswitch.action.save" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  fireEvent.click(await screen.findByRole("button", { name: "pswitch.conflict.keep_mine" }));
  await waitFor(() => expect(callbacks.onClose).toHaveBeenCalledTimes(1));
  expect(providerSwitchApi.updateProvider).toHaveBeenCalledTimes(2);
  expect(providerSwitchApi.updateProvider.mock.calls[1][2].editor).toEqual({ base, onConflict: "keepMine" });
  expect(callbacks.onError).not.toHaveBeenCalled();
});

it("ignores the previous editor response after closing and reopening", async () => {
  const stale = deferred();
  const fresh = deferred();
  providerSwitchApi.getEditorView.mockReset()
    .mockReturnValueOnce(stale.promise)
    .mockReturnValueOnce(fresh.promise);
  const callbacks = props();
  const { rerender } = render(<ProviderEditDialog {...callbacks} />);
  rerender(React.createElement(ProviderEditDialog, { ...callbacks, open: false }));
  rerender(React.createElement(ProviderEditDialog, callbacks));
  const freshConfig = { ...base, permissions: { allow: ["Edit"] } };
  await act(async () => fresh.resolve({ settings: freshConfig }));
  await act(async () => stale.resolve({ settings: base }));
  expect(JSON.parse(screen.getByRole("textbox", { name: "pswitch.provider.config" }).value)).toEqual(freshConfig);
});

it("keeps a dirty draft when closing is canceled and discards only after confirmation", async () => {
  const callbacks = props();
  render(<ProviderEditDialog {...callbacks} />);
  const name = screen.getByRole("textbox", { name: "pswitch.provider.name" });
  await waitFor(() => expect(name).toBeEnabled());
  fireEvent.change(name, { target: { value: "Unsaved name" } });
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.close" }));
  expect(callbacks.onClose).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "shared.unsaved.keep_editing" }));
  expect(name).toHaveValue("Unsaved name");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.close" }));
  fireEvent.click(await screen.findByRole("button", { name: "shared.unsaved.discard" }));
  expect(callbacks.onClose).toHaveBeenCalledTimes(1);
});
