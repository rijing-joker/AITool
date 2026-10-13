import React from "react";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { providerSwitchApi } from "../lib/provider-switch-api";
import { ProviderEditDialog } from "./provider-edit-dialog";

// Exercise the form against the real API presets and save split, so native
// config paths cannot drift between the dashboard and the backend.
const require = createRequire(import.meta.url);
const { listPresets } = require("../../../src/lib/provider-switch/presets");
const { projectAdditive, serializeLive, planSaveAdditive, sanitizeWrapper } = require("../../../src/lib/provider-switch/additive");
const { projectCodex } = require("../../../src/lib/provider-switch/targets");
import { prefillProviderMeta } from "./provider-preset-meta";

vi.mock("../lib/copy", () => ({ copy: (key) => key }));
vi.mock("../lib/provider-switch-api", () => ({
  providerSwitchApi: { getEditorView: vi.fn(), updateProvider: vi.fn(), fetchModels: vi.fn() },
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

it.each([false, true])("saves MoArk catalog defaults while preserving an existing custom catalog (%s)", async (custom) => {
  const preset = listPresets("codex").find((row) => row.id === "codex_moark");
  const meta = custom ? { codexCatalogModels: [{ model: "my-model", inputModalities: ["text"] }] } : { customUserAgent: "kept" };
  const settingsConfig = structuredClone(preset.settingsConfig);
  settingsConfig.auth.OPENAI_API_KEY = "fixture-key";
  const editing = { id: "moark", name: "MoArk", category: "custom", settingsConfig, meta };
  const projection = projectCodex({ prev: null, target: editing, liveToml: "", liveAuth: {}, stash: null });
  providerSwitchApi.getEditorView.mockResolvedValue({ configToml: projection.configToml, authJson: {}, inactive: [] });
  providerSwitchApi.updateProvider.mockResolvedValue({ provider: editing });
  const callbacks = { ...props(), app: "codex", presets: listPresets("codex"), editing };
  render(<ProviderEditDialog {...callbacks} />);
  const save = screen.getByRole("button", { name: "pswitch.action.save" });
  await waitFor(() => expect(save).toBeEnabled());
  expect(screen.getAllByLabelText("pswitch.catalog.col_model")).toHaveLength(custom ? 1 : 5);
  fireEvent.click(save);
  await waitFor(() => expect(providerSwitchApi.updateProvider).toHaveBeenCalledTimes(1));
  const saved = providerSwitchApi.updateProvider.mock.calls[0][2].meta;
  expect(saved.codexCatalogModels).toEqual(custom ? meta.codexCatalogModels : preset.meta.codexCatalogModels);
  if (!custom) expect(saved.customUserAgent).toBe("kept");
});

it("does not prefill an external catalog or unrelated endpoint", () => {
  const presets = listPresets("codex");
  for (const config of [
    { base_url: "https://moark.com/v1", model_catalog_json: "user-catalog.json" },
    { base_url: "https://other.test/v1" },
  ]) expect(prefillProviderMeta("codex", { settingsConfig: { config } }, presets)).toEqual({});
});

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

const ADDITIVE_APPS = ["opencode", "openclaw", "mcode", "hermes", "pi", "grokbuild"];

function credentialFields(app, wrapper) {
  const snake = app === "hermes" || app === "grokbuild";
  const options = app === "opencode" || app === "mcode";
  return {
    entry: options ? wrapper.provider.options : wrapper.provider,
    endpoint: snake ? "base_url" : options ? "baseURL" : "baseUrl",
    key: snake ? "api_key" : "apiKey",
  };
}

function additiveProps(app) {
  const presets = listPresets(app);
  const template = presets.find((preset) => preset.group === "custom");
  const settingsConfig = structuredClone(template.settingsConfig);
  settingsConfig.slotKey = "saved-relay";
  const { entry, endpoint, key } = credentialFields(app, settingsConfig);
  entry[endpoint] = "https://before.example.test/v1";
  entry[key] = "before-fixture-key";
  if (app === "pi") entry.models = [{ id: "fixture-model" }];
  if (app === "hermes" || app === "grokbuild") entry.model = "fixture-model";
  if (app === "hermes") entry.name = settingsConfig.slotKey;
  return {
    ...props(), app, presets,
    editing: { id: "saved-provider", name: "Saved relay", category: "custom", settingsConfig: sanitizeWrapper(app, settingsConfig, "Saved relay") },
  };
}

function configFromEditor(app) {
  const text = screen.getByRole("textbox", { name: "pswitch.provider.config" }).value;
  if (app === "mcode" || app === "hermes") return parseYaml(text);
  return app === "grokbuild" ? parseToml(text) : JSON.parse(text);
}

it.each(ADDITIVE_APPS)("saves %s credentials in its native provider entry", async (app) => {
  const callbacks = additiveProps(app);
  const live = app === "hermes" ? { custom_providers: [{ name: "other", api_key: "other-key" }] } : {};
  const baseConfig = projectAdditive(app, { target: callbacks.editing, live });
  providerSwitchApi.getEditorView.mockResolvedValue({
    configText: serializeLive(app, baseConfig), slotKey: "saved-relay", inactive: [],
  });
  providerSwitchApi.updateProvider.mockResolvedValue({ provider: { name: "Saved relay" } });
  render(<ProviderEditDialog {...callbacks} />);
  const save = screen.getByRole("button", { name: "pswitch.action.save" });
  await waitFor(() => expect(save).toBeEnabled());
  const key = screen.getByLabelText("pswitch.field.api_key");
  const endpoint = screen.getByLabelText("pswitch.field.endpoint");
  expect(key).toHaveValue("before-fixture-key");
  expect(endpoint).toHaveValue("https://before.example.test/v1");
  fireEvent.change(key, { target: { value: "after-fixture-key" } });
  fireEvent.change(endpoint, { target: { value: "https://after.example.test/v1" } });

  const expectedWrapper = structuredClone(callbacks.editing.settingsConfig);
  const fields = credentialFields(app, expectedWrapper);
  fields.entry[fields.key] = "after-fixture-key";
  fields.entry[fields.endpoint] = "https://after.example.test/v1";
  const expectedConfig = projectAdditive(app, { target: { settingsConfig: expectedWrapper }, live });
  expect(configFromEditor(app)).toEqual(expectedConfig);
  fireEvent.click(save);
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledTimes(1));
  const payload = providerSwitchApi.updateProvider.mock.calls[0][2];
  expect(payload.settingsConfig).toEqual(expectedConfig);
  expect(payload.editor).toEqual({ base: baseConfig, slotKey: "saved-relay" });
  const plan = planSaveAdditive(app, callbacks.editing, payload.settingsConfig, payload.editor.base, payload.editor.slotKey);
  expect(plan.rowSettings.provider).toEqual(expectedWrapper.provider);
  expect(plan.changes).toEqual([]);
});

it.each(ADDITIVE_APPS)("preserves the %s provider when the editor view fails", async (app) => {
  const callbacks = additiveProps(app);
  providerSwitchApi.getEditorView.mockRejectedValue(new Error("Temporary connection failure"));
  providerSwitchApi.updateProvider.mockResolvedValue({ provider: { name: "Saved relay" } });
  render(<ProviderEditDialog {...callbacks} />);
  const save = screen.getByRole("button", { name: "pswitch.action.save" });
  await waitFor(() => expect(save).toBeEnabled());
  const expectedConfig = projectAdditive(app, { target: callbacks.editing, live: {} });
  expect(configFromEditor(app)).toEqual(expectedConfig);
  fireEvent.click(save);
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledTimes(1));
  const payload = providerSwitchApi.updateProvider.mock.calls[0][2];
  expect(payload.editor).toEqual({ base: expectedConfig, slotKey: "saved-relay" });
  const plan = planSaveAdditive(app, callbacks.editing, payload.settingsConfig, payload.editor.base, payload.editor.slotKey);
  expect(plan.rowSettings.provider).toEqual(callbacks.editing.settingsConfig.provider);
  expect(plan.changes).toEqual([]);
});

it("edits the named Hermes entry after its YAML list is reordered", async () => {
  const callbacks = additiveProps("hermes");
  // Numeric provider names must still resolve by name rather than array index.
  callbacks.editing.settingsConfig.slotKey = "0";
  callbacks.editing.settingsConfig.provider.name = "0";
  const baseConfig = projectAdditive("hermes", { target: callbacks.editing, live: {
    custom_providers: [{ name: "other", api_key: "other-key" }],
  } });
  providerSwitchApi.getEditorView.mockResolvedValue({ configText: serializeLive("hermes", baseConfig), slotKey: "0" });
  providerSwitchApi.updateProvider.mockResolvedValue({ provider: { name: "Saved relay" } });
  render(<ProviderEditDialog {...callbacks} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "pswitch.action.save" })).toBeEnabled());
  expect(screen.getByLabelText("pswitch.field.api_key")).toHaveValue("before-fixture-key");
  const reordered = structuredClone(baseConfig);
  reordered.custom_providers.reverse();
  fireEvent.change(screen.getByRole("textbox", { name: "pswitch.provider.config" }), {
    target: { value: serializeLive("hermes", reordered) },
  });
  fireEvent.change(screen.getByLabelText("pswitch.field.model"), { target: { value: "new-model" } });
  fireEvent.change(screen.getByLabelText("pswitch.field.api_key"), { target: { value: "new-key" } });
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.save" }));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledTimes(1));
  const payload = providerSwitchApi.updateProvider.mock.calls[0][2];
  const plan = planSaveAdditive("hermes", callbacks.editing, payload.settingsConfig, payload.editor.base, payload.editor.slotKey);
  expect(plan.rowSettings.provider.api_key).toBe("new-key");
  expect(plan.rowSettings.modelId).toBe("new-model");
  expect(plan.changes).toEqual([]);
  expect(payload.settingsConfig.custom_providers[1]).toEqual({ name: "other", api_key: "other-key" });
});

it("writes pi's model field back as a models list when the entry had none", async () => {
  const callbacks = additiveProps("pi");
  delete callbacks.editing.settingsConfig.provider.models;
  const baseConfig = projectAdditive("pi", { target: callbacks.editing, live: {} });
  providerSwitchApi.getEditorView.mockResolvedValue({
    configText: serializeLive("pi", baseConfig), slotKey: "saved-relay", inactive: [],
  });
  providerSwitchApi.updateProvider.mockResolvedValue({ provider: { name: "Saved relay" } });
  render(<ProviderEditDialog {...callbacks} />);
  const save = screen.getByRole("button", { name: "pswitch.action.save" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.change(screen.getByLabelText("pswitch.field.model"), { target: { value: "new-model" } });
  fireEvent.click(save);
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledTimes(1));
  const payload = providerSwitchApi.updateProvider.mock.calls[0][2];
  const plan = planSaveAdditive("pi", callbacks.editing, payload.settingsConfig, payload.editor.base, payload.editor.slotKey);
  expect(plan.rowSettings.provider.models).toEqual([{ id: "new-model" }]);
  expect(plan.rowSettings.modelId).toBe("new-model");
  expect(plan.changes).toEqual([]);
});

it("clears fetched models and voids an in-flight fetch when the header override changes", async () => {
  // cc-switch 3703306d: /models results may be keyed per request identity, so
  // editing the Header override after (or during) a fetch must drop the stale
  // list instead of offering models the new identity cannot access.
  const callbacks = props();
  callbacks.editing.meta = { localProxyRequestOverrides: { headers: '{"X-Tenant": "tenant-1"}' } };
  const first = deferred();
  providerSwitchApi.fetchModels.mockReturnValueOnce(first.promise);
  render(<ProviderEditDialog {...callbacks} />);
  // The model input rows carry an icon-only fetch action with the same name;
  // the advanced section's text button is the one to drive.
  const fetchButtons = await screen.findAllByRole("button", { name: "pswitch.models.fetch" });
  const fetchButton = fetchButtons.find((button) => button.textContent.includes("pswitch.models.fetch"));
  fireEvent.click(fetchButton);

  // The override changes mid-flight: the response for the old identity is
  // voided, the list stays empty, and the button is usable again.
  fireEvent.change(screen.getByRole("textbox", { name: "pswitch.advanced.override_headers" }), {
    target: { value: '{"X-Tenant": "tenant-2"}' },
  });
  await act(async () => first.resolve({ models: ["m-old"] }));
  expect(screen.queryAllByRole("button", { name: "pswitch.models.dropdown_aria" })).toHaveLength(0);
  expect(fetchButton).toBeEnabled();
  expect(providerSwitchApi.fetchModels.mock.calls[0][0].requestHeaders).toBe('{"X-Tenant": "tenant-1"}');

  // A completed fetch is cleared as soon as the override changes again.
  providerSwitchApi.fetchModels.mockResolvedValueOnce({ models: ["m-a", "m-b"] });
  fireEvent.click(fetchButton);
  await screen.findAllByRole("button", { name: "pswitch.models.dropdown_aria" });
  fireEvent.change(screen.getByRole("textbox", { name: "pswitch.advanced.override_headers" }), {
    target: { value: '{"X-Tenant": "tenant-3"}' },
  });
  expect(screen.queryAllByRole("button", { name: "pswitch.models.dropdown_aria" })).toHaveLength(0);
  expect(fetchButton).toBeEnabled();
});

it("saves Codex subagent fields through the TOML editor while retaining unrelated agent settings", async () => {
  const editing = { id: "codex-subagents", name: "Relay", category: "custom", settingsConfig: { config: { model: "gpt-5.5", base_url: "https://relay.test/v1", agents: { max_threads: 3 } }, auth: { OPENAI_API_KEY: "test-key" } } };
  const projection = projectCodex({ prev: null, target: editing, liveToml: "[agents]\nmax_threads = 3\n", liveAuth: {}, stash: null });
  providerSwitchApi.getEditorView.mockResolvedValue({ configToml: projection.configToml, authJson: {}, inactive: [] });
  providerSwitchApi.updateProvider.mockResolvedValue({ provider: editing });
  render(<ProviderEditDialog {...props()} app="codex" editing={editing} presets={listPresets("codex")} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "pswitch.action.save" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("pswitch.subagent.model"), { target: { value: "gpt-5-mini" } });
  fireEvent.change(screen.getByLabelText("pswitch.subagent.effort"), { target: { value: "high" } });
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.save" }));
  await waitFor(() => expect(providerSwitchApi.updateProvider).toHaveBeenCalledOnce());
  const saved = providerSwitchApi.updateProvider.mock.calls[0][2];
  expect(saved.settingsConfig.config.agents).toEqual({ max_threads: 3, default_subagent_model: "gpt-5-mini", default_subagent_reasoning_effort: "high" });
});
