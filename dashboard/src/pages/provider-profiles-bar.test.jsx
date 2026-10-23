import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, it, vi } from "vitest";
import { ProviderProfilesBar } from "./provider-profiles-bar";
import { profilesApi } from "../lib/provider-switch-api";

vi.mock("../lib/copy", () => ({ copy: (key, params) => (params ? `${key}:${Object.values(params).join(":")}` : key) }));

const mocks = vi.hoisted(() => ({
  profiles: [],
  currentIds: {},
}));

vi.mock("../lib/provider-switch-api", () => ({
  profilesApi: {
    list: vi.fn(async () => ({ ok: true, profiles: mocks.profiles, currentIds: mocks.currentIds })),
    create: vi.fn(async ({ name }) => ({ ok: true, profile: { id: "pr_new", name, payload: {} } })),
    update: vi.fn(async ({ id, name }) => ({ ok: true, profile: { id, name, payload: {} } })),
    remove: vi.fn(async () => ({ ok: true })),
    apply: vi.fn(async () => ({ ok: true, warnings: ["[claude] provider 'p_gone' no longer exists, skipped"] })),
    previewBundle: vi.fn(async () => ({ ok: true, revision: "bundle-r1", results: [{ app: "claude", ready: true, errors: [] }, { app: "codex", ready: true, errors: [] }] })),
    applyBundle: vi.fn(async () => ({ ok: true, recoveryPath: "/tmp/recovery", results: [{ app: "claude", status: "applied", warnings: [] }, { app: "codex", status: "applied", warnings: [] }] })),
  },
}));

const aProfile = {
  id: "pr_1",
  name: "Work",
  payload: { providers: { claude: "p_1" }, mcp: {}, skills: {}, prompts: {} },
  createdAt: "2026-10-11T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.profiles = [];
  mocks.currentIds = {};
});

it("captures only explicitly selected apps", async () => {
  render(<ProviderProfilesBar activeApp="claude" />);
  await screen.findByText("pswitch.profile.empty");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.profile.new" }));
  fireEvent.change(screen.getByRole("dialog").querySelector("input"), { target: { value: "Daily" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "pswitch.tab.codex" }));
  fireEvent.click(screen.getByRole("button", { name: "pswitch.profile.create" }));
  await waitFor(() => expect(profilesApi.create).toHaveBeenCalledWith({ name: "Daily", apps: ["claude", "codex"] }));
});

it("previews the selected bundle before applying its revision", async () => {
  mocks.profiles = [{ ...aProfile, capturedApps: ["claude", "codex"] }];
  render(<ProviderProfilesBar activeApp="claude" />);
  fireEvent.click(await screen.findByText("Work"));
  expect(profilesApi.applyBundle).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "pswitch.profile.bundle_preview" }));
  fireEvent.click(await screen.findByRole("button", { name: "pswitch.profile.bundle_apply" }));
  await waitFor(() => expect(profilesApi.applyBundle).toHaveBeenCalledWith("pr_1", ["claude", "codex"], "bundle-r1"));
  await screen.findByText("/tmp/recovery");
});

it("renders profile chips, creates with a name and applies through the confirm", async () => {
  const onNotice = vi.fn();
  const onChanged = vi.fn();
  mocks.profiles = [aProfile];
  mocks.currentIds = { claude: "pr_1" };
  render(<ProviderProfilesBar activeApp="claude" onNotice={onNotice} onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByText("Work")).toBeTruthy());

  // The current profile's chip is highlighted but clicking still applies.
  fireEvent.click(screen.getByText("Work"));
  await screen.findByText("pswitch.profile.apply_confirm_title");
  const dialog = await screen.findByRole("dialog");
  const confirm = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "pswitch.profile.apply");
  fireEvent.click(confirm);
  await waitFor(() => expect(profilesApi.apply).toHaveBeenCalledWith({ id: "pr_1", app: "claude" }));
  // Server warnings surface through the notice (best-effort apply).
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("pswitch.profile.applied_with_warnings:[claude] provider 'p_gone' no longer exists, skipped"));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it.each(["openclaw", "agy", "mcp", "prompts", "skills"])("skips profile requests for unsupported app %s", (activeApp) => {
  render(<ProviderProfilesBar activeApp={activeApp} onNotice={vi.fn()} onChanged={vi.fn()} />);
  expect(screen.queryByText("pswitch.profile.bar_label")).toBeNull();
  expect(profilesApi.list).not.toHaveBeenCalled();
});

it("creates a profile from the initiating app only", async () => {
  const onNotice = vi.fn();
  const onChanged = vi.fn();
  render(<ProviderProfilesBar activeApp="claude" onNotice={onNotice} onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByText("pswitch.profile.empty")).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: "pswitch.profile.new" }));
  const dialog = await screen.findByRole("dialog");
  const nameInput = dialog.querySelector("input");
  fireEvent.change(nameInput, { target: { value: "Work" } });
  fireEvent.click(Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "pswitch.profile.create"));
  await waitFor(() => expect(profilesApi.create).toHaveBeenCalledWith({ name: "Work", app: "claude" }));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("pswitch.profile.created"));
});

it("renames and deletes profiles from the manage dialog", async () => {
  const onNotice = vi.fn();
  const onChanged = vi.fn();
  mocks.profiles = [aProfile];
  render(<ProviderProfilesBar activeApp="claude" onNotice={onNotice} onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByText("Work")).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: "pswitch.profile.manage" }));
  const manageDialog = await screen.findByRole("dialog");
  const del = await waitFor(() => {
    const btn = Array.from(manageDialog.querySelectorAll("button")).find((b) => b.textContent === "pswitch.action.delete");
    expect(btn).toBeTruthy();
    return btn;
  });
  fireEvent.click(del);
  await screen.findByText("pswitch.profile.delete_confirm_title");
  const confirmDialog = await screen.findByRole("dialog");
  const confirmDelete = await waitFor(() => {
    const btn = Array.from(confirmDialog.querySelectorAll("button")).find((b) => b.textContent === "pswitch.action.delete");
    expect(btn).toBeTruthy();
    return btn;
  });
  fireEvent.click(confirmDelete);
  await waitFor(() => expect(profilesApi.remove).toHaveBeenCalledWith("pr_1"));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it("retains a failed rename and shows its error in the management dialog", async () => {
  mocks.profiles = [aProfile];
  profilesApi.update.mockRejectedValueOnce(new Error("Rename failed"));
  render(<ProviderProfilesBar activeApp="claude" onNotice={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText("Work");
  fireEvent.click(screen.getByRole("button", { name: "pswitch.profile.manage" }));
  const name = screen.getByLabelText("pswitch.profile.name_label");
  fireEvent.change(name, { target: { value: "Renamed" } });
  fireEvent.change(name, { target: { value: "Renamed again" } });
  fireEvent.click(screen.getByRole("button", { name: "pswitch.profile.rename" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Rename failed");
  expect(name).toHaveValue("Renamed again");
  expect(screen.getByRole("dialog")).toContainElement(screen.getByRole("alert"));
});
