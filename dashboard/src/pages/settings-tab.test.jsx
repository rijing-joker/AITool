import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsTab } from "./settings-tab";

vi.mock("../lib/copy", () => ({ copy: (key) => key }));
vi.mock("../lib/local-api-auth", () => ({ getLocalApiAuthHeaders: async () => ({}) }));
vi.mock("../lib/proxy-api", () => ({ proxyApi: { configYaml: async () => ({ yaml: "server: {}" }) } }));
let fields, failSave;
beforeEach(() => {
  fields = { "server.host": "127.0.0.1", "server.port": 8318, "routing.retry.request-retry": 0 };
  failSave = false;
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    if (options?.method === "PATCH") {
      if (failSave) return { json: async () => ({ ok: false, error: "Save failed" }) };
      Object.assign(fields, JSON.parse(options.body).fields);
    }
    return { json: async () => ({ ok: true, fields }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function setup() {
  const router = createMemoryRouter([
    { path: "/settings", element: <SettingsTab status={{ core: { autoStart: true, version: "1" } }} /> },
    { path: "/other", element: <div>{"Destination"}</div> },
  ], { initialEntries: ["/settings"] });
  render(<RouterProvider router={router} />);
  const port = screen.getByRole("textbox", { name: /^proxy.settings.network.port/ });
  await waitFor(() => expect(port).toHaveValue("8318"));
  return { router, port, retry: screen.getByRole("textbox", { name: /^proxy.settings.routing.requestRetry/ }) };
}
it("saving one section preserves another section's dirty values and can save them later", async () => {
  const { port, retry } = await setup();
  fireEvent.change(port, { target: { value: "8320" } });
  fireEvent.change(retry, { target: { value: "5" } });
  fireEvent.click(screen.getAllByRole("button", { name: "proxy.action.save_config" })[0]);
  await screen.findByText("proxy.settings.sectionSaved");
  expect(fields["server.port"]).toBe(8320);
  expect(retry).toHaveValue("5");
  expect(fields["routing.retry.request-retry"]).toBe(0);
  fireEvent.click(screen.getAllByRole("button", { name: "proxy.action.save_config" })[1]);
  await waitFor(() => expect(fields["routing.retry.request-retry"]).toBe(5));
});
it("failed saves retain the draft for retry", async () => {
  const { port } = await setup();
  fireEvent.change(port, { target: { value: "8320" } });
  failSave = true;
  fireEvent.click(screen.getAllByRole("button", { name: "proxy.action.save_config" })[0]);
  await screen.findByText("Save failed");
  expect(port).toHaveValue("8320");
  expect(fields["server.port"]).toBe(8318);
});
it("codex client section loads and saves both client.codex fields", async () => {
  fields["client.codex.optimize-multi-agent-v2"] = true;
  await setup();
  const optimize = screen.getByRole("switch", { name: "proxy.settings.codex.optimizeMultiAgent" });
  await waitFor(() => expect(optimize).toBeChecked());
  const applyPatch = screen.getByRole("switch", { name: "proxy.settings.codex.applyPatch" });
  expect(applyPatch).not.toBeChecked();
  fireEvent.click(applyPatch);
  // save buttons order: network, routing, diagnostics, codex, yaml
  fireEvent.click(screen.getAllByRole("button", { name: "proxy.action.save_config" })[3]);
  await screen.findByText("proxy.settings.sectionSaved");
  expect(fields["client.codex.enable-apply-patch"]).toBe(true);
  expect(fields["client.codex.optimize-multi-agent-v2"]).toBe(true);
});
it("blocks navigation until the user explicitly discards the draft", async () => {
  const { router, port } = await setup();
  fireEvent.change(port, { target: { value: "8320" } });
  await act(async () => { await router.navigate("/other"); });
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "shared.unsaved.keep_editing" }));
  expect(port).toHaveValue("8320");
  expect(router.state.location.pathname).toBe("/settings");
  await act(async () => { await router.navigate("/other"); });
  fireEvent.click(screen.getByRole("button", { name: "shared.unsaved.discard" }));
  await screen.findByText("Destination");
});
