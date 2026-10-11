import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, it, vi } from "vitest";
import { ProviderUniversalPanel } from "./provider-universal-panel";
import { universalProvidersApi } from "../lib/provider-switch-api";

vi.mock("../lib/copy", () => ({ copy: (key, params) => (params?.name ? `${key}:${params.name}` : key) }));

const mocks = vi.hoisted(() => ({
  providers: [],
}));

vi.mock("../lib/provider-switch-api", () => ({
  universalProvidersApi: {
    list: vi.fn(async () => ({ ok: true, providers: mocks.providers })),
    upsert: vi.fn(async (provider) => ({ ok: true, provider: { id: provider.id || "u_new", ...provider } })),
    sync: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true, removed: true })),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.providers = [];
});

it("renders the empty state and creates a provider with an auto-sync", async () => {
  const onNotice = vi.fn();
  const onChanged = vi.fn();
  render(<ProviderUniversalPanel onNotice={onNotice} onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByText("pswitch.universal.empty")).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: "pswitch.universal.add" }));
  const dialog = screen.getByRole("dialog");
  const textInputs = dialog.querySelectorAll('input[type="text"], input:not([type])');
  fireEvent.change(textInputs[0], { target: { value: "Shared Gateway" } });
  fireEvent.change(textInputs[1], { target: { value: "https://gw.example.com" } });
  fireEvent.change(textInputs[2], { target: { value: "sk-shared" } });
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.save" }));

  await waitFor(() => expect(universalProvidersApi.upsert).toHaveBeenCalled());
  expect(universalProvidersApi.upsert.mock.calls[0][0].name).toBe("Shared Gateway");
  // Creation auto-syncs (upstream ffc22ea71).
  await waitFor(() => expect(universalProvidersApi.sync).toHaveBeenCalledWith("u_new"));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it("edits without syncing unless save-and-sync is used", async () => {
  mocks.providers = [{
    id: "u_1", name: "Shared Gateway", providerType: "newapi",
    apps: { claude: true, codex: false, gemini: false },
    baseUrl: "https://gw.example.com", apiKey: "sk-shared",
    createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z",
  }];
  render(<ProviderUniversalPanel onNotice={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByText("Shared Gateway")).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.edit" }));
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.save" }));
  await waitFor(() => expect(universalProvidersApi.upsert).toHaveBeenCalled());
  await waitFor(() => expect(universalProvidersApi.upsert.mock.calls[0][0].id).toBe("u_1"));
  // Plain edits save without touching live configs (upstream interaction).
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(universalProvidersApi.sync).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "pswitch.universal.sync" }));
  await screen.findByText("pswitch.universal.sync_confirm_title");
  const dialog = await screen.findByRole("dialog");
  const syncConfirm = await waitFor(() => {
    const btn = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "pswitch.universal.sync");
    expect(btn).toBeTruthy();
    return btn;
  });
  fireEvent.click(syncConfirm);
  await waitFor(() => expect(universalProvidersApi.sync).toHaveBeenCalledWith("u_1"));
});

it("keeps a successful add separate from a failed post-save sync", async () => {
  const onNotice = vi.fn();
  const onChanged = vi.fn();
  universalProvidersApi.sync.mockRejectedValueOnce(new Error("claude: live files could not be written"));
  render(<ProviderUniversalPanel onNotice={onNotice} onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByText("pswitch.universal.empty")).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: "pswitch.universal.add" }));
  const dialog = screen.getByRole("dialog");
  const textInputs = dialog.querySelectorAll('input[type="text"], input:not([type])');
  fireEvent.change(textInputs[0], { target: { value: "Shared Gateway" } });
  fireEvent.change(textInputs[1], { target: { value: "https://gw.example.com" } });
  fireEvent.change(textInputs[2], { target: { value: "sk-shared" } });
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.save" }));

  await waitFor(() => expect(universalProvidersApi.sync).toHaveBeenCalledWith("u_new"));
  // The add succeeded, so the dialog still closes and the list reloads
  // (upstream PR #2811) instead of reporting the add as failed.
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(
    "pswitch.universal.added_but_sync_failed: claude: live files could not be written",
  ));
});

it("deletes through the confirm dialog", async () => {
  mocks.providers = [{
    id: "u_1", name: "Shared Gateway", providerType: "custom",
    apps: { claude: true, codex: true, gemini: true },
    baseUrl: "https://gw.example.com", apiKey: "sk-shared",
    createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z",
  }];
  render(<ProviderUniversalPanel onNotice={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByText("Shared Gateway")).toBeTruthy());

  // The card's delete button opens the confirm dialog; the dialog's confirm
  // button (same label, but scoped to the dialog) performs the removal.
  fireEvent.click(screen.getByRole("button", { name: "pswitch.action.delete" }));
  await screen.findByText("pswitch.universal.delete_confirm_title");
  const dialog = await screen.findByRole("dialog");
  const confirm = await waitFor(() => {
    const btn = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "pswitch.action.delete");
    expect(btn).toBeTruthy();
    return btn;
  });
  fireEvent.click(confirm);
  await waitFor(() => expect(universalProvidersApi.remove).toHaveBeenCalledWith("u_1"));
});
