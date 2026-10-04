import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RequestsTab } from "./requests-tab";
import { showToast } from "../ui/components/Toast";
vi.mock("../lib/copy", () => ({ copy: (key) => key }));
vi.mock("../ui/components/Toast", () => ({ showToast: vi.fn() }));
const response = { ok: true, total: 1, records: [{ id: "fixture", timestamp: "2026-10-02T00:00:00Z", model: "fixture-model", tokens: { totalTokens: 123 } }], stats: { total_requests: 1, success_count: 1, failure_count: 0, canceled_count: 0, total_tokens: 123, models: [], providers: [{ provider: "fixture-provider", requests: 1, total_tokens: 123, failures: 0 }] } };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => response })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function setup() { render(<RequestsTab />); await screen.findByText("fixture-model"); }
it("coalesces typing into one filtered request", async () => {
  await setup();
  const input = screen.getByRole("combobox", { name: "proxy.requests.filter.model" });
  for (const value of ["g", "gp", "gpt"]) fireEvent.change(input, { target: { value } });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch.mock.calls[1][0]).toContain("model=gpt");
});
it("feeds filter suggestions from the response stats", async () => {
  await setup();
  const providers = document.getElementById(screen.getByRole("combobox", { name: "proxy.requests.filter.provider" }).getAttribute("list"));
  expect(Array.from(providers.querySelectorAll("option")).map((option) => option.value)).toEqual(["fixture-provider"]);
});
it("only reports refresh success after the request completes", async () => {
  await setup();
  let resolve;
  fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  fireEvent.click(screen.getByRole("button", { name: "proxy.upstream.common.refresh" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(showToast).not.toHaveBeenCalled();
  await act(async () => resolve({ json: async () => response }));
  expect(showToast).toHaveBeenCalledWith({ title: "proxy.requests.refreshed", type: "success" });
});
it("retains the last records and reports stale data after refresh fails", async () => {
  await setup();
  fetch.mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(screen.getByRole("button", { name: "proxy.upstream.common.refresh" }));
  await screen.findByText("proxy.requests.stale");
  expect(screen.getByText("fixture-model")).toBeInTheDocument();
  expect(showToast).not.toHaveBeenCalled();
});
it("does not fetch an incomplete or reversed custom range", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "proxy.requests.range.custom" }));
  fireEvent.change(screen.getByLabelText("proxy.requests.range.start"), { target: { value: "2026-10-03T12:00" } });
  fireEvent.change(screen.getByLabelText("proxy.requests.range.end"), { target: { value: "2026-10-02T12:00" } });
  expect(screen.getByRole("alert")).toHaveTextContent("proxy.requests.range.invalid");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("exports the loaded page as a CSV download", async () => {
  await setup();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const createObjectURL = vi.fn(() => "blob:csv");
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }));
  fireEvent.click(screen.getByRole("button", { name: "proxy.requests.export" }));
  expect(click).toHaveBeenCalledTimes(1);
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  const blob = createObjectURL.mock.calls[0][0];
  expect(blob).toBeInstanceOf(Blob);
  click.mockRestore();
  vi.unstubAllGlobals();
});
it("applies column visibility from the settings dialog", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "proxy.requests.col_settings" }));
  const dialog = await screen.findByRole("dialog", { name: "proxy.requests.col_settings" });
  expect(dialog).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "shared.action.apply" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});
