import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  Check,
  GitFork,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { copy } from "../lib/copy";
import {
  combineModelAliasEntries,
  combineModelAliasSources,
  defaultModelAlias,
  EFFORT_OPTIONS,
  fetchAliasEditContext,
  loadAliasState,
  scoreAliasSources,
  submitCreateAlias,
  submitDeleteAlias,
  thinkingAliasProviderDetail,
  thinkingAliasSourceKindLabel,
  uniqueModelAlias,
  usableModelAlias,
} from "../lib/easy-aliases";
import { Button, ConfirmModal } from "../ui/components";
import { showToast } from "../ui/components/Toast";

// ---------------------------------------------------------------------------
// Aliases tab (模型别名) — EasyCLIProxyAPI's ThinkingAliasesPage, ported
// interaction-for-interaction: source model combobox with scored search and
// keyboard navigation, reasoning-effort buttons driven by the source's
// supported levels, fast (service-tier) switch, auto-generated unique alias,
// live preview, edit via per-alias edit context, and guarded deletes.
// ---------------------------------------------------------------------------

function AliasNotice({ message, tone = "error", onDismiss }) {
  if (!message) return null;
  const isError = tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${
        isError
          ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
      }`}
    >
      {isError ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <Check className="mt-0.5 h-4 w-4 shrink-0" />}
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={copy("proxy.upstream.common.close")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function AliasSwitch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-oai-brand-600" : "bg-oai-gray-300 dark:bg-oai-gray-700"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function AliasEditorDialog({ editor, onClose, onSaved }) {
  const {
    sources,
    editingEntry,
    editingRevision,
  } = editor;
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [effort, setEffort] = useState("");
  const [fastEnabled, setFastEnabled] = useState(false);
  const [alias, setAlias] = useState("");
  const [search, setSearch] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);
  const [busyAlias, setBusyAlias] = useState("");
  const [error, setError] = useState("");
  const modelPickerRef = useRef(null);
  const generatedAliasRef = useRef("");

  const editingSource = editor.editingSource;
  const baseSources = useMemo(() => {
    if (!editingSource) return sources;
    return [{
      ...editingSource,
      supportsReasoning: editingSource.reasoningLevels.length > 0,
      supportsFast: ["codex-oauth", "codex-api", "openai-compatible"].includes(editingSource.kind),
    }, ...sources];
  }, [sources, editingSource]);

  const filteredSources = useMemo(
    () => scoreAliasSources(baseSources, modelPickerOpen ? search : ""),
    [baseSources, search, modelPickerOpen],
  );

  useEffect(() => {
    setActiveSourceIndex(0);
  }, [search, baseSources]);

  useEffect(() => {
    if (!modelPickerOpen) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!modelPickerRef.current?.contains(event.target)) {
        setModelPickerOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [modelPickerOpen]);

  const selectedSource = useMemo(
    () => baseSources.find((source) => source.id === selectedSourceId) ?? null,
    [selectedSourceId, baseSources],
  );
  const fastAvailable = Boolean(selectedSource?.supportsFast);

  useEffect(() => {
    if (!fastAvailable) setFastEnabled(false);
  }, [fastAvailable]);

  const chooseSource = (source) => {
    setSelectedSourceId(source.id);
    setEffort("");
    setFastEnabled((current) => current && source.supportsFast);
    if (!editingEntry) setAlias("");
    generatedAliasRef.current = "";
    setModelPickerOpen(false);
    setSearch("");
  };

  const handleModelSearchKeyDown = (event) => {
    if (event.key === "Escape" && modelPickerOpen) {
      event.preventDefault();
      event.stopPropagation();
      setModelPickerOpen(false);
      setSearch("");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!modelPickerOpen) {
        setModelPickerOpen(true);
        return;
      }
      if (!filteredSources.length) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveSourceIndex((current) => (
        (current + direction + filteredSources.length) % filteredSources.length
      ));
      return;
    }
    if (event.key === "Enter" && modelPickerOpen && filteredSources[activeSourceIndex]) {
      event.preventDefault();
      chooseSource(filteredSources[activeSourceIndex]);
    }
  };

  const normalizedEffort = effort.trim().toLowerCase();
  const defaultAlias = defaultModelAlias(selectedSource?.model, normalizedEffort, fastEnabled);
  const uniqueDefaultAlias = uniqueModelAlias(defaultAlias, baseSources.map((source) => source.model));
  const aliasReusesExistingName = !editingEntry
    && Boolean(alias.trim())
    && editor.entries.some((entry) => entry.alias.trim().toLowerCase() === alias.trim().toLowerCase());
  const availableEfforts = selectedSource?.reasoningLevels ?? [];
  const visibleEffortOptions = availableEfforts.map((value) => {
    const preset = EFFORT_OPTIONS.find((option) => option.value === value);
    return preset
      ? { value: preset.value, label: preset.label, title: copy(preset.hintKey) }
      : { value, label: value, title: value };
  });

  useEffect(() => {
    if (editingEntry) return;
    setAlias((current) => {
      const currentValue = current.trim();
      const canReplace = !currentValue || currentValue === generatedAliasRef.current;
      if (!canReplace) return current;
      generatedAliasRef.current = uniqueDefaultAlias;
      return uniqueDefaultAlias;
    });
  }, [uniqueDefaultAlias, editingEntry]);

  // When opened in edit mode, prime the form from the edit context.
  useEffect(() => {
    if (editingEntry && editingSource) {
      setSelectedSourceId(editingSource.id);
      setEffort(editor.initialEffort ?? "");
      setFastEnabled(editor.initialFast ?? false);
      setAlias(editingEntry.alias);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createAlias = async () => {
    if (!selectedSource) {
      setError(copy("proxy.alias.error.selectModel"));
      return;
    }
    const normalizedAlias = alias.trim();
    if (!normalizedAlias) {
      setError(copy("proxy.alias.error.emptyAlias"));
      return;
    }
    const keepingExistingAlias = Boolean(
      editingEntry && editingEntry.alias.trim().toLowerCase() === normalizedAlias.toLowerCase(),
    );
    if (!keepingExistingAlias && !usableModelAlias(normalizedAlias)) {
      setError(copy("proxy.alias.error.invalidAlias"));
      return;
    }
    if (fastEnabled && !selectedSource.supportsFast) {
      setError(copy("proxy.alias.error.unsupportedFast"));
      return;
    }
    if (normalizedEffort && !selectedSource.supportsReasoning) {
      setError(copy("proxy.alias.error.unsupportedEffort"));
      return;
    }
    setBusyAlias(normalizedAlias);
    setError("");
    try {
      const state = await submitCreateAlias({
        sourceId: selectedSource.id,
        alias: normalizedAlias,
        effort: normalizedEffort,
        fast: fastEnabled,
        editingEntry,
        editingRevision,
      });
      showToast(editingEntry
        ? copy("proxy.alias.updated", { alias })
        : effort
          ? copy(fastEnabled ? "proxy.alias.createdCombined" : "proxy.alias.created", { alias, effort })
          : fastEnabled
            ? copy("proxy.alias.speedCreated", { alias })
            : copy("proxy.alias.createdPlain", { alias }), "success");
      onSaved(state);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusyAlias("");
    }
  };

  const dialogTitle = copy(editingEntry ? "proxy.upstream.common.edit" : "proxy.alias.create.title");

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next && !busyAlias) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center p-4">
          <Dialog.Popup className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-[0_20px_60px_-20px_rgba(0,0,0,0.25)] ring-1 ring-oai-gray-200 transition-[opacity,transform] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] data-[ending-style]:translate-y-2 data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0 dark:bg-oai-gray-950 dark:ring-oai-gray-800">
            <div className="flex items-start justify-between gap-3 border-b border-oai-gray-100 px-5 py-4 dark:border-oai-gray-800">
              <div className="min-w-0">
                <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-oai-black dark:text-white">
                  <GitFork className="h-4 w-4" />
                  {dialogTitle}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-sm text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("proxy.alias.create.description")}
                </Dialog.Description>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={Boolean(busyAlias)}
                className="shrink-0 rounded-md p-1.5 text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-black disabled:opacity-50 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                aria-label={copy("proxy.upstream.common.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("proxy.alias.originalModel")}
                </span>
                <div ref={modelPickerRef} className="relative">
                  <div className="relative">
                    {modelPickerOpen ? null : null}
                    <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-oai-gray-400" />
                    <input
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded={modelPickerOpen}
                      autoFocus
                      value={modelPickerOpen ? search : selectedSource?.model ?? ""}
                      onFocus={(event) => {
                        setSearch(selectedSource?.model ?? "");
                        setModelPickerOpen(true);
                        event.currentTarget.select();
                      }}
                      onChange={(event) => {
                        const nextSearch = event.currentTarget.value;
                        setSearch(nextSearch);
                        setModelPickerOpen(true);
                        if (
                          selectedSource
                          && nextSearch.trim().toLowerCase() !== selectedSource.model.trim().toLowerCase()
                        ) {
                          setSelectedSourceId("");
                          setEffort("");
                          setFastEnabled(false);
                          if (!editingEntry) setAlias("");
                          generatedAliasRef.current = "";
                        }
                      }}
                      onKeyDown={handleModelSearchKeyDown}
                      placeholder={copy("proxy.alias.searchModel")}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={Boolean(busyAlias)}
                      className="h-9 w-full rounded-lg border border-oai-gray-200 bg-transparent pl-8 pr-24 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700"
                    />
                    {!modelPickerOpen && selectedSource ? (
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded bg-oai-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-oai-gray-500 dark:bg-oai-gray-800 dark:text-oai-gray-400">
                        {thinkingAliasSourceKindLabel(selectedSource.kind)}
                      </span>
                    ) : null}
                  </div>
                  {modelPickerOpen ? (
                    <ul
                      role="listbox"
                      aria-label={copy("proxy.alias.availableModels")}
                      className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-oai-gray-200 bg-white py-1 shadow-lg dark:border-oai-gray-700 dark:bg-oai-gray-900"
                    >
                      {filteredSources.length === 0 ? (
                        <li className="px-3 py-2.5 text-sm text-oai-gray-400">
                          {copy(baseSources.length ? "proxy.alias.noMatch" : "proxy.alias.noModels")}
                        </li>
                      ) : filteredSources.map((source, index) => {
                        const selected = source.id === selectedSourceId;
                        return (
                          <li key={source.id}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={selected}
                              onMouseEnter={() => setActiveSourceIndex(index)}
                              onClick={() => chooseSource(source)}
                              disabled={Boolean(busyAlias)}
                              className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
                                index === activeSourceIndex
                                  ? "bg-oai-gray-100 dark:bg-oai-gray-800"
                                  : ""
                              } ${selected ? "text-oai-brand-700 dark:text-oai-brand-300" : ""}`}
                            >
                              <span className="min-w-0">
                                <span className="block truncate font-mono text-xs" title={source.model}>{source.model}</span>
                                {source.displayName && source.displayName !== source.model ? (
                                  <small className="block truncate text-xs text-oai-gray-400">{source.displayName}</small>
                                ) : null}
                              </span>
                              <span className="shrink-0 text-right">
                                <em className="block not-italic text-[11px] font-medium">
                                  {thinkingAliasSourceKindLabel(source.kind)}
                                </em>
                                <small
                                  className="block max-w-[180px] truncate text-[11px] text-oai-gray-400"
                                  title={thinkingAliasProviderDetail(source.kind, source.provider)}
                                >
                                  {thinkingAliasProviderDetail(source.kind, source.provider)}
                                </small>
                              </span>
                              {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
                {selectedSource ? (
                  <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
                    <span className="font-medium">{thinkingAliasSourceKindLabel(selectedSource.kind)}</span>
                    {" · "}
                    {copy("proxy.alias.sourceLabel", { source: thinkingAliasProviderDetail(selectedSource.kind, selectedSource.provider) })}
                  </p>
                ) : (
                  <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.alias.sourceHint")}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <strong className="text-xs font-medium text-oai-gray-700 dark:text-oai-gray-200">{copy("proxy.alias.effort.title")}</strong>
                  <span className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.alias.effort.description")}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEffort("")}
                    disabled={Boolean(busyAlias)}
                    title={copy("proxy.alias.effort.noneHint")}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                      !normalizedEffort
                        ? "border-transparent bg-oai-brand-600 text-white"
                        : "border-oai-gray-200 text-oai-gray-600 hover:border-oai-gray-300 hover:text-oai-black dark:border-oai-gray-700 dark:text-oai-gray-300 dark:hover:text-white"
                    }`}
                  >
                    {copy("proxy.alias.effort.none")}
                  </button>
                  {visibleEffortOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setEffort(option.value)}
                      disabled={Boolean(busyAlias) || Boolean(selectedSource && !selectedSource.supportsReasoning)}
                      title={option.title}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                        effort.trim().toLowerCase() === option.value
                          ? "border-transparent bg-oai-brand-600 text-white"
                          : "border-oai-gray-200 text-oai-gray-600 hover:border-oai-gray-300 hover:text-oai-black dark:border-oai-gray-700 dark:text-oai-gray-300 dark:hover:text-white"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {selectedSource && !selectedSource.supportsReasoning ? (
                  <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.alias.effort.unsupported")}</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <strong className="text-xs font-medium text-oai-gray-700 dark:text-oai-gray-200">{copy("proxy.alias.fast.title")}</strong>
                <label
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors ${
                    fastEnabled
                      ? "border-oai-brand-300 bg-oai-brand-50/60 dark:border-oai-brand-800 dark:bg-oai-brand-950/30"
                      : "border-oai-gray-200 dark:border-oai-gray-700"
                  }`}
                >
                  <span>
                    <span className="flex items-center gap-1.5 text-sm font-medium"><Zap className="h-3.5 w-3.5" /> Fast</span>
                    <small className="block text-xs text-oai-gray-400 dark:text-oai-gray-500">
                      {copy(fastEnabled ? "proxy.alias.fast.enabled" : "proxy.alias.fast.disabled")}
                    </small>
                  </span>
                  <AliasSwitch
                    checked={fastEnabled}
                    onChange={setFastEnabled}
                    disabled={Boolean(busyAlias) || !fastAvailable}
                    label={copy("proxy.alias.fast.title")}
                  />
                </label>
                {selectedSource && !selectedSource.supportsFast ? (
                  <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.alias.fast.unsupported")}</p>
                ) : null}
              </div>

              <div className="space-y-1.5 border-t border-oai-gray-100 pt-4 dark:border-oai-gray-800">
                <div className="flex items-baseline justify-between gap-2">
                  <strong className="text-xs font-medium text-oai-gray-700 dark:text-oai-gray-200">{copy("proxy.alias.aliasName.title")}</strong>
                  <span className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.alias.aliasName.autoDescription")}</span>
                </div>
                <input
                  value={alias}
                  onChange={(event) => setAlias(event.currentTarget.value)}
                  placeholder={selectedSource
                    ? normalizedEffort
                      ? copy("proxy.alias.aliasName.example", { model: selectedSource.model, effort: normalizedEffort })
                      : fastEnabled
                        ? copy("proxy.alias.aliasName.fastExample", { model: selectedSource.model })
                        : copy("proxy.alias.aliasName.example", { model: selectedSource.model, effort: "alias" })
                    : copy("proxy.alias.aliasName.selectFirst")}
                  disabled={Boolean(busyAlias)}
                  className="h-9 w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 font-mono text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700"
                />
                {aliasReusesExistingName ? (
                  <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.alias.aliasName.reuseHint")}</p>
                ) : null}
              </div>

              <div className="flex items-center gap-2.5 rounded-lg bg-oai-gray-50 px-3 py-2.5 text-sm dark:bg-oai-gray-800/60">
                {fastEnabled && !normalizedEffort ? <Zap className="h-4 w-4 shrink-0 text-amber-500" /> : <BrainCircuit className="h-4 w-4 shrink-0 text-oai-brand-600 dark:text-oai-brand-400" />}
                <span className="min-w-0 truncate font-mono text-xs">
                  {selectedSource?.model || copy("proxy.alias.notSelected")}
                  {" "}
                  <ArrowRight className="inline h-3 w-3 text-oai-gray-400" />
                  {" "}
                  {alias || copy("proxy.alias.enterAlias")}
                </span>
              </div>

              {error ? (
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-oai-gray-100 px-5 py-3.5 dark:border-oai-gray-800">
              <Button variant="secondary" disabled={Boolean(busyAlias)} onClick={onClose}>
                {copy("proxy.upstream.common.cancel")}
              </Button>
              <Button onClick={() => void createAlias()} disabled={Boolean(busyAlias)}>
                {busyAlias
                  ? <LoaderCircle className="h-4 w-4 animate-spin" />
                  : fastEnabled && !normalizedEffort ? <Zap className="h-4 w-4" /> : <GitFork className="h-4 w-4" />}
                {copy(editingEntry ? "proxy.upstream.common.save" : "proxy.alias.create")}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ModelAliasesTab() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyAlias, setBusyAlias] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState(null);
  const [editingSource, setEditingSource] = useState(null);
  const [editingRevision, setEditingRevision] = useState(null);
  const [initialEffort, setInitialEffort] = useState("");
  const [initialFast, setInitialFast] = useState(false);
  const [deleteEntry, setDeleteEntry] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await loadAliasState();
      setState(next);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sources = useMemo(() => {
    if (!state) return [];
    return combineModelAliasSources(state.baseSources, state.thinkingSources, state.speedSources);
  }, [state]);

  const entries = useMemo(() => {
    if (!state) return [];
    return combineModelAliasEntries(state.thinkingEntries, state.speedEntries);
  }, [state]);

  const resetEditor = () => {
    setEditingEntry(null);
    setEditingSource(null);
    setEditingRevision(null);
    setInitialEffort("");
    setInitialFast(false);
  };

  const addAlias = () => {
    resetEditor();
    setError("");
    setNotice("");
    setEditorOpen(true);
  };

  const editAlias = async (entry) => {
    setBusyAlias(entry.alias);
    setError("");
    setNotice("");
    try {
      const context = await fetchAliasEditContext(entry);
      setEditingEntry(entry);
      setEditingSource(context.source);
      setEditingRevision(context.revision);
      setInitialEffort(context.effort ?? "");
      setInitialFast(context.fast);
      setEditorOpen(true);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusyAlias("");
    }
  };

  const confirmDelete = async (entry) => {
    setBusyAlias(entry.alias);
    setError("");
    setNotice("");
    try {
      const next = await submitDeleteAlias(entry);
      setNotice(copy("proxy.alias.deleted", { alias: entry.alias }));
      setState((current) => (current ? { ...current, ...next } : current));
      setDeleteEntry(null);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusyAlias("");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.alias.subtitle")}</p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-oai-gray-400">{entries.length}</span>
          <Button size="sm" onClick={addAlias} disabled={loading || Boolean(busyAlias)}>
            <Plus className="h-4 w-4" />
            {copy("proxy.alias.create")}
          </Button>
        </div>
      </div>

      <AliasNotice message={error} onDismiss={() => setError("")} />
      <AliasNotice message={!error ? notice : ""} tone="success" onDismiss={() => setNotice("")} />

      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-oai-gray-200 px-5 py-10 text-sm text-oai-gray-400 dark:border-oai-gray-800">
          <LoaderCircle className="h-5 w-5 animate-spin" />
          {copy("proxy.alias.loadingConfig")}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-oai-gray-200 px-5 py-10 text-center dark:border-oai-gray-800">
          <GitFork className="mx-auto h-8 w-8 text-oai-gray-300 dark:text-oai-gray-600" />
          <p className="mt-3 text-sm font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.alias.empty.title")}</p>
          <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.alias.empty.description")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li
              key={[
                entry.kind,
                entry.section ?? "oauth",
                entry.providerIndex ?? "",
                entry.modelIndex ?? "",
                entry.oauthChannel ?? "",
                entry.provider,
                entry.sourceModel,
                entry.alias,
              ].join(":")}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-oai-gray-200 bg-white px-3.5 py-3 dark:border-oai-gray-800 dark:bg-oai-gray-900"
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <div className="min-w-0">
                  <span className="block truncate font-mono text-xs" title={entry.sourceModel}>{entry.sourceModel}</span>
                  <small className="flex gap-1.5 text-[11px] text-oai-gray-400 dark:text-oai-gray-500">
                    <em className="not-italic">{thinkingAliasSourceKindLabel(entry.kind)}</em>
                    <span title={thinkingAliasProviderDetail(entry.kind, entry.provider)}>
                      {thinkingAliasProviderDetail(entry.kind, entry.provider)}
                    </span>
                  </small>
                </div>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-oai-gray-400" />
                <strong className="min-w-0 truncate font-mono text-sm text-oai-brand-700 dark:text-oai-brand-300" title={entry.alias}>
                  {entry.alias}
                </strong>
              </div>
              <div className="flex items-center gap-1.5">
                {entry.effort ? (
                  <span className="rounded bg-oai-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-300">
                    {entry.effort}
                  </span>
                ) : null}
                {entry.serviceTier ? (
                  <span className="flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                    <Zap className="h-2.5 w-2.5" />
                    {copy("proxy.alias.fast.title")}
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={loading || Boolean(busyAlias)}
                  onClick={() => void editAlias(entry)}
                  title={copy("proxy.upstream.common.edit")}
                  aria-label={copy("proxy.upstream.common.edit")}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-black disabled:opacity-50 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteEntry(entry)}
                  disabled={Boolean(busyAlias)}
                  title={copy("proxy.alias.delete", { alias: entry.alias })}
                  aria-label={copy("proxy.alias.delete", { alias: entry.alias })}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-oai-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                >
                  {busyAlias === entry.alias
                    ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editorOpen ? (
        <AliasEditorDialog
          editor={{
            sources,
            entries,
            editingEntry,
            editingSource,
            editingRevision,
            initialEffort,
            initialFast,
          }}
          onClose={() => {
            setEditorOpen(false);
            resetEditor();
          }}
          onSaved={(nextState) => {
            setState((current) => (current ? { ...current, ...nextState } : current));
            setEditorOpen(false);
            resetEditor();
          }}
        />
      ) : null}

      <ConfirmModal
        open={deleteEntry !== null}
        title={copy("proxy.upstream.common.delete")}
        description={copy("proxy.alias.deleteConfirm", { alias: deleteEntry?.alias ?? "" })}
        confirmLabel={copy("proxy.upstream.common.delete")}
        destructive
        busy={Boolean(busyAlias)}
        onConfirm={() => void confirmDelete(deleteEntry)}
        onCancel={() => setDeleteEntry(null)}
      />
    </div>
  );
}
