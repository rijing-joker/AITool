import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { maskIdentifier, maskSensitiveText } from "../lib/privacy-mask";
import { ProxyPrivacyNotice, ProxyPrivacyToggle, setProxyPrivacy } from "../lib/proxy-privacy";
import { managementApi } from "../lib/easy-providers";
import { AuthFilesTab } from "./auth-files-tab";
import { showToast } from "../ui/components/Toast";

vi.mock("../lib/copy", () => ({ copy: (key, vars) => vars ? `${key} ${JSON.stringify(vars)}` : key }));
vi.mock("../lib/local-api-auth", () => ({ getLocalApiAuthHeaders: async () => ({}) }));
vi.mock("../ui/components/Toast", () => ({ showToast: vi.fn() }));
afterEach(() => { cleanup(); setProxyPrivacy(false); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("shows the saved privacy state and a visible explanation after enabling", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, enabled: false }) });
  vi.stubGlobal("fetch", fetchMock);
  render(<><ProxyPrivacyToggle /><ProxyPrivacyNotice /></>);
  const button = await screen.findByRole("button", { name: "proxy.privacy.off" });
  expect(button).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByText("proxy.privacy.activeHint")).not.toBeInTheDocument();
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(button).toHaveTextContent("proxy.privacy.on"));
  expect(button).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("status")).toHaveTextContent("proxy.privacy.activeHint");
  expect(screen.getByRole("status")).toHaveTextContent("proxy.privacy.example");
  expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body)).toEqual({ enabled: true });
  fireEvent.click(button);
  await waitFor(() => expect(button).toHaveTextContent("proxy.privacy.off"));
  expect(screen.queryByText("proxy.privacy.activeHint")).not.toBeInTheDocument();
});

it("retains the displayed privacy state when saving fails", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, enabled: false }) })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false }) }));
  render(<><ProxyPrivacyToggle /><ProxyPrivacyNotice /></>);
  const button = await screen.findByRole("button", { name: "proxy.privacy.off" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(showToast).toHaveBeenCalledWith({ title: "proxy.privacy.saveFailed", type: "error" }));
  expect(button).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByText("proxy.privacy.activeHint")).not.toBeInTheDocument();
});

it("masks embedded identity variants, project IDs, emails and URL userinfo", () => {
  const identities = ["alice@example.com", "my-gcp-project-123456"];
  const masked = maskSensitiveText("alice_example_com.json my-gcp-project-123456 http://alice:password@proxy.test bob@test.io", identities);
  expect(masked).not.toMatch(/alice|123456|password|bob/);
  expect(masked).toContain("my***56");
  expect(masked).toContain("http://***@proxy.test");
  expect(maskIdentifier("abcd")).toBe("***");
});

it("masks saved accounts, filenames and confirmation dialogs while copying originals and refreshing counts", async () => {
  const account = { name: "codex-alice_example_com-my-project-123456.json", email: "alice@example.com", project_id: "my-project-123456", provider: "codex", source: "file", status: "active" };
  const apiKey = { name: "native.json", provider: "codex", account_type: "api_key", runtime_only: true };
  const get = vi.spyOn(managementApi, "get").mockImplementation(async (route) => route === "/auth-files" ? { files: [account, apiKey] } : {});
  const writeText = vi.fn().mockResolvedValue();
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  setProxyPrivacy(true);
  const { container } = render(<AuthFilesTab />);
  const overview = await screen.findByRole("region", { name: "proxy.accounts.title" });
  expect(overview).toHaveTextContent('"count":1');
  expect(container.textContent).not.toMatch(/alice|123456/);
  for (const node of container.querySelectorAll("[title], [aria-label]")) expect(`${node.title} ${node.getAttribute("aria-label")}`).not.toMatch(/alice|123456/);
  fireEvent.click(screen.getAllByRole("button", { name: "proxy.creds.copyName" })[0]);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(account.name));
  const deleteButtons = screen.getAllByRole("button", { name: "proxy.upstream.common.delete" });
  fireEvent.click(deleteButtons.find((button) => !button.disabled));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).not.toMatch(/alice|123456/);
  // Restore raw display without changing the underlying record.
  act(() => setProxyPrivacy(false));
  expect(dialog).toHaveTextContent(account.name);
  get.mockImplementation(async (route) => route === "/auth-files" ? { files: [account, { ...account, name: "other.json", email: "other@test.io", disabled: true }] } : {});
  act(() => window.dispatchEvent(new Event("aitool:credentials-changed")));
  await waitFor(() => expect(within(overview).getByText(/"count":2/)).toBeInTheDocument());
  expect(overview).toHaveTextContent("proxy.creds.status.disabled");
  vi.unstubAllGlobals();
});

it("masks account identities in credential catalog errors", async () => {
  const account = { name: "codex-alice_example_com.json", email: "alice@example.com", provider: "codex", source: "file", status: "active" };
  vi.spyOn(managementApi, "get").mockImplementation(async (route) => {
    if (route === "/auth-files") return { files: [account] };
    if (route === "/auth-files/models") throw new Error(`Cannot load ${account.name} for ${account.email}`);
    return {};
  });
  setProxyPrivacy(true);
  render(<AuthFilesTab />);
  fireEvent.click(await screen.findByRole("button", { name: "proxy.creds.settings.button" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(/Cannot load/);
  expect(dialog.textContent).not.toMatch(/alice|example/);
});

it("masks a newly imported project before the account list refreshes", async () => {
  vi.spyOn(managementApi, "get").mockResolvedValue({ files: [] });
  const projectId = "new-project-123456";
  const email = "service@new-project.iam.gserviceaccount.com";
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: { projectId, email } }) });
  vi.stubGlobal("fetch", fetchMock);
  setProxyPrivacy(true);
  const { container } = render(<AuthFilesTab />);
  await screen.findByRole("region", { name: "proxy.accounts.title" });
  fireEvent.click(screen.getByRole("button", { name: "proxy.creds.vertex.button" }));
  const content = JSON.stringify({ type: "service_account", project_id: projectId, client_email: email });
  const file = new File([content], `${projectId}.json`, { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => content });
  const input = [...container.querySelectorAll('input[type="file"]')].find((node) => !node.multiple);
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining("proxy.creds.vertex.imported"), "success"));
  expect(showToast.mock.calls.at(-1)[0]).not.toContain(projectId);
  expect(showToast.mock.calls.at(-1)[0]).not.toContain(email);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ content, name: file.name });
});
