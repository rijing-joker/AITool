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
// BudgetBar polls /api/proxy/budget on its own schedule — count records
// requests specifically so assertions stay independent of that poll.
function recordsCalls() {
  return fetch.mock.calls.filter(([url]) => String(url).includes("usage/records"));
}
async function setup(overrides = {}) {
  if (Object.keys(overrides).length > 0) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ ...response, ...overrides }) })));
  }
  render(<RequestsTab />);
  await screen.findByText("fixture-model");
}
it("coalesces typing into one filtered request", async () => {
  await setup();
  const input = screen.getByRole("combobox", { name: "proxy.requests.filter.model" });
  for (const value of ["g", "gp", "gpt"]) fireEvent.change(input, { target: { value } });
  await waitFor(() => expect(recordsCalls()).toHaveLength(2));
  expect(recordsCalls()[1][0]).toContain("model=gpt");
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
  await waitFor(() => expect(recordsCalls()).toHaveLength(2));
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
  expect(recordsCalls()).toHaveLength(1);
});
it("renders the estimated cost column and stats tile from pricing", async () => {
  await setup({
    records: [{ ...response.records[0], costUsd: 0.0013575 }],
    stats: { ...response.stats, total_cost_usd: 0.0025 },
  });
  expect(screen.getByTitle("proxy.requests.col.cost")).toBeInTheDocument();
  expect(screen.getByText("$0.0014")).toBeInTheDocument();
  const tile = screen.getByText("proxy.requests.cost").closest("div");
  expect(tile).toHaveTextContent("$0.0025");
});
it("keeps tiny and zero costs readable in the cost column and tile", async () => {
  await setup({
    records: [{ ...response.records[0], costUsd: 0.0000042 }],
    stats: { ...response.stats, total_cost_usd: 0 },
  });
  expect(screen.getByText("<$0.0001")).toBeInTheDocument();
  expect(screen.getByText("$0")).toBeInTheDocument();
});
it("exports the loaded page as a CSV download with the injection guard", async () => {
  // A model id that would be interpreted as a formula by spreadsheet apps
  // must be neutralized by the upstream's `'`-prefix guard.
  const injectionRecord = {
    id: "inj", request_id: "inj", timestamp: "2026-10-02T01:00:00Z",
    model: "=cmd|'!A1", tokens: { totalTokens: 5 },
  };
  await setup({ records: [response.records[0], injectionRecord] });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const createObjectURL = vi.fn(() => "blob:csv");
  // jsdom's Blob lacks .text(); Node's can be read back.
  const { Blob: NodeBlob } = await import("node:buffer");
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }));
  fireEvent.click(screen.getByRole("button", { name: "proxy.requests.export" }));
  expect(click).toHaveBeenCalledTimes(1);
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  const blob = createObjectURL.mock.calls[0][0];
  expect(blob).toBeInstanceOf(Blob);
  // Blob.text() strips the BOM per spec, so assert on the raw bytes first.
  const bytes = Buffer.from(await blob.arrayBuffer());
  expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel
  const csv = bytes.toString("utf8");
  expect(csv).toContain('"total_tokens"');
  expect(csv).toContain('"estimated_cost_usd"');
  expect(csv).toContain('"fixture-model"');
  expect(csv).toContain('"\'=cmd|\'!A1"'); // guarded, quoted, not bare `=…`
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

it("budget dialog accepts repeated typing without dropping the event target", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "budget.edit.title" }));
  const daily = await screen.findByLabelText("budget.edit.daily");
  // Two characters in separate events: the second onChange used to crash on a
  // nulled event.currentTarget inside the state updater.
  fireEvent.change(daily, { target: { value: "1" } });
  fireEvent.change(daily, { target: { value: "12" } });
  expect(daily).toHaveValue("12");
  fireEvent.click(screen.getByRole("button", { name: "shared.action.cancel" }));
});

it("skips the stats recompute on page changes but keeps it for polls and filters", async () => {
  await setup();
  const includeParam = (call) => String(call[0]).match(/includeStats=(\d)/)?.[1];
  // First load and polls always carry stats.
  await waitFor(() => expect(recordsCalls().length).toBeGreaterThanOrEqual(1));
  expect(includeParam(recordsCalls()[0])).toBe("1");
  // A page-size change loads without stats (identical aggregation).
  await act(async () => {
    fireEvent.change(screen.getByRole("combobox", { name: "proxy.requests.page_size", size: 50 }), { target: { value: "20" } });
  });
  await waitFor(() => expect(recordsCalls()).toHaveLength(recordsCalls().length));
  const last = recordsCalls()[recordsCalls().length - 1];
  expect(String(last[0])).toContain("pageSize=20");
  expect(includeParam(last)).toBe("0");
  // A filter change must refresh stats even though the page resets to 0.
  fireEvent.change(screen.getByRole("combobox", { name: "proxy.requests.filter.model" }), { target: { value: "gpt" } });
  await waitFor(() => expect(String(recordsCalls()[recordsCalls().length - 1][0])).toContain("model=gpt"));
  expect(includeParam(recordsCalls()[recordsCalls().length - 1])).toBe("1");
  expect(showToast).not.toHaveBeenCalled();
});

const ROW_HEIGHT_ENABLED_KEY = "aitool.usage-events-row-height-enabled.v1";
const ROW_HEIGHT_KEY = "aitool.usage-events-row-height.v1";
const PAGE_SIZE_KEY = "aitool.usage-events-page-size.v1";

function clearDisplayPrefs() {
  localStorage.removeItem(ROW_HEIGHT_ENABLED_KEY);
  localStorage.removeItem(ROW_HEIGHT_KEY);
  localStorage.removeItem(PAGE_SIZE_KEY);
}

async function openColumnSettings() {
  fireEvent.click(screen.getByRole("button", { name: "proxy.requests.col_settings" }));
  return screen.findByRole("dialog", { name: "proxy.requests.col_settings" });
}

it("applies a fixed row height from the settings dialog and persists it", async () => {
  clearDisplayPrefs();
  await setup();
  await openColumnSettings();
  const slider = screen.getByLabelText("proxy.requests.row_height.slider");
  expect(slider).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "proxy.requests.row_height.title" }));
  expect(slider).toBeEnabled();
  fireEvent.change(slider, { target: { value: "90" } });
  expect(screen.getByText("90px")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "shared.action.apply" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(localStorage.getItem(ROW_HEIGHT_ENABLED_KEY)).toBe("true");
  expect(localStorage.getItem(ROW_HEIGHT_KEY)).toBe("90");
  expect(document.querySelector("table").style.getPropertyValue("--usage-row-height")).toBe("90px");
  clearDisplayPrefs();
});

it("discards the row-height draft on cancel", async () => {
  clearDisplayPrefs();
  await setup();
  await openColumnSettings();
  fireEvent.click(screen.getByRole("checkbox", { name: "proxy.requests.row_height.title" }));
  fireEvent.change(screen.getByLabelText("proxy.requests.row_height.slider"), { target: { value: "100" } });
  fireEvent.click(screen.getByRole("button", { name: "shared.action.cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(localStorage.getItem(ROW_HEIGHT_ENABLED_KEY)).toBeNull();
  expect(localStorage.getItem(ROW_HEIGHT_KEY)).toBeNull();
  expect(document.querySelector("table").style.getPropertyValue("--usage-row-height")).toBe("");
  clearDisplayPrefs();
});

it("restores the saved row height on mount and clamps bad values", async () => {
  localStorage.setItem(ROW_HEIGHT_ENABLED_KEY, "true");
  localStorage.setItem(ROW_HEIGHT_KEY, "9999");
  await setup();
  expect(document.querySelector("table").style.getPropertyValue("--usage-row-height")).toBe("140px");
  await openColumnSettings();
  expect(screen.getByRole("checkbox", { name: "proxy.requests.row_height.title" })).toBeChecked();
  expect(screen.getByLabelText("proxy.requests.row_height.slider")).toHaveValue("140");
  clearDisplayPrefs();
});

it("remembers the chosen page size across mounts", async () => {
  clearDisplayPrefs();
  await setup();
  fireEvent.change(screen.getByRole("combobox", { name: "proxy.requests.page_size" }), { target: { value: "100" } });
  await waitFor(() => { expect(String(recordsCalls().at(-1)[0])).toContain("pageSize=100"); });
  expect(localStorage.getItem(PAGE_SIZE_KEY)).toBe("100");
  cleanup();
  render(<RequestsTab />);
  await screen.findByText("fixture-model");
  expect(String(recordsCalls().at(-1)[0])).toContain("pageSize=100");
  clearDisplayPrefs();
});

it.each([
  [40_000, "text-red-600"],
  [16_000, "text-amber-600"],
  [5_000, "text-emerald-600"],
])("tints latency cells by duration thresholds (%i ms)", async (latencyMs, tone) => {
  await setup({
    records: [{ ...response.records[0], latencyMs, ttftMs: Math.round(latencyMs / 4) }],
  });
  const cell = screen.getByTitle(`${latencyMs} ms`);
  expect(cell.querySelector("span")).toHaveClass(tone);
  // The TTFT sub-line rides in the same cell with its own band — a quarter of
  // the elapsed time always lands in the green band here.
  expect(cell.querySelector("span[title]")).toHaveClass("text-emerald-600");
});
