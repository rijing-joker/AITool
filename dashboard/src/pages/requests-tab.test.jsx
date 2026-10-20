import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RequestsTab } from "./requests-tab";
import { setProxyPrivacy } from "../lib/proxy-privacy";
import { showToast } from "../ui/components/Toast";
import { managementApi, providerGroupsApi } from "../lib/easy-providers";
vi.mock("../lib/copy", () => ({ copy: (key) => key }));
vi.mock("../ui/components/Toast", () => ({ showToast: vi.fn() }));
const response = { ok: true, total: 1, records: [{ id: "fixture", timestamp: "2026-10-02T00:00:00Z", model: "fixture-model", tokens: { totalTokens: 123 } }], stats: { total_requests: 1, success_count: 1, failure_count: 0, canceled_count: 0, total_tokens: 123, models: [], providers: [{ provider: "fixture-provider", requests: 1, total_tokens: 123, failures: 0 }] } };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => response })));
});
afterEach(() => { cleanup(); setProxyPrivacy(false); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
// BudgetBar polls /api/proxy/budget on its own schedule — count records
// requests specifically so assertions stay independent of that poll.
function recordsCalls() {
  return fetch.mock.calls.filter(([url]) => String(url).includes("usage/records"));
}
async function chooseOption(label, option) {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}
async function setup(overrides = {}) {
  if (Object.keys(overrides).length > 0) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ ...response, ...overrides }) })));
  }
  render(<RequestsTab />);
  await screen.findByText(overrides.records?.[0]?.model || "fixture-model");
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

it.each([
  ["claude", "claude-sonnet-4", 100, 50, 0, "33.33%"],
  ["anthropic", "custom-model", 100, 50, 50, "25.00%"],
  ["claude", "custom-model", 0, 50, 0, "100.00%"],
  [undefined, "claude-sonnet-4", 100, 50, 0, "33.33%"],
  ["openai", "gpt-5", 100, 50, 0, "50.00%"],
  ["gemini", "gemini-2.5-pro", 100, 50, 0, "50.00%"],
  ["openai", "claude-sonnet-4", 100, 50, 0, "50.00%"],
  ["claude", "gpt-5", 100, 50, 0, "33.33%"],
  [undefined, "gpt-5", 100, 50, 0, "50.00%"],
  ["openai", "gpt-5", 100, 200, 0, "100.00%"],
])("shows cache rates using executor %s and model %s (%i/%i/%i)", async (executor_type, model, inputTokens, cacheReadTokens, cacheCreationTokens, expected) => {
  await setup({ records: [{
    ...response.records[0], executor_type, model,
    tokens: { inputTokens, cacheReadTokens, cacheCreationTokens },
  }] });
  // The default combined cache column and the optional rate column agree.
  expect(screen.getByText(expected)).toBeInTheDocument();
  await openColumnSettings();
  fireEvent.click(screen.getByRole("checkbox", { name: "proxy.requests.col.cacheRate" }));
  fireEvent.click(screen.getByRole("button", { name: "shared.action.apply" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getAllByText(expected)).toHaveLength(2);
  expect(screen.getByTitle(expected)).toHaveTextContent(expected);
  localStorage.removeItem("aitool.usage-events-visible-cols.v1");
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
  const revokeObjectURL = vi.fn();
  // jsdom's Blob lacks .text(); Node's can be read back.
  const { Blob: NodeBlob } = await import("node:buffer");
  vi.stubGlobal("Blob", NodeBlob);
  class DownloadURL extends URL {}
  vi.stubGlobal("URL", Object.assign(DownloadURL, { createObjectURL, revokeObjectURL }));
  vi.useFakeTimers();
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
  act(() => vi.advanceTimersByTime(1000));
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:csv");
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

it.each([
  ["auth-second", "https://override.example.com/v1/responses", { "X-Route": "override" }],
  ["auth-third", "https://group.example.com/v1/responses", { "X-Route": "group", "X-Shared": "yes" }],
])("replays a non-first group key with its effective config (%s)", async (authIndex, url, headers) => {
  const group = {
    name: "Codex relay", "base-url": "https://group.example.com/v1",
    headers: { "X-Route": "group", "X-Shared": "yes" },
    keys: [
      { "api-key": "sk-first", "auth-index": "auth-first" },
      { "api-key": "sk-second", auth_index: "auth-second", "base-url": "https://override.example.com/v1", headers: { "X-Route": "override" } },
      { "api-key": "sk-third", authIndex: "auth-third", "base-url": null, headers: null },
    ],
  };
  vi.spyOn(providerGroupsApi, "get").mockImplementation(async (section) => section === "codex-api-key" ? [group] : []);
  const post = vi.spyOn(managementApi, "post").mockResolvedValue({ status_code: 200, body: "replay succeeded" });
  await setup({ records: [{ ...response.records[0], auth_index: authIndex }] });
  expect(screen.queryByRole("button", { name: "proxy.requests.replay.action" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "proxy.requests.detail.toggle" }));
  expect(screen.getByText("proxy.requests.replay.hint")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "proxy.requests.replay.action" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const [endpoint, request, options] = post.mock.calls[0];
  expect(endpoint).toBe("/api-call");
  expect(options).toEqual({ timeoutMs: 30000 });
  expect(request).toMatchObject({ authIndex, method: "POST", url, header: { Authorization: "Bearer $TOKEN$", ...headers } });
  expect(JSON.parse(request.data).model).toBe("fixture-model");
  if (authIndex === "auth-second") expect(request.header).not.toHaveProperty("X-Shared");
  expect(JSON.stringify(request)).not.toContain("sk-");
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
  await userEvent.click(screen.getByRole("combobox", { name: "proxy.requests.page_size" }));
  await userEvent.click((await screen.findAllByRole("option", { name: "proxy.requests.page_size" }))[0]);
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
  await userEvent.click(screen.getByRole("combobox", { name: "proxy.requests.page_size" }));
  await userEvent.click((await screen.findAllByRole("option", { name: "proxy.requests.page_size" }))[2]);
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

// formatDay is locale/TZ-dependent, so the expected label is derived the same
// way the component derives it, and the fixture timestamps stay inside offsets
// the test runners use: 1h apart is the same local date everywhere, 48h apart
// is a different local date everywhere.
const dayLabel = (timestamp) => new Date(timestamp).toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" });

it("shows the day label only on the first record of each local date", async () => {
  const a = "2026-10-02T12:00:00Z";
  const b = "2026-10-02T13:00:00Z";
  await setup({
    records: [
      { ...response.records[0], id: "a", timestamp: a },
      { ...response.records[0], id: "b", model: "fixture-model-b", timestamp: b },
    ],
    total: 2,
    stats: { ...response.stats, total_requests: 2 },
  });
  expect(screen.getAllByText(dayLabel(a))).toHaveLength(1);
});

it("repeats the day label when the local date changes", async () => {
  const a = "2026-10-02T12:00:00Z";
  const b = "2026-10-04T12:00:00Z";
  await setup({
    records: [
      { ...response.records[0], id: "a", timestamp: a },
      { ...response.records[0], id: "b", model: "fixture-model-b", timestamp: b },
    ],
    total: 2,
    stats: { ...response.stats, total_requests: 2 },
  });
  expect(screen.getByText(dayLabel(a))).toBeInTheDocument();
  expect(screen.getByText(dayLabel(b))).toBeInTheDocument();
});

it("keeps the table actions in the footer next to the pagination", async () => {
  await setup();
  const footer = screen.getByText("proxy.requests.range_summary").parentElement.parentElement;
  expect(footer).toContainElement(screen.getByRole("button", { name: "proxy.requests.col_settings" }));
  expect(footer).toContainElement(screen.getByRole("button", { name: "proxy.requests.export" }));
  expect(footer).toContainElement(screen.getByRole("combobox", { name: "proxy.requests.page_size" }));
});

it("allows pagination above and below the list and resets the list scroll after loading", async () => {
  await setup({ total: 150 });
  const top = screen.getByRole("navigation", { name: "proxy.requests.pagination.top" });
  const bottom = screen.getByRole("navigation", { name: "proxy.requests.pagination.bottom" });
  const wrap = document.querySelector(".usage-table-wrap");
  expect(within(top).getByRole("button", { name: "proxy.requests.prev" })).toBeDisabled();
  wrap.scrollTop = 800;
  await userEvent.click(within(top).getByRole("button", { name: "proxy.requests.next" }));
  await waitFor(() => expect(recordsCalls().at(-1)[0]).toContain("page=1"));
  await waitFor(() => expect(wrap.scrollTop).toBe(0));
  expect(top).toHaveTextContent("2 / 3");
  expect(bottom).toHaveTextContent("2 / 3");
  await userEvent.click(within(bottom).getByRole("button", { name: "proxy.requests.prev" }));
  await waitFor(() => expect(top).toHaveTextContent("1 / 3"));
});

it("refreshes filter labels while retaining exact key and upstream selections", async () => {
  let label = "Old note";
  fetch.mockImplementation(async () => ({ json: async () => ({ ...response, filterOptions: { keys: [{ key: "hash-a", label }], upstreams: [{ key: "auth:AccountA", label }], models: [], providers: [] } }) }));
  await setup();
  await chooseOption("proxy.requests.filter.key", label);
  await chooseOption("proxy.requests.filter.upstream", label);
  await waitFor(() => expect(recordsCalls().at(-1)[0]).toContain("upstream=auth%3AAccountA"));
  await waitFor(() => expect(screen.getByRole("button", { name: "proxy.upstream.common.refresh" })).toBeEnabled());
  label = "Renamed note";
  fireEvent.click(screen.getByRole("button", { name: "proxy.upstream.common.refresh" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "proxy.requests.filter.key" })).toHaveTextContent(label));
  expect(screen.getByRole("combobox", { name: "proxy.requests.filter.upstream" })).toHaveTextContent(label);
  fireEvent.click(screen.getByRole("button", { name: "proxy.upstream.common.refresh" }));
  await waitFor(() => expect(recordsCalls().at(-1)[0]).toContain("api_key_hash=hash-a"));
  expect(recordsCalls().at(-1)[0]).toContain("upstream=auth%3AAccountA");
});

it("masks displayed errors but copies and exports the original details", async () => {
  setProxyPrivacy(true);
  const failure = "Expired account alice@example.com";
  const writeText = vi.fn().mockResolvedValue();
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await setup({ records: [{ ...response.records[0], failed: true, failure_status: 401, failure_body: failure, source_display: "alice@example.com" }] });
  expect(document.body.textContent).not.toContain("alice@example.com");
  for (const node of document.querySelectorAll("[title]")) expect(node.title).not.toContain("alice@example.com");
  fireEvent.click(screen.getByRole("button", { name: "proxy.requests.copyError" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(`HTTP 401 · ${failure}`));
  const { Blob: NodeBlob } = await import("node:buffer");
  vi.stubGlobal("Blob", NodeBlob);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const createObjectURL = vi.fn(() => "blob:csv");
  class DownloadURL extends URL {}
  vi.stubGlobal("URL", Object.assign(DownloadURL, { createObjectURL, revokeObjectURL: vi.fn() }));
  fireEvent.click(screen.getByRole("button", { name: "proxy.requests.export" }));
  expect(await createObjectURL.mock.calls[0][0].text()).toContain(failure);
});


it("opens complete request metadata inline and preserves it across refreshes", async () => {
  const record = { ...response.records[0], endpoint: "/v1/responses", source_display: "Work account", api_key_remark: "Editor", tokens: { inputTokens: 120, outputTokens: 3, totalTokens: 123 } };
  await setup({ records: [record] });
  expect(screen.queryByRole("region", { name: "proxy.requests.detail.title" })).not.toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "proxy.requests.detail.toggle" });
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  const detail = screen.getByRole("region", { name: "proxy.requests.detail.title" });
  expect(detail.id).toBe(toggle.getAttribute("aria-controls"));
  expect(within(detail).getByText("/v1/responses")).toBeInTheDocument();
  expect(within(detail).getByText("proxy.requests.detail.input").nextElementSibling).toHaveTextContent("120");
  await userEvent.click(screen.getByRole("button", { name: "proxy.upstream.common.refresh" }));
  await waitFor(() => expect(showToast).toHaveBeenCalled());
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(toggle);
  expect(screen.queryByRole("region", { name: "proxy.requests.detail.title" })).not.toBeInTheDocument();
});

it("masks identities in expanded details while retaining the original error for copying", async () => {
  setProxyPrivacy(true);
  const failure = "Expired account alice@example.com";
  const writeText = vi.fn().mockResolvedValue();
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await setup({ records: [{ ...response.records[0], failed: true, failure_status: 401, failure_body: failure, source_display: "alice@example.com", api_key_remark: "alice@example.com" }] });
  await userEvent.click(screen.getByRole("button", { name: "proxy.requests.detail.toggle" }));
  const detail = screen.getByRole("region", { name: "proxy.requests.detail.title" });
  expect(detail).not.toHaveTextContent("alice@example.com");
  await userEvent.click(within(detail).getByRole("button", { name: "proxy.requests.copyError" }));
  expect(writeText).toHaveBeenCalledWith(`HTTP 401 · ${failure}`);
});
