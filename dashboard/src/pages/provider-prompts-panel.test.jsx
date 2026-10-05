import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promptsApi } from "../lib/provider-switch-api";
import { ProviderPromptsPanel } from "./provider-prompts-panel";

// The prompts panel: per-app list, enable flow, import, and the editor
// dialog. The API client is mocked at the boundary — the projection rules
// themselves are covered by test/provider-switch-prompts.test.js.

vi.mock("../lib/copy", () => ({ copy: (key) => key }));

vi.mock("../lib/provider-switch-api", () => ({
  promptsApi: {
    list: vi.fn(),
    upsert: vi.fn(),
    enable: vi.fn(),
    remove: vi.fn(),
    import: vi.fn(),
  },
}));

const fixturePrompts = [
  { id: "p1", name: "Terse", content: "answer tersely", description: "", enabled: true, updatedAt: "2026-10-05T00:00:00.000Z" },
  { id: "p2", name: "Verbose", content: "answer at length", description: "long form", enabled: false, updatedAt: "2026-10-05T00:00:00.000Z" },
];

function listResult(prompts = fixturePrompts) {
  return { ok: true, app: "claude", prompts, targetPath: "/home/x/.claude/CLAUDE.md" };
}

beforeEach(() => {
  vi.resetAllMocks();
  promptsApi.list.mockResolvedValue(listResult());
});
afterEach(cleanup);

it("loads the default app's prompts and shows the target file", async () => {
  render(<ProviderPromptsPanel />);
  await waitFor(() => expect(promptsApi.list).toHaveBeenCalledWith("claude"));
  expect(await screen.findByText("Terse")).toBeTruthy();
  // copy() is stubbed to the bare key here; the raw path rides on the title.
  expect(screen.getByText("pswitch.prompts.target").title).toContain("CLAUDE.md");
});

it("switches app via the chips and reloads", async () => {
  render(<ProviderPromptsPanel />);
  await screen.findByText("Terse");
  promptsApi.list.mockResolvedValue({ ok: true, app: "hermes", prompts: [], targetPath: "/home/x/.hermes/SOUL.md" });
  fireEvent.click(screen.getByRole("button", { name: "pswitch.tab.hermes" }));
  await waitFor(() => expect(promptsApi.list).toHaveBeenCalledWith("hermes"));
  expect(await screen.findByText("pswitch.prompts.empty_title")).toBeTruthy();
});

it("enables a disabled prompt and swaps in the returned list", async () => {
  promptsApi.enable.mockResolvedValue({
    ok: true,
    prompts: [{ ...fixturePrompts[0], enabled: false }, { ...fixturePrompts[1], enabled: true }],
    targetPath: "/home/x/.claude/CLAUDE.md",
  });
  render(<ProviderPromptsPanel />);
  const enableButton = await screen.findByRole("button", { name: "pswitch.prompts.enable" });
  await act(async () => { fireEvent.click(enableButton); });
  expect(promptsApi.enable).toHaveBeenCalledWith("claude", "p2");
  // The active badge must MOVE from Terse to Verbose — asserting only the
  // count would stay green even if the list never swapped.
  await waitFor(() => {
    const badges = screen.getAllByText("pswitch.prompts.enabled_badge");
    expect(badges).toHaveLength(1);
    const card = badges[0].closest("div[class]").parentElement;
    expect(card.textContent).toContain("Verbose");
    expect(card.textContent).not.toContain("Terse");
  });
  // The previously enabled prompt can now be enabled again; delete unlocks.
  expect(screen.getByRole("button", { name: "pswitch.prompts.enable" })).toBeTruthy();
});

it("saves a new prompt from the dialog with the enabled flag", async () => {
  promptsApi.upsert.mockResolvedValue({
    ok: true,
    prompts: [...fixturePrompts, { id: "p3", name: "New", content: "hello", enabled: true }],
    targetPath: "/home/x/.claude/CLAUDE.md",
  });
  render(<ProviderPromptsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "pswitch.prompts.add" }));
  const nameInput = await screen.findByLabelText("pswitch.prompts.field_name");
  await act(async () => {
    fireEvent.change(nameInput, { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText("pswitch.prompts.field_content"), { target: { value: "hello" } });
    fireEvent.click(screen.getByLabelText("pswitch.prompts.field_enabled"));
  });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "pswitch.action.save" })); });
  await waitFor(() => expect(promptsApi.upsert).toHaveBeenCalledWith("claude", {
    id: expect.any(String),
    name: "New",
    description: "",
    content: "hello",
    enabled: true,
  }));
  expect(await screen.findByText("New")).toBeTruthy();
});

it("deletes a disabled prompt through the confirm modal", async () => {
  promptsApi.remove.mockResolvedValue({ ok: true, prompts: [fixturePrompts[0]], targetPath: "/home/x/.claude/CLAUDE.md" });
  render(<ProviderPromptsPanel />);
  await screen.findByText("Verbose");
  // Exactly one delete button is enabled: the disabled prompt's (the active
  // prompt's is disabled, matching the backend refusal).
  const deleteButton = screen.getAllByRole("button", { name: "pswitch.prompts.delete_title" })
    .find((button) => !button.disabled);
  expect(deleteButton).toBeTruthy();
  await act(async () => { fireEvent.click(deleteButton); });
  fireEvent.click(await screen.findByRole("button", { name: "pswitch.action.delete" }));
  await waitFor(() => expect(promptsApi.remove).toHaveBeenCalledWith("claude", "p2"));
  await waitFor(() => expect(screen.queryByText("Verbose")).toBeNull());
});

it("imports the live file and surfaces the refreshed list", async () => {
  promptsApi.import.mockResolvedValue({
    ok: true,
    prompts: [...fixturePrompts, { id: "imported-1", name: "Imported", content: "x", enabled: false }],
    targetPath: "/home/x/.claude/CLAUDE.md",
  });
  render(<ProviderPromptsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "pswitch.prompts.import" }));
  await waitFor(() => expect(promptsApi.import).toHaveBeenCalledWith("claude"));
  expect(await screen.findByText("Imported")).toBeTruthy();
});

it("shows the load error state when the backend fails", async () => {
  promptsApi.list.mockRejectedValue(new Error("backend down"));
  render(<ProviderPromptsPanel />);
  await waitFor(() => expect(screen.getByText("backend down")).toBeTruthy());
});
