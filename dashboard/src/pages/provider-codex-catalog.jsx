import React from "react";
import { ChevronDown, Download, Plus, Trash2 } from "lucide-react";
import { copy } from "../lib/copy";

// Codex model mapping editor — port of cc-switch's catalog table: each row
// (menu display name, requested model, context window, reasoning levels)
// becomes one entry in the model catalog file that config.toml's
// model_catalog_json points at, feeding Codex's /model menu. Rows live in
// provider meta (codexCatalogModels); the backend renders the file on switch.

// Mirror of the backend's CODEX_REASONING_LEVELS (ascending depth).
const CODEX_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function RowInput({ value, onChange, placeholder, ariaLabel, numeric, datalistId }) {
  return (
    <input
      type="text"
      value={String(value ?? "")}
      onChange={(event) => {
        const next = numeric ? event.target.value.replace(/[^\d]/g, "") : event.target.value;
        onChange(next);
      }}
      placeholder={placeholder || ""}
      list={datalistId}
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

export function CodexCatalogEditor({ models, onChange, fetchedModels, fetchState, onFetch, defaultModel, onAddToMapping }) {
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
              <div className="flex gap-1">
                <RowInput
                  value={row.model}
                  onChange={(value) => updateRow(index, { model: value })}
                  placeholder={copy("pswitch.catalog.col_model")}
                  ariaLabel={copy("pswitch.catalog.col_model")}
                  datalistId={hasFetched ? "catalog-model-options" : undefined}
                />
                {hasFetched ? (
                  <datalist id="catalog-model-options">
                    {fetchedModels.slice(0, 200).map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
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
