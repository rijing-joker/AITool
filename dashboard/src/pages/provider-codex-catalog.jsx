import React from "react";
import { ChevronDown, Download, Plus, Trash2 } from "lucide-react";
import { copy } from "../lib/copy";
import { ModelDropdown } from "./provider-model-dropdown";
import { showToast } from "../ui/components/Toast";

// Codex model mapping editor — port of cc-switch's catalog table: each row
// (menu display name, requested model, context window, reasoning levels)
// becomes one entry in the model catalog file that config.toml's
// model_catalog_json points at, feeding Codex's /model menu. Rows live in
// provider meta (codexCatalogModels); the backend renders the file on switch.

// Mirror of the backend's CODEX_REASONING_LEVELS (ascending depth).
const CODEX_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// Mirror of the backend pricing.normalizeModelId — the models.dev metadata
// map from /api/proxy/pricing?include=1 is keyed by the same normalized ids.
function normalizeModelId(modelId) {
  const raw = String(modelId ?? "");
  const afterSlash = raw.slice(raw.lastIndexOf("/") + 1);
  const beforeColon = afterSlash.split(":")[0] ?? "";
  let normalized = beforeColon.trim().replace(/@/g, "-").toLowerCase();
  if (normalized.endsWith("[1m]")) {
    normalized = normalized.slice(0, -4).trim();
  }
  return normalized;
}

function metadataForModel(modelMetadata, modelId) {
  if (!modelMetadata) return null;
  const entry = modelMetadata[normalizeModelId(modelId)];
  if (!entry) return null;
  const contextWindow = Number.isFinite(entry.contextWindow) && entry.contextWindow > 0 ? String(Math.trunc(entry.contextWindow)) : "";
  const levels = Array.isArray(entry.reasoningEfforts)
    ? CODEX_REASONING_LEVELS.filter((level) => entry.reasoningEfforts.includes(level))
    : [];
  return { contextWindow, levels };
}

// Only blank fields are filled — user-entered values always win
// (cc-switch's fillCodexCatalogModel rule). Returns the patch or null.
function fillRowMetadata(row, modelId, modelMetadata) {
  const metadata = metadataForModel(modelMetadata, modelId);
  if (!metadata) return null;
  const patch = {};
  if (!String(row.contextWindow ?? "").trim() && metadata.contextWindow) patch.contextWindow = metadata.contextWindow;
  if (!(row.reasoningLevels || []).length && metadata.levels.length) patch.reasoningLevels = metadata.levels;
  return Object.keys(patch).length > 0 ? patch : null;
}

// Searchable checkbox list over the fetched /models ids (cc-switch
// FetchedModelPicker): picked ids become catalog rows named after the model.
function FetchedModelPicker({ fetchedModels, configuredIds, onAdd }) {
  const [search, setSearch] = React.useState("");
  const [selectedIds, setSelectedIds] = React.useState(() => new Set());
  const query = search.trim().toLowerCase();
  const visibleModels = fetchedModels.filter((id) => id.toLowerCase().includes(query));
  let pendingCount = 0;
  for (const id of selectedIds) {
    if (!configuredIds.has(id)) pendingCount += 1;
  }
  const toggle = (id, on) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const addSelected = () => {
    const ids = fetchedModels.filter((id) => selectedIds.has(id) && !configuredIds.has(id));
    if (ids.length === 0) return;
    setSelectedIds(new Set());
    onAdd(ids);
  };

  return (
    <fieldset className="mt-2 rounded-lg border border-oai-gray-200 p-3 dark:border-oai-gray-800">
      <legend className="px-1 text-xs font-medium text-oai-gray-600 dark:text-oai-gray-300">
        {copy("pswitch.catalog.picker_title", { count: fetchedModels.length })}
      </legend>
      <input
        type="text"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
        placeholder={copy("pswitch.catalog.picker_search")}
        aria-label={copy("pswitch.catalog.picker_search")}
        autoComplete="off"
        spellCheck={false}
        className="w-full rounded-md border border-oai-gray-200 bg-white px-2 py-1.5 text-xs text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:text-white"
      />
      <div className="mt-2 max-h-48 overflow-y-auto pr-1">
        {visibleModels.length === 0 ? (
          <p className="py-4 text-center text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("pswitch.catalog.picker_empty")}</p>
        ) : (
          visibleModels.map((id) => {
            const isConfigured = configuredIds.has(id);
            return (
              <label key={id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-oai-gray-50 dark:hover:bg-oai-gray-900">
                <input
                  type="checkbox"
                  aria-label={id}
                  checked={isConfigured || selectedIds.has(id)}
                  disabled={isConfigured}
                  onChange={(event) => toggle(id, event.currentTarget.checked)}
                  className="h-3 w-3 rounded border-oai-gray-300 accent-oai-brand-500"
                />
                <span className="min-w-0 flex-1 break-all font-mono text-xs text-oai-gray-700 dark:text-oai-gray-200">{id}</span>
                {isConfigured ? <span className="shrink-0 text-[10px] text-oai-gray-400 dark:text-oai-gray-500">{copy("pswitch.catalog.picker_added")}</span> : null}
              </label>
            );
          })
        )}
      </div>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          disabled={pendingCount === 0}
          onClick={addSelected}
          className="rounded-md border border-oai-gray-200 px-2 py-1 text-xs font-medium text-oai-gray-600 hover:bg-oai-gray-50 disabled:opacity-40 dark:border-oai-gray-700 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800"
        >
          {copy("pswitch.catalog.picker_add_selected", { count: pendingCount })}
        </button>
      </div>
    </fieldset>
  );
}

function RowInput({ value, onChange, placeholder, ariaLabel, numeric }) {
  return (
    <input
      type="text"
      value={String(value ?? "")}
      onChange={(event) => {
        const next = numeric ? event.target.value.replace(/[^\d]/g, "") : event.target.value;
        onChange(next);
      }}
      placeholder={placeholder || ""}
      autoComplete="off"
      spellCheck={false}
      aria-label={ariaLabel}
      className="w-full rounded-md border border-oai-gray-200 bg-white px-2 py-1.5 font-mono text-xs text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:text-white"
    />
  );
}

function ReasoningLevelsPicker({ levels, defaultLevel, onLevelsChange, onDefaultLevelChange }) {
  const selected = CODEX_REASONING_LEVELS.filter((level) => (levels || []).includes(level));
  const summaryLabel = selected.length > 0 ? selected.join(", ") : copy("pswitch.catalog.levels_unset");
  // Precomputed for the JSX below (the ui-hardcode JSX text scan reads bare
  // `> 0 ?` spans as raw text).
  let hasSelection = false;
  for (const level of selected) {
    if (level) hasSelection = true;
  }

  const toggleLevel = (level) => {
    const picked = selected.includes(level) ? selected.filter((item) => item !== level) : [...selected, level];
    const next = CODEX_REASONING_LEVELS.filter((item) => picked.includes(item));
    onLevelsChange(next);
    if (defaultLevel && !next.includes(defaultLevel)) onDefaultLevelChange("");
  };

  return (
    <details className="rounded-md border border-oai-gray-200 bg-white px-2 py-1.5 dark:border-oai-gray-800 dark:bg-oai-gray-950">
      <summary
        className="flex cursor-pointer list-none items-center justify-between gap-1 text-xs text-oai-gray-600 dark:text-oai-gray-300"
        aria-label={copy("pswitch.catalog.col_reasoning")}
      >
        <span className="min-w-0 truncate">{summaryLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-oai-gray-400" />
      </summary>
      <div className="mt-2 space-y-1 border-t border-oai-gray-100 pt-2 dark:border-oai-gray-800">
        {CODEX_REASONING_LEVELS.map((level) => (
          <label
            key={level}
            className="flex cursor-pointer items-center gap-1.5 py-0.5 font-mono text-xs text-oai-gray-600 dark:text-oai-gray-300"
          >
            <input
              type="checkbox"
              checked={selected.includes(level)}
              onChange={() => toggleLevel(level)}
              className="h-3 w-3 rounded border-oai-gray-300 accent-oai-brand-500"
            />
            {level}
          </label>
        ))}
        {hasSelection ? (
          <label className="block border-t border-oai-gray-100 pt-1.5 text-[10px] uppercase tracking-wide text-oai-gray-400 dark:border-oai-gray-800">
            {copy("pswitch.catalog.levels_default")}
            <select
              value={defaultLevel || ""}
              onChange={(event) => onDefaultLevelChange(event.target.value)}
              aria-label={copy("pswitch.catalog.levels_default")}
              className="mt-1 w-full rounded-md border border-oai-gray-200 bg-white px-1.5 py-1 font-mono text-xs text-oai-black focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
            >
              <option value="">—</option>
              {selected.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </details>
  );
}

export function CodexCatalogEditor({ models, onChange, fetchedModels, fetchState, onFetch, defaultModel, onAddToMapping, modelMetadata }) {
  const rows = Array.isArray(models) ? models : [];
  const hasFetched = Array.isArray(fetchedModels) && fetchedModels.length > 0;

  const updateRow = (index, patch) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const removeRow = (index) => {
    const next = rows.filter((row, i) => i !== index);
    onChange(next.length > 0 ? next : undefined);
  };
  const addRow = () => {
    onChange([...rows, { model: "", displayName: "", contextWindow: "", reasoningLevels: [], defaultReasoningLevel: "" }]);
  };
  const configuredIds = new Set(rows.map((row) => String(row.model || "").trim()).filter(Boolean));
  // Picked models become rows named after the model id; known context
  // windows and reasoning levels are filled from the models.dev metadata
  // (cc-switch's handleAddFetchedCatalogRows + fillCatalogRowMetadata).
  const addFetchedRows = (ids) => {
    const present = new Set(configuredIds);
    const additions = [];
    let filledCount = 0;
    for (const id of ids) {
      if (!id || present.has(id)) continue;
      present.add(id);
      const row = { model: id, displayName: id, contextWindow: "", reasoningLevels: [], defaultReasoningLevel: "" };
      const patch = fillRowMetadata(row, id, modelMetadata);
      if (patch) filledCount += 1;
      additions.push(patch ? { ...row, ...patch } : row);
    }
    if (additions.length === 0) return;
    onChange([...rows, ...additions]);
    if (filledCount > 0) showToast({ title: copy("pswitch.catalog.filled_many", { count: filledCount }) });
  };
  const selectRowModel = (index, row, model) => {
    const patch = fillRowMetadata(row, model, modelMetadata);
    updateRow(index, {
      model,
      displayName: String(row.displayName || "").trim() ? row.displayName : model,
      ...(patch || {}),
    });
    if (patch) showToast({ title: copy("pswitch.catalog.filled", { model }) });
  };

  const trimmedDefault = String(defaultModel || "").trim();
  // Loops, not .some(): the ui-hardcode JSX text scan reads a brace-free
  // arrow before `return (` as raw text.
  let defaultInCatalog = false;
  for (const row of rows) {
    if (String(row.model || "").trim() === trimmedDefault && trimmedDefault) defaultInCatalog = true;
  }
  let hasRows = false;
  for (const row of rows) {
    if (row) hasRows = true;
  }
  const showNotInCatalog = hasRows && !!trimmedDefault && !defaultInCatalog;

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">
          {copy("pswitch.catalog.title")}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onFetch}
            disabled={fetchState === "loading"}
            className="inline-flex items-center gap-1 text-xs font-medium text-oai-brand-600 hover:underline disabled:opacity-50 dark:text-oai-brand-400"
          >
            <Download className="h-3 w-3" />
            {fetchState === "loading" ? copy("pswitch.models.fetching") : copy("pswitch.models.fetch")}
          </button>
          <button
            type="button"
            onClick={addRow}
            className="inline-flex items-center gap-1 text-xs font-medium text-oai-brand-600 hover:underline dark:text-oai-brand-400"
          >
            <Plus className="h-3 w-3" />
            {copy("pswitch.catalog.add_model")}
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("pswitch.catalog.hint")}</p>
      {hasFetched ? <FetchedModelPicker fetchedModels={fetchedModels} configuredIds={configuredIds} onAdd={addFetchedRows} /> : null}
      {hasRows ? (
        <div className="mt-2 space-y-2">
          <div className="hidden grid-cols-[1fr_1fr_110px_150px_28px] gap-2 px-0.5 text-[10px] font-medium uppercase tracking-wide text-oai-gray-400 md:grid">
            <span>{copy("pswitch.catalog.col_display")}</span>
            <span>{copy("pswitch.catalog.col_model")}</span>
            <span>{copy("pswitch.catalog.col_context")}</span>
            <span>{copy("pswitch.catalog.col_reasoning")}</span>
            <span />
          </div>
          {rows.map((row, index) => (
            <div key={index} className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_110px_150px_28px]">
              <RowInput
                value={row.displayName}
                onChange={(value) => updateRow(index, { displayName: value })}
                placeholder={copy("pswitch.catalog.col_display")}
                ariaLabel={copy("pswitch.catalog.col_display")}
              />
              <div className="flex min-w-0 gap-1">
                <RowInput
                  value={row.model}
                  onChange={(value) => updateRow(index, { model: value })}
                  placeholder={copy("pswitch.catalog.col_model")}
                  ariaLabel={copy("pswitch.catalog.col_model")}
                />
                {hasFetched ? (
                  <ModelDropdown
                    models={fetchedModels}
                    onSelect={(model) => selectRowModel(index, row, model)}
                  />
                ) : null}
              </div>
              <RowInput
                value={row.contextWindow}
                onChange={(value) => updateRow(index, { contextWindow: value })}
                placeholder="262144"
                ariaLabel={copy("pswitch.catalog.col_context")}
                numeric
              />
              <ReasoningLevelsPicker
                levels={row.reasoningLevels}
                defaultLevel={row.defaultReasoningLevel}
                onLevelsChange={(levels) => updateRow(index, { reasoningLevels: levels })}
                onDefaultLevelChange={(level) => updateRow(index, { defaultReasoningLevel: level })}
              />
              <button
                type="button"
                onClick={() => removeRow(index)}
                aria-label={copy("pswitch.action.delete")}
                title={copy("pswitch.action.delete")}
                className="flex h-7 w-7 items-center justify-center rounded-md text-oai-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <details className="md:col-span-5 rounded-md border border-oai-gray-200 bg-white px-2 py-1.5 dark:border-oai-gray-800 dark:bg-oai-gray-950">
                <summary
                  className="flex cursor-pointer list-none items-center justify-between gap-1 text-xs text-oai-gray-600 dark:text-oai-gray-300"
                  aria-label={copy("pswitch.catalog.col_instructions")}
                >
                  <span className="min-w-0 truncate">
                    {String(row.baseInstructions || "").trim()
                      ? copy("pswitch.catalog.instructions_set")
                      : copy("pswitch.catalog.col_instructions")}
                  </span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-oai-gray-400" />
                </summary>
                <textarea
                  aria-label={copy("pswitch.catalog.col_instructions")}
                  rows={5}
                  spellCheck={false}
                  value={String(row.baseInstructions || "")}
                  onChange={(event) => updateRow(index, { baseInstructions: event.currentTarget.value })}
                  placeholder={copy("pswitch.catalog.instructions_placeholder")}
                  className="mt-2 w-full resize-y rounded-md border border-oai-gray-200 bg-oai-gray-50 p-2 font-mono text-xs leading-relaxed dark:border-oai-gray-800 dark:bg-oai-gray-900"
                />
                <p className="mt-1 text-[10px] text-oai-gray-400 dark:text-oai-gray-500">
                  {copy("pswitch.catalog.instructions_hint")}
                </p>
              </details>
            </div>
          ))}
        </div>
      ) : null}
      {showNotInCatalog ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-oai-gray-400 dark:text-oai-gray-500">
          {copy("pswitch.catalog.not_in_catalog")}
          <button
            type="button"
            onClick={onAddToMapping}
            className="font-medium text-oai-brand-600 hover:underline dark:text-oai-brand-400"
          >
            {copy("pswitch.catalog.add_to_mapping")}
          </button>
        </p>
      ) : null}
    </div>
  );
}

export default CodexCatalogEditor;
