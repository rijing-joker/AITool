import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS as DndCss } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Check,
  Edit3,
  Feather,
  GripVertical,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  SquareTerminal,
  Trash2,
  Wallet,
  Waves,
  X,
  Zap,
} from "lucide-react";
import { copy } from "../lib/copy";
import {
  apiAccessRemarkLocatorFromRecord,
  apiAccessRemarkLocatorFromRow,
  applyProviderPreset,
  applyProviderRemarkIdentity,
  buildProviderGroupRecord,
  buildProviderRecord,
  checkProviderBalance,
  checkProviderModelHealth,
  checkProviderModelsHealth,
  createProviderDraft,
  definitionFor,
  draftFromRow,
  effectiveProviderKey,
  emptyProviderDraft,
  emptyRecords,
  exclusionsForModelSelection,
  fetchModels,
  hasDuplicateProviderRecord,
  managementApi,
  maskSecret,
  mergeModelOptions,
  mergeProviderHealthModels,
  modelsFromRecord,
  modelSearchText,
  modelSelectionForDiscovery,
  normalizeBaseUrl,
  normalizeProviderProxyUrl,
  parseProviderApiKeys,
  primaryProviderHealthCredential,
  parseProviderHeaders,
  PROVIDER_HEALTH_TIMEOUT_MS,
  providerCategoryMatchesRecord,
  providerDefinitions,
  providerDragId,
  providerGroupKeys,
  providerGroupStatus,
  providerGroupsApi,
  providerHealthIdentity,
  providerHeadersFromRecord,
  providerKeyDraft,
  providerLoadDefinitions,
  providerModelType,
  providerRecordWithDisabledState,
  providerRemarkIdentity,
  readBoolean,
  readString,
  reconcileModelSelection,
  requestErrorMessage,
  resolveApiAccessRemarks,
  resolveProviderRecordIndex,
  reorderProviderRecords,
  rowFromRecord,
  saveApiAccessRemark,
  sectionRecordsFromConfig,
  serializeProviderKey,
  stripResponseFields,
  validateProviderGroupKeys,
} from "../lib/easy-providers";
import { Button, Card, ConfirmModal } from "../ui/components";
import { showToast } from "../ui/components/Toast";
import { ProviderGroupKeysEditor } from "./provider-group-keys-editor";

// ---------------------------------------------------------------------------
// Upstreams tab (API 接入) — EasyCLIProxyAPI's provider management, ported
// interaction-for-interaction (categories, add/edit dialog fields, model
// discovery transfer dialog, health checks, remarks, drag ordering) and
// styled with the TokenTracker design language.
// ---------------------------------------------------------------------------

const CATEGORY_LABEL_KEYS = {
  "codex-api-key": "proxy.upstream.provider.codex",
  "openai-compatibility": "proxy.upstream.provider.openaiCompat",
  "deepseek": "proxy.upstream.provider.deepseek",
  "claude-api-key": "proxy.upstream.provider.claude",
  "gemini-api-key": "proxy.upstream.provider.gemini",
};

const CATEGORY_ICONS = {
  "codex-api-key": SquareTerminal,
  "openai-compatibility": Boxes,
  "deepseek": Waves,
  "claude-api-key": Feather,
  "gemini-api-key": Sparkles,
};

function UpstreamSwitch({ checked, onChange, disabled, title, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
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

function UpstreamNotice({ message, tone = "error", onDismiss }) {
  if (!message) return null;
  const isError = tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${
        isError
          ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          : "border-oai-gray-200 bg-oai-gray-50 text-oai-gray-700 dark:border-oai-gray-800 dark:bg-oai-gray-800/60 dark:text-oai-gray-300"
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

function UpstreamModal({ open, onClose, busy, title, subtitle, children, width = "max-w-2xl" }) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center p-4">
          <Dialog.Popup className={`flex max-h-[88vh] w-full ${width} flex-col overflow-hidden rounded-2xl bg-white shadow-[0_20px_60px_-20px_rgba(0,0,0,0.25)] ring-1 ring-oai-gray-200 transition-[opacity,transform] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] data-[ending-style]:translate-y-2 data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0 dark:bg-oai-gray-950 dark:shadow-[0_20px_60px_-10px_rgba(0,0,0,0.65)] dark:ring-oai-gray-800`}>
            <div className="flex items-start justify-between gap-3 border-b border-oai-gray-100 px-5 py-4 dark:border-oai-gray-800">
              <div className="min-w-0">
                <Dialog.Title className="text-base font-semibold text-oai-black dark:text-white">{title}</Dialog.Title>
                {subtitle ? (
                  <Dialog.Description className="mt-0.5 truncate text-sm text-oai-gray-500 dark:text-oai-gray-400">
                    {subtitle}
                  </Dialog.Description>
                ) : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="shrink-0 rounded-md p-1.5 text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-black disabled:opacity-50 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                aria-label={copy("proxy.upstream.common.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SortableUpstreamRow({ row, disabled, dragLabel, isDragOver, children }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: providerDragId(row),
    disabled,
    transition: {
      duration: 220,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    },
  });
  const style = {
    position: "relative",
    zIndex: isDragging ? 2 : undefined,
    transform: DndCss.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative flex items-center gap-3 rounded-xl border bg-white px-3 py-3 transition-colors dark:bg-oai-gray-900 ${
        isDragging
          ? "border-oai-brand-400 shadow-lg dark:border-oai-brand-500"
          : isDragOver
            ? "border-oai-brand-400 dark:border-oai-brand-500"
            : "border-oai-gray-200 dark:border-oai-gray-800"
      } ${row.disabled ? "opacity-60" : ""}`}
    >
      <button
        type="button"
        className="-ml-1 cursor-grab touch-none rounded-md p-1 text-oai-gray-300 transition-colors hover:bg-oai-gray-100 hover:text-oai-gray-500 active:cursor-grabbing disabled:opacity-40 dark:text-oai-gray-600 dark:hover:bg-oai-gray-800 dark:hover:text-oai-gray-300"
        disabled={disabled}
        aria-label={dragLabel}
        title={dragLabel}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      {children}
    </div>
  );
}

export function UpstreamsTab() {
  const [records, setRecords] = useState(emptyRecords);
  const [activeCategory, setActiveCategory] = useState("codex-api-key");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [dialogDraft, setDialogDraft] = useState(emptyProviderDraft);
  const [apiAccessRemarks, setApiAccessRemarks] = useState({});
  const [healthDialogRow, setHealthDialogRow] = useState(null);
  const [batchResults, setBatchResults] = useState({});
  const [batchProgress, setBatchProgress] = useState(null);
  const batchControllerRef = useRef(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const activeDefinition = definitionFor(activeCategory);
  const activeSection = activeDefinition.section;
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const loadProviders = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError("");
    try {
      const responses = await Promise.allSettled(
        providerLoadDefinitions.map(async (definition) => ({
          section: definition.section,
          records: await providerGroupsApi.get(definition.section),
        })),
      );
      const failures = [];
      const loaded = {};
      responses.forEach((result, index) => {
        const definition = providerLoadDefinitions[index];
        if (result.status === "fulfilled") loaded[result.value.section] = result.value.records;
        else failures.push(`${copy(CATEGORY_LABEL_KEYS[definition.id])}: ${String(result.reason)}`);
      });
      setRecords((current) => ({ ...current, ...loaded }));
      if (failures.length > 0) {
        setError(copy("proxy.upstream.error.partialLoad", { errors: failures.join("; ") }));
      }
    } catch (requestError) {
      setError(requestErrorMessage(requestError));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => () => batchControllerRef.current?.abort(), []);

  const allRows = useMemo(
    () =>
      Object.entries(records).flatMap(([section, items]) =>
        items.map((record, index) => rowFromRecord(section, record, index))),
    [records],
  );

  const runBatchHealth = useCallback(async () => {
    if (batchProgress?.running || allRows.length === 0) return;
    const controller = new AbortController();
    batchControllerRef.current = controller;
    setBatchResults({});
    setBatchProgress({ running: true, checked: 0, total: allRows.length });
    let checked = 0;
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < allRows.length && !controller.signal.aborted) {
        const row = allRows[nextIndex];
        nextIndex += 1;
        const identity = providerHealthIdentity(row);
        const model = row.models.find((option) => option.name?.trim())?.name ?? "";
        const key = primaryProviderHealthCredential(row.apiKeys);
        if (!key || !model) {
          setBatchResults((current) => ({
            ...current,
            [identity]: { status: "skipped", error: !key ? "no-key" : "no-model" },
          }));
        } else {
          setBatchResults((current) => ({ ...current, [identity]: { status: "checking" } }));
          const result = await checkProviderModelHealth({
            provider: providerModelType(row.section, row.record),
            baseUrl: row.baseUrl,
            apiKeys: row.apiKeys,
            authIndex: row.authIndex,
            customHeaders: providerHeadersFromRecord(row.record),
            timeoutMs: PROVIDER_HEALTH_TIMEOUT_MS,
          }, model);
          if (controller.signal.aborted) return;
          let balance = null;
          if (result.success && !controller.signal.aborted && row.section === "openai-compatibility") {
            balance = await checkProviderBalance(row.baseUrl, key);
          }
          if (controller.signal.aborted) return;
          setBatchResults((current) => ({
            ...current,
            [identity]: {
              status: result.success ? "healthy" : "failed",
              ...(result.firstTokenLatencyMs || result.responseLatencyMs
                ? { latencyMs: result.firstTokenLatencyMs ?? result.responseLatencyMs }
                : {}),
              error: result.error || "",
              ...(balance?.ok
                ? { balance: { remainingUsd: balance.remainingUsd ?? null, totalUsd: balance.totalUsd ?? null } }
                : {}),
            },
          }));
        }
        checked += 1;
        if (!controller.signal.aborted) {
          setBatchProgress((current) => (current ? { ...current, checked } : current));
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, allRows.length) }, () => worker()));
    } finally {
      if (!controller.signal.aborted) {
        setBatchProgress((current) => (current ? { ...current, running: false } : current));
      }
    }
  }, [allRows, batchProgress?.running]);

  useEffect(() => {
    const providerRows = Object.entries(records)
      .flatMap(([section, items]) => items.map((record, index) => rowFromRecord(section, record, index)));
    if (providerRows.length === 0) {
      setApiAccessRemarks({});
      return;
    }
    let disposed = false;
    void resolveApiAccessRemarks(providerRows.map((row) => ({
      providerSection: row.section,
      ...apiAccessRemarkLocatorFromRow(row),
    }))).then((remarks) => {
      if (disposed) return;
      setApiAccessRemarks(Object.fromEntries(providerRows.map((row, index) => [
        providerRemarkIdentity(row.section, apiAccessRemarkLocatorFromRow(row)),
        remarks[index] ?? "",
      ])));
    }).catch(() => {
      if (!disposed) setApiAccessRemarks({});
    });
    return () => {
      disposed = true;
    };
  }, [records]);

  const rows = useMemo(
    () =>
      records[activeSection]
        .map((record, index) => rowFromRecord(activeSection, record, index))
        .map((row) => ({
          ...row,
          name: activeCategory === "deepseek"
            ? copy("proxy.upstream.provider.deepseek")
            : row.name,
          remark: apiAccessRemarks[
            providerRemarkIdentity(row.section, apiAccessRemarkLocatorFromRow(row))
          ] ?? "",
        }))
        .filter((row) => providerCategoryMatchesRecord(activeCategory, row.record, activeSection))
        .filter((row) => {
          const query = filter.trim().toLowerCase();
          if (!query) return true;
          return [row.remark, row.name, ...row.apiKeys, row.baseUrl, row.models.map((model) => modelSearchText(model)).join(" ")]
            .join(" ")
            .toLowerCase()
            .includes(query);
        }),
    [activeCategory, activeSection, apiAccessRemarks, filter, records],
  );

  const openCreate = () => {
    setError("");
    setEditingRow(null);
    setDialogDraft({ ...createProviderDraft(activeCategory), groupKeys: [providerKeyDraft({ "api-key": "" })] });
    setDialogOpen(true);
  };

  const openEdit = (row) => {
    setError("");
    setEditingRow(row);
    setDialogDraft(draftFromRow(row));
    setDialogOpen(true);
  };

  const saveProvider = async (nextDraft, modelDiscoveryReady) => {
    const definition = activeDefinition;
    const preparedDraft = applyProviderRemarkIdentity(
      activeCategory,
      applyProviderPreset(activeCategory, nextDraft),
    );
    const grouped = Boolean(preparedDraft.groupKeys);
    const preparedDraftForSave = {
      ...preparedDraft,
      models: preparedDraft.models.filter((model) => model.name.trim()),
    };
    const baseUrlRequired = definition.openAi || definition.section === "codex-api-key";
    const remarkRequired = definition.openAi && activeCategory !== "deepseek" && !grouped;
    const parsedApiKeys = grouped
      ? (preparedDraft.groupKeys ?? []).map(({ value }) => readString(value, "api-key").trim())
      : parseProviderApiKeys(preparedDraft.apiKey);
    if (grouped) {
      const name = preparedDraft.name.trim();
      if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
        return { saved: false, target: "form", error: copy("proxy.upstream.groups.nameRequired") };
      }
      const invalidKey = validateProviderGroupKeys(preparedDraft.groupKeys ?? []);
      if (invalidKey) {
        return { saved: false, target: "form", error: copy("proxy.upstream.groups.invalidKey", { field: invalidKey }) };
      }
    }
    if (
      (grouped && parsedApiKeys.length === 0 && !editingRow && !definition.openAi)
      || (!grouped && parsedApiKeys.length === 0)
      || (remarkRequired && !preparedDraft.remark.trim())
      || (baseUrlRequired && !preparedDraft.baseUrl.trim())
    ) {
      return {
        saved: false,
        target: "form",
        error: definition.openAi
          ? copy("proxy.upstream.error.requiredAll")
          : baseUrlRequired
            ? copy("proxy.upstream.error.requiredBaseKey")
            : copy("proxy.upstream.error.requiredKey"),
      };
    }
    if (
      activeCategory === "deepseek"
      && (!modelDiscoveryReady || preparedDraftForSave.models.length === 0)
    ) {
      return {
        saved: false,
        target: "models",
        error: copy("proxy.upstream.error.fetchModelsBeforeSave"),
      };
    }
    if (Array.from(preparedDraft.remark.trim()).length > 80 || /[\u0000-\u001f\u007f]/.test(preparedDraft.remark)) {
      return { saved: false, target: "form", error: copy("proxy.upstream.error.remarkInvalid") };
    }
    let baseUrl = preparedDraft.baseUrl.trim();
    let proxyUrl = preparedDraft.proxyUrl ?? "";
    let providerHeaders = {};
    try {
      if (baseUrl) baseUrl = normalizeBaseUrl(baseUrl);
      if (preparedDraft.proxyUrlEdited !== false) {
        try {
          proxyUrl = normalizeProviderProxyUrl(proxyUrl);
        } catch {
          throw new Error(copy("proxy.upstream.error.proxyUrlInvalid"));
        }
      }
      if (baseUrlRequired && !baseUrl) {
        throw new Error(copy("proxy.upstream.error.baseRequired", { provider: copy(CATEGORY_LABEL_KEYS[activeCategory]) }));
      }
      providerHeaders = parseProviderHeaders(preparedDraft.headersText ?? "");
    } catch (requestError) {
      return { saved: false, target: "form", error: requestErrorMessage(requestError) };
    }
    setBusy(true);
    setError("");
    try {
      let draftToSave = { ...preparedDraftForSave, baseUrl, proxyUrl };
      if (
        definition.openAi
        && activeCategory !== "deepseek"
        && !editingRow
        && draftToSave.models.length === 0
      ) {
        let fetchedModels;
        try {
          const firstKey = grouped ? preparedDraft.groupKeys?.[0] : null;
          fetchedModels = await fetchModels(
            "openai",
            baseUrl,
            parsedApiKeys[0],
            grouped ? undefined : editingRow?.authIndex,
            firstKey
              ? providerHeadersFromRecord(effectiveProviderKey({ headers: providerHeaders }, serializeProviderKey(firstKey)))
              : providerHeaders,
          );
          if (fetchedModels.length === 0) {
            throw new Error(copy("proxy.upstream.error.noModels"));
          }
        } catch (requestError) {
          return {
            saved: false,
            target: "models",
            error: requestErrorMessage(requestError),
          };
        }
        draftToSave = applyProviderPreset(activeCategory, {
          ...draftToSave,
          models: fetchedModels,
        });
      }
      let current;
      if (grouped) {
        current = await providerGroupsApi.get(activeSection);
      } else {
        const latestConfig = await managementApi.get("/config");
        current = sectionRecordsFromConfig(latestConfig, activeSection);
      }
      let nextList;
      let targetIndex = -1;
      let currentRecord;

      if (editingRow) {
        targetIndex = resolveProviderRecordIndex(current, editingRow);
        if (targetIndex < 0) {
          throw new Error(copy("proxy.upstream.error.stale"));
        }
        currentRecord = current[targetIndex];
      }

      const recordsToSave = grouped
        ? [buildProviderGroupRecord(activeSection, draftToSave, currentRecord)]
        : definition.openAi
          ? [buildProviderRecord(activeSection, draftToSave, currentRecord)]
          : parsedApiKeys.map((apiKey) => buildProviderRecord(
            activeSection,
            { ...draftToSave, apiKey },
            currentRecord,
          ));
      if (hasDuplicateProviderRecord(activeSection, current, recordsToSave, targetIndex)) {
        throw new Error(copy("proxy.upstream.error.duplicate"));
      }
      nextList = editingRow
        ? [
          ...current.slice(0, targetIndex),
          ...recordsToSave,
          ...current.slice(targetIndex + 1),
        ]
        : [...current, ...recordsToSave];

      if (grouped) {
        await providerGroupsApi.put(activeSection, nextList.map(stripResponseFields));
      } else {
        await managementApi.put(`/${activeSection}`, nextList.map(stripResponseFields));
      }
      await saveApiAccessRemark({
        providerSection: activeSection,
        previousRecords: editingRow ? [apiAccessRemarkLocatorFromRow(editingRow)] : [],
        records: recordsToSave.map((record) => apiAccessRemarkLocatorFromRecord(activeSection, record)),
        allRecords: nextList.map((record) => apiAccessRemarkLocatorFromRecord(activeSection, record)),
        remark: draftToSave.remark,
      });
      showToast({ title: copy(editingRow ? "proxy.upstream.notice.updated" : "proxy.upstream.notice.added") });
      await loadProviders();
      return { saved: true };
    } catch (requestError) {
      return { saved: false, target: "form", error: requestErrorMessage(requestError) };
    } finally {
      setBusy(false);
    }
  };

  const deleteRow = async (row) => {
    setBusy(true);
    setError("");
    try {
      const current = await providerGroupsApi.get(row.section);
      const targetIndex = resolveProviderRecordIndex(current, row);
      if (targetIndex < 0) throw new Error(copy("proxy.upstream.error.stale"));
      const remainingRecords = current.filter((_, index) => index !== targetIndex).map(stripResponseFields);
      await providerGroupsApi.put(row.section, remainingRecords);
      await saveApiAccessRemark({
        providerSection: row.section,
        previousRecords: [apiAccessRemarkLocatorFromRow(row)],
        records: [],
        allRecords: remainingRecords.map((record) => apiAccessRemarkLocatorFromRecord(row.section, record)),
        remark: "",
      });
      showToast({ title: copy("proxy.upstream.notice.deleted") });
      await loadProviders();
    } catch (requestError) {
      showToast({ title: requestErrorMessage(requestError) });
    } finally {
      setBusy(false);
    }
  };

  const toggleProvider = async (row) => {
    setBusy(true);
    setError("");
    try {
      const latestRows = await providerGroupsApi.get(row.section);
      const targetIndex = resolveProviderRecordIndex(latestRows, row);
      if (targetIndex < 0) {
        throw new Error(copy("proxy.upstream.error.stale"));
      }
      const latestRecord = latestRows[targetIndex];
      const definition = definitionFor(row.section);
      const currentlyDisabled = definition.openAi
        ? readBoolean(latestRecord, "disabled")
        : Array.isArray(latestRecord["excluded-models"])
          && latestRecord["excluded-models"].some((model) => String(model).trim() === "*");
      if (definition.openAi) {
        await providerGroupsApi.put(row.section, latestRows.map((record, index) =>
          stripResponseFields(index === targetIndex ? { ...record, disabled: !currentlyDisabled } : record)));
      } else {
        const nextRecord = providerRecordWithDisabledState(
          row.section,
          latestRecord,
          !currentlyDisabled,
        );
        const nextRows = latestRows.map((record, index) =>
          index === targetIndex ? nextRecord : stripResponseFields(record));
        await providerGroupsApi.put(row.section, nextRows);
      }
      await loadProviders(false);
    } catch (requestError) {
      showToast({ title: requestErrorMessage(requestError) });
    } finally {
      setBusy(false);
    }
  };

  const reorderProviders = async (source, target) => {
    if (source.section !== target.section || source.index === target.index) return;
    setBusy(true);
    setError("");
    try {
      const latestRows = await providerGroupsApi.get(source.section);
      const nextRows = reorderProviderRecords(latestRows, rows, source, target);
      if (!nextRows) throw new Error(copy("proxy.upstream.error.stale"));
      await providerGroupsApi.put(source.section, nextRows);
      await loadProviders(false);
    } catch (requestError) {
      await loadProviders(false);
      showToast({ title: requestErrorMessage(requestError) });
    } finally {
      setDragOverId(null);
      setBusy(false);
    }
  };

  const handleDragEnd = (event) => {
    setDragOverId(null);
    const source = rows.find((row) => providerDragId(row) === String(event.active.id));
    const target = rows.find((row) => providerDragId(row) === String(event.over?.id ?? ""));
    if (!source || !target || source.index === target.index) return;

    const optimisticRows = reorderProviderRecords(
      records[source.section],
      rows,
      source,
      target,
    );
    if (optimisticRows) {
      setRecords((current) => ({ ...current, [source.section]: optimisticRows }));
    }
    void reorderProviders(source, target);
  };

  const countForDefinition = (definition) =>
    records[definition.section].filter((record) =>
      providerCategoryMatchesRecord(definition.id, record, definition.section)).length;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.upstreams.subtitle")}</p>

      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {providerDefinitions.map((definition) => {
              const Icon = CATEGORY_ICONS[definition.id];
              const active = definition.id === activeCategory;
              return (
                <button
                  type="button"
                  key={definition.id}
                  onClick={() => setActiveCategory(definition.id)}
                  disabled={busy}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-60 ${
                    active
                      ? "bg-oai-black text-white dark:bg-oai-white dark:text-oai-black"
                      : "text-oai-gray-500 hover:bg-oai-gray-100 hover:text-oai-black dark:hover:bg-oai-gray-800 dark:hover:text-white"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="max-w-[140px] truncate">{copy(CATEGORY_LABEL_KEYS[definition.id])}</span>
                  <span className={`rounded-full px-1.5 text-xs tabular-nums ${
                    active ? "bg-white/20 dark:bg-black/20" : "bg-oai-gray-100 dark:bg-oai-gray-800"
                  }`}>
                    {countForDefinition(definition)}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-oai-gray-400" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.currentTarget.value)}
                placeholder={copy("proxy.upstream.search")}
                className="h-9 w-52 rounded-md border border-oai-gray-300 bg-oai-white pl-8 pr-3 text-sm text-oai-black placeholder-oai-gray-400 focus:border-oai-brand focus:outline-none focus:ring-1 focus:ring-oai-brand/30 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-white"
              />
            </div>
            <Button variant="secondary" size="sm" onClick={() => void loadProviders()} disabled={loading || busy}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {copy("proxy.upstream.common.refresh")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void runBatchHealth()}
              disabled={loading || busy || Boolean(batchProgress?.running)}
            >
              {batchProgress?.running
                ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                : <Zap className="h-4 w-4" />}
              {batchProgress?.running
                ? copy("proxy.upstream.batch.progress", { checked: batchProgress.checked, total: batchProgress.total })
                : copy("proxy.upstream.batch.action")}
            </Button>
            <Button size="sm" onClick={openCreate} disabled={loading || busy}>
              <Plus className="h-4 w-4" />
              {copy("proxy.upstream.add")}
            </Button>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-oai-gray-400 dark:text-oai-gray-500">
          <span>{copy("proxy.upstream.groups.summary", { count: rows.length })}</span>
          <span>{copy("proxy.upstream.dragHint")}</span>
        </div>

        {error ? <div className="mt-3"><UpstreamNotice message={error} onDismiss={() => setError("")} /></div> : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-oai-gray-500 dark:text-oai-gray-400">
            <LoaderCircle className="h-5 w-5 animate-spin" />
            {copy("proxy.upstream.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-12 text-center">
            <Search className="h-6 w-6 text-oai-gray-300 dark:text-oai-gray-600" />
            <strong className="text-sm font-medium text-oai-gray-600 dark:text-oai-gray-300">
              {filter ? copy("proxy.upstream.empty.filtered") : copy("proxy.upstream.empty.none")}
            </strong>
            <span className="text-xs text-oai-gray-400 dark:text-oai-gray-500">
              {filter ? copy("proxy.upstream.empty.tryKeyword") : copy("proxy.upstream.empty.addFirst")}
            </span>
          </div>
        ) : (
          <DndContext
            sensors={dragSensors}
            collisionDetection={closestCenter}
            onDragStart={() => setError("")}
            onDragOver={({ over }) => setDragOverId(over ? String(over.id) : null)}
            onDragCancel={() => setDragOverId(null)}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={rows.map(providerDragId)}
              strategy={verticalListSortingStrategy}
            >
              <div className="mt-3 flex flex-col gap-2">
                {rows.map((row) => {
                  const ProviderIcon = CATEGORY_ICONS[row.section] ?? Boxes;
                  const isPartial = providerGroupStatus(row.record) === "partial";
                  const manyKeys = row.apiKeys.length > 1;
                  const sharedToggleOn = definitionFor(row.section).openAi
                    ? !row.record.disabled
                    : !(Array.isArray(row.record["excluded-models"]) && row.record["excluded-models"].includes("*"));
                  return (
                    <SortableUpstreamRow
                      key={providerDragId(row)}
                      row={row}
                      disabled={busy || rows.length < 2}
                      dragLabel={copy("proxy.upstream.dragHandle", { remark: row.remark || row.name })}
                      isDragOver={dragOverId === providerDragId(row)}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <ProviderIcon className="h-4 w-4 shrink-0 text-oai-gray-400" />
                          <strong className="min-w-0 truncate text-sm font-medium text-oai-black dark:text-white" title={row.name}>
                            {row.name}
                          </strong>
                          {row.remark ? (
                            <span className="shrink-0 max-w-40 truncate text-xs text-oai-gray-500 dark:text-oai-gray-400" title={row.remark}>
                              {row.remark}
                            </span>
                          ) : null}
                          {row.priority !== null ? (
                            <span className="shrink-0 rounded-full bg-oai-gray-100 px-2 py-0.5 text-xs tabular-nums text-oai-gray-500 dark:bg-oai-gray-800 dark:text-oai-gray-400">
                              {copy("proxy.upstream.priorityValue", { priority: row.priority })}
                            </span>
                          ) : null}
                          {row.disabled ? (
                            <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                              {copy("proxy.upstream.status.disabled")}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-1 flex min-w-0 items-center gap-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
                          <code className="shrink-0 font-mono" title={copy("proxy.upstream.keys.count", { count: row.apiKeys.length })}>
                            {manyKeys
                              ? copy("proxy.upstream.keys.summary", { key: maskSecret(row.apiKey), count: row.apiKeys.length })
                              : maskSecret(row.apiKey)}
                          </code>
                          <span className="min-w-0 truncate" title={row.baseUrl || undefined}>
                            {row.baseUrl || copy("proxy.upstream.defaultUrl")}
                          </span>
                          {row.authIndex ? (
                            <span className="shrink-0 max-w-48 truncate font-mono" title={row.authIndex}>
                              {copy("proxy.upstream.authIndex", { id: row.authIndex })}
                            </span>
                          ) : null}
                          {row.models.length > 0 ? (
                            <span className="shrink-0">{copy("proxy.upstream.models.summary", { count: row.models.length })}</span>
                          ) : null}
                          {(() => {
                            const result = batchResults[providerHealthIdentity(row)];
                            if (!result || result.status === "checking") return null;
                            if (result.status === "skipped") {
                              return (
                                <span
                                  className="shrink-0 rounded-full bg-oai-gray-100 px-2 py-0.5 text-xs text-oai-gray-400 dark:bg-oai-gray-800 dark:text-oai-gray-500"
                                  title={result.error === "no-key"
                                    ? copy("proxy.upstream.batch.skip_no_key")
                                    : copy("proxy.upstream.batch.skip_no_model")}
                                >
                                  {copy("proxy.upstream.batch.skipped")}
                                </span>
                              );
                            }
                            const healthy = result.status === "healthy";
                            return (
                              <span
                                className={`shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums ${
                                  healthy
                                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                                    : "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400"
                                }`}
                                title={result.error || undefined}
                              >
                                {healthy && result.latencyMs
                                  ? copy("proxy.upstream.batch.healthy", { latency: result.latencyMs })
                                  : healthy
                                    ? copy("proxy.upstream.batch.healthy_short")
                                    : copy("proxy.upstream.batch.failed")}
                              </span>
                            );
                          })()}
                          {batchResults[providerHealthIdentity(row)]?.balance ? (
                            <span
                              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-oai-brand-50 px-2 py-0.5 text-xs tabular-nums text-oai-brand-700 dark:bg-oai-brand-950/40 dark:text-oai-brand-300"
                              title={copy("proxy.upstream.balance.hint", {
                                remaining: batchResults[providerHealthIdentity(row)].balance.remainingUsd ?? "?",
                                total: batchResults[providerHealthIdentity(row)].balance.totalUsd ?? "?",
                              })}
                            >
                              <Wallet className="h-3 w-3" aria-hidden="true" />
                              {copy("proxy.upstream.balance.chip", {
                                value: batchResults[providerHealthIdentity(row)].balance.remainingUsd ?? "?",
                              })}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setHealthDialogRow(row)}
                          disabled={busy}
                        >
                          <Zap className="h-3.5 w-3.5" />
                          {copy("proxy.upstream.health.action")}
                        </Button>
                        <UpstreamSwitch
                          checked={sharedToggleOn}
                          onChange={() => void toggleProvider(row)}
                          disabled={busy}
                          title={copy("proxy.upstream.groups.sharedToggleHint")}
                          label={copy("proxy.upstream.toggleAria", {
                            remark: row.remark || row.name,
                            action: sharedToggleOn ? copy("proxy.upstream.common.disable") : copy("proxy.upstream.common.enable"),
                          })}
                        />
                        {isPartial ? (
                          <span className="shrink-0 rounded-full bg-oai-brand-50 px-2 py-0.5 text-xs font-medium text-oai-brand-700 dark:bg-oai-brand-950/40 dark:text-oai-brand-300">
                            {copy("proxy.upstream.groups.partial")}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => openEdit(row)}
                          disabled={busy}
                          title={copy("proxy.upstream.common.edit")}
                          aria-label={copy("proxy.upstream.common.edit")}
                          className="rounded-md p-1.5 text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-black disabled:opacity-50 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                        >
                          <Edit3 className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingDelete(row)}
                          disabled={busy}
                          title={copy("proxy.upstream.common.delete")}
                          aria-label={copy("proxy.upstream.common.delete")}
                          className="rounded-md p-1.5 text-oai-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </SortableUpstreamRow>
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </Card>

      {dialogOpen ? (
        <UpstreamFormDialog
          activeCategory={activeCategory}
          editingRow={editingRow}
          initialDraft={dialogDraft}
          busy={busy}
          onClose={() => setDialogOpen(false)}
          onSave={saveProvider}
        />
      ) : null}
      {healthDialogRow ? (
        <UpstreamGroupHealthDialog
          key={providerHealthIdentity(healthDialogRow)}
          row={healthDialogRow}
          onClose={() => setHealthDialogRow(null)}
        />
      ) : null}
      <ConfirmModal
        open={pendingDelete !== null}
        title={copy("proxy.upstream.common.delete")}
        description={pendingDelete
          ? copy("proxy.upstream.deleteConfirm", { remark: pendingDelete.remark || pendingDelete.name })
          : ""}
        confirmLabel={copy("proxy.upstream.common.delete")}
        cancelLabel={copy("proxy.upstream.common.cancel")}
        destructive
        busy={busy}
        onConfirm={() => {
          const row = pendingDelete;
          setPendingDelete(null);
          if (row) void deleteRow(row);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function UpstreamModelSelectionPanel({ models, selected, loading, onMove }) {
  const searchRef = useRef(null);
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const visibleModels = useMemo(() => models.filter((model) =>
    modelSearchText(model).includes(query)), [models, query]);
  const searchLabel = copy(selected ? "proxy.upstream.modelDialog.searchSelected" : "proxy.upstream.modelDialog.searchUnselected");

  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-lg border border-oai-gray-200 dark:border-oai-gray-800" aria-busy={loading}>
      <div className="flex items-center gap-2 border-b border-oai-gray-100 px-3 py-2 dark:border-oai-gray-800">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-oai-black dark:text-white">
          {copy(selected ? "proxy.upstream.modelDialog.selected" : "proxy.upstream.modelDialog.unselected")}
        </h3>
        <span className="shrink-0 text-xs tabular-nums text-oai-gray-400">
          {query ? `${visibleModels.length} / ${models.length}` : models.length}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onMove(visibleModels, !selected)}
          disabled={loading || visibleModels.length === 0}
        >
          {copy(selected
            ? query ? "proxy.upstream.modelDialog.removeResults" : "proxy.upstream.modelDialog.removeAll"
            : query ? "proxy.upstream.modelDialog.addResults" : "proxy.upstream.modelDialog.addAll")}
        </Button>
      </div>
      <div className="border-b border-oai-gray-100 px-3 py-2 dark:border-oai-gray-800">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-oai-gray-400" />
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
            className="h-8 w-full rounded-md border border-oai-gray-300 bg-oai-white pl-8 pr-7 text-sm text-oai-black placeholder-oai-gray-400 focus:border-oai-brand focus:outline-none focus:ring-1 focus:ring-oai-brand/30 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-white"
          />
          {search ? (
            <button
              type="button"
              onClick={() => { setSearch(""); searchRef.current?.focus(); }}
              aria-label={copy("proxy.upstream.modelDialog.clearSearch")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-oai-gray-400 hover:text-oai-black dark:hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="flex max-h-72 min-h-24 flex-1 flex-col overflow-y-auto p-1.5">
        {visibleModels.length ? visibleModels.map((model) => (
          <button
            type="button"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800"
            key={model.name}
            disabled={loading}
            aria-label={copy(selected ? "proxy.upstream.modelDialog.removeModel" : "proxy.upstream.modelDialog.addModel", { name: model.name })}
            onClick={() => onMove([model], !selected)}
          >
            <span className="min-w-0 flex-1">
              <strong className="block truncate font-mono text-xs font-medium text-oai-black dark:text-white" title={model.name}>{model.name}</strong>
              {model.alias || model.displayName ? (
                <small className="block truncate text-xs text-oai-gray-400" title={model.alias || model.displayName}>{model.alias || model.displayName}</small>
              ) : null}
            </span>
            {selected ? <X className="h-4 w-4 shrink-0 text-oai-gray-400" /> : <ArrowRight className="h-4 w-4 shrink-0 text-oai-gray-400" />}
          </button>
        )) : (
          <div className="flex flex-1 items-center justify-center px-3 text-center text-xs text-oai-gray-400">
            {copy(query
              ? "proxy.upstream.modelDialog.noMatch"
              : loading
                ? "proxy.upstream.modelDialog.fetching"
                : selected
                  ? "proxy.upstream.modelDialog.emptySelected"
                  : "proxy.upstream.modelDialog.emptyUnselected")}
          </div>
        )}
      </div>
    </section>
  );
}

// easy 36b98d2: the model-name field suggests the fetched upstream catalog and
// filters as you type (exact name, then display name, prefix, substring), while
// free text stays valid for upstreams the catalog does not know. Candidates are
// the discovered models only — the rows being edited feed back into themselves
// otherwise, so a custom name would always suggest itself.
export function ModelNameInput({ value, onChange, options, disabled, inputClass, placeholder }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef(null);
  const query = value.trim().toLowerCase();

  const matches = useMemo(() => {
    const scored = [];
    options.forEach((option, index) => {
      const name = option.name.toLowerCase();
      const extra = String(option.displayName ?? option.alias ?? "").toLowerCase();
      let score;
      if (!query) score = 10;
      else if (name === query) score = 0;
      else if (extra === query) score = 1;
      else if (name.startsWith(query)) score = 2;
      else if (extra.startsWith(query)) score = 3;
      else if (name.includes(query)) score = 4;
      else if (extra.includes(query)) score = 5;
      else return;
      scored.push({ option, index, score });
    });
    scored.sort((left, right) =>
      left.score - right.score
      || left.option.name.localeCompare(right.option.name, undefined, { sensitivity: "base" })
      || left.index - right.index);
    return scored.map((item) => item.option);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  useEffect(() => { setHighlight(0); }, [query]);

  const pick = (name) => {
    onChange(name);
    setOpen(false);
  };

  const listOpen = open && matches.length !== 0;
  return (
    <div className="relative min-w-0 flex-1" ref={rootRef}>
      <input
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (!listOpen) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setHighlight((current) => Math.min(current + 1, matches.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((current) => Math.max(current - 1, 0));
          } else if (event.key === "Enter") {
            // Enter accepts the highlighted suggestion, but when the typed
            // name is already the exact top match it must fall through so the
            // form still submits.
            const top = matches[0];
            if (!(highlight === 0 && top && top.name.toLowerCase() === query)) {
              event.preventDefault();
              pick(matches[Math.min(highlight, matches.length - 1)].name);
            }
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-expanded={listOpen}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        className={`${inputClass} font-mono`}
      />
      {listOpen ? (
        <ul
          role="listbox"
          aria-label={placeholder}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-oai-gray-200 bg-white py-1 shadow-xl dark:border-oai-gray-800 dark:bg-oai-gray-900"
        >
          {matches.map((option, position) => (
            <li key={option.name}>
              <button
                type="button"
                role="option"
                aria-selected={highlight === position}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(option.name);
                }}
                onMouseEnter={() => setHighlight(position)}
                className={`block w-full px-3 py-1.5 text-left transition-colors ${
                  highlight === position
                    ? "bg-oai-brand-50 dark:bg-oai-brand-950/40"
                    : "hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800"
                }`}
              >
                <span className="block truncate font-mono text-xs text-oai-gray-700 dark:text-oai-gray-200">{option.name}</span>
                {option.displayName || option.alias ? (
                  <span className="block truncate text-[10px] text-oai-gray-400" title={option.displayName || option.alias}>
                    {option.displayName || option.alias}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function UpstreamFormDialog({
  activeCategory,
  editingRow,
  initialDraft,
  busy,
  onClose,
  onSave,
}) {
  const definition = definitionFor(activeCategory);
  const activeSection = definition.section;
  const [draft, setDraft] = useState(initialDraft);
  const grouped = Boolean(draft.groupKeys);
  const [discoveryKeyId, setDiscoveryKeyId] = useState(initialDraft.groupKeys?.[0]?.id ?? "");
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const [formError, setFormError] = useState("");
  const [discoveredModels, setDiscoveredModels] = useState([]);
  const [modelDiscoveryOpen, setModelDiscoveryOpen] = useState(false);
  const [modelDiscoveryReady, setModelDiscoveryReady] = useState(
    () => activeCategory !== "deepseek"
      || Boolean(editingRow && initialDraft.models.some((model) => model.name.trim())),
  );
  const [thinkingLevelInput, setThinkingLevelInput] = useState("");
  const [selectedModelNames, setSelectedModelNames] = useState(
    () => new Set(mergeModelOptions(initialDraft.models).map((model) => model.name.toLowerCase())),
  );
  const modelCardRef = useRef(null);
  const discoverySelectionInitializedRef = useRef(false);
  const discoveryRequestRef = useRef(0);

  const closeModelDiscovery = useCallback(() => {
    discoveryRequestRef.current += 1;
    setModelLoading(false);
    setModelDiscoveryOpen(false);
  }, []);

  useEffect(() => () => { discoveryRequestRef.current += 1; }, []);

  const modelOptions = useMemo(
    () => mergeModelOptions(discoveredModels, draft.models),
    [discoveredModels, draft.models],
  );

  const configuredModels = useMemo(
    () => draft.models.filter((model) => model.name.trim()),
    [draft.models],
  );

  const selectedModels = useMemo(() => modelOptions.filter((model) =>
    selectedModelNames.has(model.name.toLowerCase())), [modelOptions, selectedModelNames]);
  const unselectedModels = useMemo(() => modelOptions.filter((model) =>
    !selectedModelNames.has(model.name.toLowerCase())), [modelOptions, selectedModelNames]);

  const updateTextField = (field, value) => {
    setFormError("");
    if (field === "apiKey" || field === "baseUrl" || field === "headersText") {
      discoveryRequestRef.current += 1;
      setModelLoading(false);
      setModelError("");
      if (activeCategory === "deepseek") setModelDiscoveryReady(false);
    }
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === "proxyUrl" ? { proxyUrlEdited: true, proxyUrlMixed: false } : {}),
      ...(field === "excludedModelsText" ? { modelSelectionCatalog: undefined } : {}),
    }));
  };

  const updateBooleanField = (field, value) => {
    setFormError("");
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const updateOptionalBooleanField = (field, value) => {
    setFormError("");
    setDraft((current) => ({ ...current, [field]: value === "" ? null : value === "true" }));
  };

  const updateModels = (update) => {
    setDraft((current) => {
      const models = update(current.models);
      return {
        ...current,
        models,
        excludedModelsText: current.modelSelectionCatalog && models.some((model) => model.name.trim())
          ? exclusionsForModelSelection(current.excludedModelsText ?? "", current.modelSelectionCatalog, models)
          : current.excludedModelsText,
      };
    });
  };

  const updateModel = (index, patch) => {
    updateModels((models) => models.map((model, modelIndex) =>
      modelIndex === index ? { ...model, ...patch } : model));
  };

  const addModel = () => {
    updateModels((models) => [...models, { name: "", alias: "" }]);
  };

  const removeModel = (index) => {
    updateModels((models) => models.filter((_, modelIndex) => modelIndex !== index));
  };

  const addThinkingLevel = () => {
    const level = thinkingLevelInput.trim().toLowerCase();
    if (!level) return;
    setDraft((current) => {
      const levels = current.thinkingLevels ?? [];
      if (levels.some((item) => item.toLowerCase() === level)) return current;
      return {
        ...current,
        thinkingLevels: [...levels, level],
        thinkingLevelsEdited: true,
      };
    });
    setThinkingLevelInput("");
  };

  const removeThinkingLevel = (level) => {
    setDraft((current) => ({
      ...current,
      thinkingLevels: (current.thinkingLevels ?? []).filter((item) => item !== level),
      thinkingLevelsEdited: true,
    }));
  };

  const discoverModels = async () => {
    const baseUrlRequired =
      activeSection === "codex-api-key" || activeSection === "openai-compatibility";
    if (baseUrlRequired && !draft.baseUrl.trim()) {
      setModelError(copy("proxy.upstream.error.enterBaseUrl"));
      return;
    }
    const requestId = ++discoveryRequestRef.current;
    setModelLoading(true);
    setModelError("");
    try {
      const provider = activeCategory === "deepseek"
        ? "deepseek"
        : definition.section === "gemini-api-key"
          ? "gemini"
          : definition.section === "claude-api-key"
            ? "claude"
            : definition.section === "codex-api-key"
              ? "codex"
              : "openai";
      const selectedKey = draft.groupKeys?.find((key) => key.id === discoveryKeyId) ?? draft.groupKeys?.[0];
      const connection = selectedKey
        ? effectiveProviderKey({ headers: parseProviderHeaders(draft.headersText ?? "") }, serializeProviderKey(selectedKey))
        : null;
      const modelApiKey = connection
        ? readString(connection, "api-key")
        : draft.apiKey.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? "";
      const fetchedModels = await fetchModels(
        provider,
        draft.baseUrl,
        modelApiKey,
        connection
          ? readString(selectedKey.value, "auth-index", "authIndex") || undefined
          : editingRow?.authIndex,
        connection
          ? providerHeadersFromRecord(connection)
          : parseProviderHeaders(draft.headersText ?? ""),
      );
      if (requestId !== discoveryRequestRef.current) return;
      const models = applyProviderPreset(
        activeCategory,
        { ...draft, models: fetchedModels },
      ).models;
      const initialized = discoverySelectionInitializedRef.current;
      setDiscoveredModels(models);
      setSelectedModelNames((current) =>
        initialized
          ? reconcileModelSelection(models, draft.models, current, "refresh")
          : modelSelectionForDiscovery(draft.models, models, draft.excludedModelsText ?? ""));
      discoverySelectionInitializedRef.current = true;
      if (activeCategory === "deepseek") setModelDiscoveryReady(true);
      if (!models.length) setModelError(copy("proxy.upstream.error.noAvailableModels"));
    } catch (requestError) {
      if (requestId === discoveryRequestRef.current) setModelError(requestErrorMessage(requestError));
    } finally {
      if (requestId === discoveryRequestRef.current) setModelLoading(false);
    }
  };

  const openModelDiscovery = () => {
    const baseUrlRequired =
      activeSection === "codex-api-key" || activeSection === "openai-compatibility";
    if (baseUrlRequired && !draft.baseUrl.trim()) {
      setModelError(copy("proxy.upstream.error.baseBeforeModels"));
      return;
    }
    discoverySelectionInitializedRef.current = false;
    setSelectedModelNames(modelSelectionForDiscovery(draft.models, discoveredModels, draft.excludedModelsText ?? ""));
    setModelDiscoveryOpen(true);
    void discoverModels();
  };

  const moveModels = (models, selected) => {
    discoverySelectionInitializedRef.current = true;
    setSelectedModelNames((current) => {
      const next = new Set(current);
      models.forEach((model) => {
        const key = model.name.toLowerCase();
        if (selected) next.add(key);
        else next.delete(key);
      });
      return next;
    });
  };

  const applyModelSelection = () => {
    if (modelLoading || selectedModels.length === 0) return;
    setDraft((current) => ({
      ...current,
      models: selectedModels,
      modelSelectionCatalog: activeSection === "openai-compatibility" ? undefined : discoveredModels,
      excludedModelsText: activeSection === "openai-compatibility"
        ? current.excludedModelsText
        : exclusionsForModelSelection(
            current.excludedModelsText ?? "",
            discoveredModels,
            selectedModels,
          ),
    }));
    closeModelDiscovery();
  };

  const submit = async (event) => {
    event.preventDefault();
    setFormError("");
    const result = await onSave(draft, modelDiscoveryReady);
    if (result.saved) {
      onClose();
      return;
    }
    if (result.target === "models") {
      setModelError(result.error);
      window.requestAnimationFrame(() => {
        modelCardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return;
    }
    setFormError(result.error);
  };

  const hasModelExclusions = activeSection !== "openai-compatibility"
    && Boolean(draft.excludedModelsText?.trim());
  const deepSeekModelsStale = activeCategory === "deepseek" && !modelDiscoveryReady;
  const modelSummaryTitle = configuredModels.length > 0
    ? copy("proxy.upstream.models.selected", { count: configuredModels.length })
    : activeCategory === "deepseek"
      ? copy("proxy.upstream.models.selectionRequired")
      : hasModelExclusions
        ? copy("proxy.upstream.models.restricted")
        : activeSection === "openai-compatibility"
          ? copy("proxy.upstream.models.autoAll")
          : copy("proxy.upstream.models.upstreamDefault");
  const modelSummaryDetail = configuredModels.length > 0
    ? deepSeekModelsStale
      ? copy("proxy.upstream.models.staleHint")
      : configuredModels.slice(0, 3).map((model) => model.name).join("、")
    : activeCategory === "deepseek"
      ? copy("proxy.upstream.models.selectionRequiredHint")
      : hasModelExclusions
        ? copy("proxy.upstream.models.hiddenHint")
        : activeSection === "openai-compatibility"
          ? copy("proxy.upstream.models.autoHint")
          : copy("proxy.upstream.models.allHint");

  const inputClass = "w-full rounded-md border border-oai-gray-300 bg-oai-white px-3 text-sm text-oai-black placeholder-oai-gray-400 transition-colors focus:border-oai-brand focus:outline-none focus:ring-1 focus:ring-oai-brand/30 disabled:cursor-not-allowed disabled:bg-oai-gray-50 disabled:text-oai-gray-400 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-white dark:placeholder-oai-gray-500 dark:disabled:bg-oai-gray-800";
  const fieldLabelClass = "mb-1.5 block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300";

  return (
    <>
      <UpstreamModal
        open
        busy={busy}
        onClose={onClose}
        title={copy(grouped
          ? editingRow ? "proxy.upstream.groups.edit" : "proxy.upstream.groups.add"
          : editingRow ? "proxy.upstream.dialog.edit" : "proxy.upstream.dialog.add")}
        subtitle={copy(CATEGORY_LABEL_KEYS[activeCategory])}
      >
        <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
            {grouped ? (
              <>
                <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.upstream.groups.description")}</p>
                <div>
                  <label htmlFor="upstream-group-name" className={fieldLabelClass}>{copy("proxy.upstream.groups.name")}</label>
                  <input
                    id="upstream-group-name"
                    autoFocus
                    value={draft.name}
                    maxLength={80}
                    onChange={(event) => updateTextField("name", event.currentTarget.value)}
                    placeholder={copy("proxy.upstream.groups.namePlaceholder")}
                    className={inputClass}
                  />
                </div>
              </>
            ) : null}
            <div>
              <label htmlFor="upstream-remark" className={fieldLabelClass}>{copy("proxy.upstream.field.remark")}</label>
              <input
                id="upstream-remark"
                autoFocus={!grouped && definition.openAi}
                value={draft.remark}
                maxLength={80}
                onChange={(event) => updateTextField("remark", event.currentTarget.value)}
                placeholder={copy("proxy.upstream.remarkPlaceholder")}
                className={inputClass}
              />
            </div>
            {grouped ? null : (
              <div>
                <label htmlFor="upstream-keys" className={fieldLabelClass}>{copy("proxy.upstream.field.keysMany")}</label>
                <textarea
                  id="upstream-keys"
                  autoFocus={!definition.openAi}
                  value={draft.apiKey}
                  onChange={(event) => updateTextField("apiKey", event.currentTarget.value)}
                  placeholder={"sk-...\nsk-..."}
                  rows={3}
                  className={`${inputClass} font-mono`}
                />
              </div>
            )}
            <div>
              <label htmlFor="upstream-baseurl" className={fieldLabelClass}>{copy("proxy.upstream.field.baseUrl")}</label>
              <input
                id="upstream-baseurl"
                value={draft.baseUrl}
                onChange={(event) => updateTextField("baseUrl", event.currentTarget.value)}
                placeholder={activeSection === "codex-api-key" || activeSection === "openai-compatibility"
                  ? copy("proxy.upstream.baseRequiredPlaceholder")
                  : copy("proxy.upstream.baseOptionalPlaceholder")}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="upstream-proxy" className={fieldLabelClass}>{copy("proxy.upstream.field.proxyUrl")}</label>
              <input
                id="upstream-proxy"
                value={draft.proxyUrl ?? ""}
                onChange={(event) => updateTextField("proxyUrl", event.currentTarget.value)}
                placeholder={draft.proxyUrlMixed ? copy("proxy.upstream.proxyMixed") : "socks5://127.0.0.1:1080"}
                className={inputClass}
              />
              {draft.proxyUrlMixed ? (
                <button
                  type="button"
                  className="mt-1.5 text-xs font-medium text-oai-brand-600 hover:underline dark:text-oai-brand-400"
                  onClick={() => updateTextField("proxyUrl", "")}
                >
                  {copy("proxy.upstream.proxyClear")}
                </button>
              ) : null}
            </div>
            {draft.groupKeys ? (
              <ProviderGroupKeysEditor
                keys={draft.groupKeys}
                section={activeSection}
                disabled={busy}
                shared={{
                  models: draft.models,
                  priority: draft.priority ? Number(draft.priority) : undefined,
                  prefix: draft.prefix,
                  "proxy-url": draft.proxyUrl,
                  "disable-cooling": draft.disableCooling,
                  "excluded-models": draft.excludedModelsText?.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
                  headers: (() => {
                    try {
                      return parseProviderHeaders(draft.headersText ?? "");
                    } catch {
                      return {};
                    }
                  })(),
                }}
                onChange={(groupKeys) => {
                  discoveryRequestRef.current += 1;
                  setModelLoading(false);
                  setModelError("");
                  setFormError("");
                  if (activeCategory === "deepseek") setModelDiscoveryReady(false);
                  setDraft((current) => ({ ...current, groupKeys }));
                }}
              />
            ) : null}
            {draft.groupKeys?.length ? (
              <div>
                <label htmlFor="upstream-discovery-key" className={fieldLabelClass}>{copy("proxy.upstream.groups.discoveryKey")}</label>
                <select
                  id="upstream-discovery-key"
                  value={draft.groupKeys.some((key) => key.id === discoveryKeyId) ? discoveryKeyId : draft.groupKeys[0].id}
                  onChange={(event) => {
                    discoveryRequestRef.current += 1;
                    setModelLoading(false);
                    setDiscoveryKeyId(event.currentTarget.value);
                  }}
                  className={inputClass}
                >
                  {draft.groupKeys.map((key, index) => (
                    <option key={key.id} value={key.id}>
                      {`${copy("proxy.upstream.groups.keyNumber", { number: index + 1 })} · ${maskSecret(readString(key.value, "api-key"))}`}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {grouped ? (
              <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.upstream.groups.sharedHint")}</p>
            ) : null}
            {activeCategory === "openai-compatibility" ? (
              <div className="rounded-lg border border-oai-gray-200 p-3 dark:border-oai-gray-800">
                <div className="flex items-baseline justify-between gap-2">
                  <strong className="text-sm font-medium text-oai-black dark:text-white">{copy("proxy.upstream.thinking.title")}</strong>
                  <span className="text-xs text-oai-gray-400">{copy("proxy.upstream.thinking.description")}</span>
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={thinkingLevelInput}
                    onChange={(event) => setThinkingLevelInput(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addThinkingLevel();
                      }
                    }}
                    placeholder={copy("proxy.upstream.thinking.placeholder")}
                    className={inputClass}
                  />
                  <Button type="button" variant="secondary" size="sm" onClick={addThinkingLevel} disabled={!thinkingLevelInput.trim()}>
                    <Plus className="h-3.5 w-3.5" />
                    {copy("proxy.upstream.thinking.add")}
                  </Button>
                </div>
                {(draft.thinkingLevels?.length ?? 0) > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {draft.thinkingLevels.map((level) => (
                      <span
                        key={level}
                        className="inline-flex items-center gap-1 rounded-full bg-oai-gray-100 px-2.5 py-1 text-xs text-oai-gray-700 dark:bg-oai-gray-800 dark:text-oai-gray-300"
                      >
                        {level}
                        <button
                          type="button"
                          onClick={() => removeThinkingLevel(level)}
                          title={copy("proxy.upstream.thinking.delete", { level })}
                          aria-label={copy("proxy.upstream.thinking.deleteAria", { level })}
                          className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <small className="mt-2 block text-xs text-oai-gray-400">{copy("proxy.upstream.thinking.empty")}</small>
                )}
              </div>
            ) : null}
            <div ref={modelCardRef} className="rounded-lg border border-oai-gray-200 p-3 dark:border-oai-gray-800">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-oai-black dark:text-white">{copy("proxy.upstream.models.title")}</span>
                  <small className="block text-xs text-oai-gray-400">{copy("proxy.upstream.models.description")}</small>
                </div>
                <Button type="button" variant="secondary" size="sm" onClick={openModelDiscovery} disabled={busy}>
                  <RefreshCw className={`h-3.5 w-3.5 ${modelLoading ? "animate-spin" : ""}`} />
                  {copy("proxy.upstream.models.fetch")}
                </Button>
              </div>
              <div className={`mt-2 rounded-md px-3 py-2 ${
                configuredModels.length || hasModelExclusions
                  ? "bg-oai-brand-50/60 dark:bg-oai-brand-950/20"
                  : "bg-oai-gray-50 dark:bg-oai-gray-800/60"
              }`}>
                <strong className="block text-xs font-medium text-oai-black dark:text-white">{modelSummaryTitle}</strong>
                <span className="block truncate text-xs text-oai-gray-500 dark:text-oai-gray-400">{modelSummaryDetail}</span>
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {draft.models.map((model, index) => (
                  <div className="flex items-center gap-2" key={index}>
                    <ModelNameInput
                      value={model.name}
                      onChange={(name) => updateModel(index, { name })}
                      options={discoveredModels}
                      disabled={busy}
                      inputClass={inputClass}
                      placeholder={copy("proxy.upstream.models.namePlaceholder")}
                    />
                    <input
                      value={model.alias ?? ""}
                      onChange={(event) => updateModel(index, { alias: event.currentTarget.value })}
                      placeholder={copy("proxy.upstream.models.aliasPlaceholder")}
                      aria-label={copy("proxy.upstream.models.aliasPlaceholder")}
                      disabled={busy}
                      className={`${inputClass} min-w-0 flex-1 font-mono`}
                    />
                    <button
                      type="button"
                      onClick={() => removeModel(index)}
                      disabled={busy}
                      title={copy("proxy.upstream.models.remove")}
                      aria-label={copy("proxy.upstream.models.remove")}
                      className="shrink-0 rounded-md p-2 text-oai-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="inline-flex w-fit items-center gap-1 rounded-md border border-dashed border-oai-gray-300 px-2.5 py-1.5 text-xs font-medium text-oai-gray-500 transition-colors hover:border-oai-brand hover:text-oai-brand disabled:opacity-50 dark:border-oai-gray-700 dark:text-oai-gray-400"
                  onClick={addModel}
                  disabled={busy}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {copy("proxy.upstream.models.add")}
                </button>
              </div>
              {modelError && !modelDiscoveryOpen ? (
                <div className="mt-2"><UpstreamNotice message={modelError} onDismiss={() => setModelError("")} /></div>
              ) : null}
            </div>
            <div>
              <label htmlFor="upstream-priority" className={fieldLabelClass}>{copy("proxy.upstream.field.priority")}</label>
              <input
                id="upstream-priority"
                type="number"
                step="1"
                value={draft.priority}
                onChange={(event) => updateTextField("priority", event.currentTarget.value)}
                className={inputClass}
              />
            </div>
            <details className="rounded-lg border border-oai-gray-200 px-3 py-2 dark:border-oai-gray-800">
              <summary className="cursor-pointer select-none text-sm font-medium text-oai-gray-600 dark:text-oai-gray-300">
                {copy("proxy.upstream.advanced")}
              </summary>
              <div className="mt-3 flex flex-col gap-4">
                <div>
                  <label htmlFor="upstream-prefix" className={fieldLabelClass}>{copy("proxy.upstream.field.prefix")}</label>
                  <input
                    id="upstream-prefix"
                    value={draft.prefix ?? ""}
                    onChange={(event) => updateTextField("prefix", event.currentTarget.value)}
                    placeholder={copy("proxy.upstream.prefixPlaceholder")}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="upstream-headers" className={fieldLabelClass}>{copy("proxy.upstream.field.headers")}</label>
                  <textarea
                    id="upstream-headers"
                    value={draft.headersText ?? ""}
                    onChange={(event) => updateTextField("headersText", event.currentTarget.value)}
                    rows={3}
                    placeholder={"X-Team: production\nAuthorization: Bearer ..."}
                    className={`${inputClass} font-mono`}
                  />
                </div>
                {activeSection !== "openai-compatibility" ? (
                  <div>
                    <label htmlFor="upstream-excluded" className={fieldLabelClass}>{copy("proxy.upstream.field.excludedModels")}</label>
                    <textarea
                      id="upstream-excluded"
                      value={draft.excludedModelsText ?? ""}
                      onChange={(event) => updateTextField("excludedModelsText", event.currentTarget.value)}
                      rows={3}
                      placeholder={"model-old-*\nmodel-preview"}
                      className={`${inputClass} font-mono`}
                    />
                  </div>
                ) : null}
                {activeSection === "claude-api-key" ? (
                  <div className="flex flex-col gap-4">
                    <div>
                      <label htmlFor="upstream-cloak-mode" className={fieldLabelClass}>{copy("proxy.upstream.cloak.mode")}</label>
                      <select
                        id="upstream-cloak-mode"
                        value={draft.cloakMode ?? ""}
                        onChange={(event) => updateTextField("cloakMode", event.currentTarget.value)}
                        className={inputClass}
                      >
                        <option value="">{copy("proxy.upstream.cloak.default")}</option>
                        <option value="auto">{copy("proxy.upstream.cloak.auto")}</option>
                        <option value="always">{copy("proxy.upstream.cloak.always")}</option>
                        <option value="never">{copy("proxy.upstream.cloak.never")}</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="upstream-cloak-words" className={fieldLabelClass}>{copy("proxy.upstream.cloak.words")}</label>
                      <textarea
                        id="upstream-cloak-words"
                        value={draft.cloakSensitiveWordsText ?? ""}
                        onChange={(event) => updateTextField("cloakSensitiveWordsText", event.currentTarget.value)}
                        rows={3}
                        placeholder={"internal-name\nworkspace-id"}
                        className={`${inputClass} font-mono`}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <strong className="block text-sm font-medium text-oai-black dark:text-white">{copy("proxy.upstream.cloak.strict")}</strong>
                        <span className="block text-xs text-oai-gray-400">{copy("proxy.upstream.cloak.strictDescription")}</span>
                      </div>
                      <UpstreamSwitch
                        checked={Boolean(draft.cloakStrictMode)}
                        onChange={(checked) => updateBooleanField("cloakStrictMode", checked)}
                        title={copy("proxy.upstream.cloak.enableStrict")}
                        label={copy("proxy.upstream.cloak.enableStrict")}
                      />
                    </div>
                    <div>
                      <label htmlFor="upstream-cloak-cache-user" className={fieldLabelClass}>{copy("proxy.upstream.cloak.cacheUser")}</label>
                      <select
                        id="upstream-cloak-cache-user"
                        aria-label={copy("proxy.upstream.cloak.cacheUser")}
                        value={draft.cloakCacheUserId == null ? "" : String(draft.cloakCacheUserId)}
                        onChange={(event) => updateOptionalBooleanField("cloakCacheUserId", event.currentTarget.value)}
                        className={inputClass}
                      >
                        <option value="">{copy("proxy.upstream.option.inherit")}</option>
                        <option value="true">{copy("proxy.upstream.common.enabled")}</option>
                        <option value="false">{copy("proxy.upstream.common.disabled")}</option>
                      </select>
                      <span className="mt-1 block text-xs text-oai-gray-400">{copy("proxy.upstream.cloak.cacheUserDescription")}</span>
                    </div>
                  </div>
                ) : null}
                {activeSection === "codex-api-key" ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <strong className="block text-sm font-medium text-oai-black dark:text-white">WebSocket</strong>
                      <span className="block text-xs text-oai-gray-400">{copy("proxy.upstream.websocket.description")}</span>
                    </div>
                    <UpstreamSwitch
                      checked={Boolean(draft.websockets)}
                      onChange={(checked) => updateBooleanField("websockets", checked)}
                      title={copy("proxy.upstream.websocket.enable")}
                      label={copy("proxy.upstream.websocket.enable")}
                    />
                  </div>
                ) : null}
                <div>
                  <label htmlFor="upstream-cooling" className={fieldLabelClass}>{copy("proxy.upstream.cooling.title")}</label>
                  <select
                    id="upstream-cooling"
                    aria-label={copy("proxy.upstream.cooling.title")}
                    value={draft.disableCooling == null ? "" : String(draft.disableCooling)}
                    onChange={(event) => updateOptionalBooleanField("disableCooling", event.currentTarget.value)}
                    className={inputClass}
                  >
                    <option value="">{copy("proxy.upstream.option.inherit")}</option>
                    <option value="true">{copy("proxy.upstream.cooling.disable")}</option>
                    <option value="false">{copy("proxy.upstream.cooling.enable")}</option>
                  </select>
                  <span className="mt-1 block text-xs text-oai-gray-400">{copy("proxy.upstream.cooling.description")}</span>
                </div>
              </div>
            </details>
            {formError ? <UpstreamNotice message={formError} onDismiss={() => setFormError("")} /> : null}
          </div>
          <div className="flex justify-end gap-2 border-t border-oai-gray-100 px-5 py-4 dark:border-oai-gray-800">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              {copy("proxy.upstream.common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? copy("proxy.upstream.common.saving") : copy("proxy.upstream.common.save")}
            </Button>
          </div>
        </form>
      </UpstreamModal>

      {modelDiscoveryOpen ? (
        <UpstreamModal
          open
          onClose={closeModelDiscovery}
          title={copy("proxy.upstream.modelDialog.title")}
          subtitle={copy(CATEGORY_LABEL_KEYS[activeCategory])}
          width="max-w-3xl"
        >
          <div className="flex flex-col gap-3 px-5 py-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-oai-gray-500 dark:text-oai-gray-400" role="status">
                {copy("proxy.upstream.modelDialog.summary", { found: modelOptions.length, selected: selectedModels.length })}
              </span>
              <Button type="button" variant="secondary" size="sm" onClick={() => void discoverModels()} disabled={modelLoading}>
                <RefreshCw className={`h-3.5 w-3.5 ${modelLoading ? "animate-spin" : ""}`} />
                {copy("proxy.upstream.common.refresh")}
              </Button>
            </div>
            {modelError ? (
              <UpstreamNotice message={modelError} onDismiss={() => setModelError("")} />
            ) : null}
            <div className="flex gap-3">
              <UpstreamModelSelectionPanel models={unselectedModels} selected={false} loading={modelLoading} onMove={moveModels} />
              <UpstreamModelSelectionPanel models={selectedModels} selected loading={modelLoading} onMove={moveModels} />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-oai-gray-100 px-5 py-4 dark:border-oai-gray-800">
            {selectedModels.length === 0 ? (
              <span className="text-xs text-oai-gray-400">{copy("proxy.upstream.modelDialog.chooseOne")}</span>
            ) : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={closeModelDiscovery}>
                {copy("proxy.upstream.common.cancel")}
              </Button>
              <Button type="button" onClick={applyModelSelection} disabled={modelLoading || selectedModels.length === 0}>
                {copy("proxy.upstream.modelDialog.apply", { count: selectedModels.length })}
              </Button>
            </div>
          </div>
        </UpstreamModal>
      ) : null}
    </>
  );
}

function UpstreamGroupHealthDialog({ row, onClose }) {
  const keys = providerGroupKeys(row.record);
  const [selected, setSelected] = useState(0);
  const key = keys[selected];
  const effectiveRow = useMemo(() => {
    if (!key) return row;
    const record = effectiveProviderKey(row.record, key);
    const keyApiKey = readString(key, "api-key");
    return {
      ...row,
      record,
      apiKey: keyApiKey,
      apiKeys: [keyApiKey],
      authIndex: readString(key, "auth-index", "authIndex"),
      models: modelsFromRecord(record.models),
    };
  }, [row, key]);
  const hasKeys = keys.length > 0;
  return (
    <UpstreamHealthDialog
      key={selected}
      row={effectiveRow}
      onClose={onClose}
      keySelector={hasKeys ? (
        <div>
          <label htmlFor="upstream-health-key" className="mb-1.5 block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300">
            {copy("proxy.upstream.groups.healthKey")}
          </label>
          <select
            id="upstream-health-key"
            value={selected}
            onChange={(event) => setSelected(Number(event.currentTarget.value))}
            className="h-9 w-full rounded-md border border-oai-gray-300 bg-oai-white px-3 text-sm text-oai-black focus:border-oai-brand focus:outline-none focus:ring-1 focus:ring-oai-brand/30 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-white"
          >
            {keys.map((entry, index) => (
              <option key={index} value={index}>
                {`${copy("proxy.upstream.groups.keyNumber", { number: index + 1 })} · ${maskSecret(readString(entry, "api-key"))}`}
              </option>
            ))}
          </select>
        </div>
      ) : undefined}
    />
  );
}

function UpstreamHealthDialog({ row, onClose, keySelector }) {
  const configuredModels = useMemo(
    () => mergeProviderHealthModels([], row.models),
    [row.models],
  );
  const [models, setModels] = useState(configuredModels);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState("");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState({});
  const [checkingAll, setCheckingAll] = useState(false);
  const healthControllerRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    healthControllerRef.current = controller;
    return () => controller.abort();
  }, []);

  const healthOptions = useMemo(() => ({
    provider: providerModelType(row.section, row.record),
    baseUrl: row.baseUrl,
    apiKeys: row.apiKeys,
    authIndex: row.authIndex,
    customHeaders: providerHeadersFromRecord(row.record),
    timeoutMs: PROVIDER_HEALTH_TIMEOUT_MS,
  }), [row]);

  useEffect(() => {
    let disposed = false;
    setModelLoading(true);
    setModelError("");
    void fetchModels(
      healthOptions.provider,
      healthOptions.baseUrl,
      row.apiKeys.find((key) => key.trim()) ?? "",
      healthOptions.authIndex,
      healthOptions.customHeaders,
      healthOptions.timeoutMs,
    ).then((discovered) => {
      if (!disposed) setModels(mergeProviderHealthModels(discovered, row.models));
    }).catch((requestError) => {
      if (!disposed) setModelError(String(requestError).replace(/^Error:\s*/i, ""));
    }).finally(() => {
      if (!disposed) setModelLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [healthOptions, row.apiKeys, row.models]);

  const visibleModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) => modelSearchText(model).includes(query));
  }, [models, search]);

  const resultValues = Object.values(results);
  const checkedCount = resultValues.filter((result) => result.status !== "checking").length;
  const healthyCount = resultValues.filter((result) => result.status === "healthy").length;
  const failedCount = resultValues.filter((result) => result.status === "failed").length;
  const hasCheckingModel = resultValues.some((result) => result.status === "checking");

  const saveResult = (result) => {
    setResults((current) => ({
      ...current,
      [result.model.toLowerCase()]: result,
    }));
  };

  const checkOneModel = async (model) => {
    const signal = healthControllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    const key = model.name.toLowerCase();
    setResults((current) => ({ ...current, [key]: { status: "checking" } }));
    const result = await checkProviderModelHealth(healthOptions, model.name);
    if (!signal.aborted) saveResult(result);
  };

  const checkAllModels = async () => {
    const signal = healthControllerRef.current?.signal;
    if (models.length === 0 || checkingAll || !signal || signal.aborted) return;
    setCheckingAll(true);
    setResults(Object.fromEntries(models.map((model) => [
      model.name.toLowerCase(),
      { status: "checking" },
    ])));
    try {
      await checkProviderModelsHealth(healthOptions, models, saveResult, undefined, signal);
    } finally {
      if (!signal.aborted) setCheckingAll(false);
    }
  };

  const statusLabel = (state) => {
    if (!state) return copy("proxy.upstream.health.notChecked");
    if (state.status === "checking") return copy("proxy.upstream.health.checking");
    return state.status === "healthy"
      ? copy("proxy.upstream.health.healthy")
      : copy("proxy.upstream.health.failed");
  };

  return (
    <UpstreamModal
      open
      onClose={onClose}
      title={copy("proxy.upstream.health.title")}
      subtitle={copy("proxy.upstream.health.description", { provider: row.remark || row.name })}
      width="max-w-2xl"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
        {keySelector}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-oai-gray-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={copy("proxy.upstream.health.search")}
            className="h-9 w-full rounded-md border border-oai-gray-300 bg-oai-white pl-8 pr-3 text-sm text-oai-black placeholder-oai-gray-400 focus:border-oai-brand focus:outline-none focus:ring-1 focus:ring-oai-brand/30 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-white"
          />
        </div>
        <div className="rounded-lg bg-oai-gray-50 px-3 py-2.5 text-xs dark:bg-oai-gray-800/60">
          <p className="text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.upstream.health.warning")}</p>
          <span className="mt-1 block font-medium tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
            {copy("proxy.upstream.health.summary", {
              checked: checkedCount,
              total: models.length,
              healthy: healthyCount,
              failed: failedCount,
            })}
          </span>
          {modelError ? (
            <div className="mt-2">
              <UpstreamNotice
                message={copy("proxy.upstream.health.modelLoadFailed", { error: modelError })}
                onDismiss={() => setModelError("")}
              />
            </div>
          ) : modelLoading ? (
            <small className="mt-1 block text-oai-gray-400">{copy("proxy.upstream.health.loadingModels")}</small>
          ) : null}
        </div>
        <div className="flex min-h-40 flex-1 flex-col gap-1.5 overflow-y-auto">
          {modelLoading && models.length === 0 ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-oai-gray-400">
              <LoaderCircle className="h-5 w-5 animate-spin" />
              {copy("proxy.upstream.health.loadingModels")}
            </div>
          ) : visibleModels.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-oai-gray-400">
              <strong>{models.length ? copy("proxy.upstream.health.noMatch") : copy("proxy.upstream.health.noModel")}</strong>
            </div>
          ) : visibleModels.map((model) => {
            const state = results[model.name.toLowerCase()];
            const checked = state && state.status !== "checking" ? state : null;
            const error = checked?.status === "failed"
              ? checked.errorCode === "missing-direct-key"
                ? copy("proxy.upstream.health.missingDirectKey")
                : checked.timedOut
                  ? copy("proxy.upstream.health.timeout")
                  : checked.error || copy("proxy.upstream.health.failed")
              : "";
            const latencyTitle = checked?.firstTokenLatencyMs !== undefined
              ? copy("proxy.upstream.health.firstTokenLatencyResult", { latency: checked.firstTokenLatencyMs })
              : checked?.responseLatencyMs !== undefined
                ? copy("proxy.upstream.health.responseLatencyResult", { latency: checked.responseLatencyMs })
                : error || undefined;
            const latencyInline = checked?.firstTokenLatencyMs !== undefined
              ? copy("proxy.upstream.health.firstTokenInline", { latency: checked.firstTokenLatencyMs })
              : checked?.responseLatencyMs !== undefined
                ? copy("proxy.upstream.health.responseInline", { latency: checked.responseLatencyMs })
                : "";
            return (
              <div
                className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                  checked?.status === "failed"
                    ? "border-red-200 dark:border-red-900"
                    : "border-oai-gray-200 dark:border-oai-gray-800"
                }`}
                key={model.name}
              >
                <div className="min-w-0 flex-1">
                  <strong className="block truncate font-mono text-xs font-medium text-oai-black dark:text-white" title={model.name}>{model.name}</strong>
                  {error ? (
                    <small className="block truncate text-xs text-red-600 dark:text-red-400" title={error}>{error}</small>
                  ) : model.alias || model.displayName ? (
                    <small className="block truncate text-xs text-oai-gray-400" title={model.alias || model.displayName}>{model.alias || model.displayName}</small>
                  ) : null}
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium tabular-nums ${
                    state?.status === "checking"
                      ? "bg-oai-gray-100 text-oai-gray-500 dark:bg-oai-gray-800 dark:text-oai-gray-400"
                      : checked?.status === "healthy"
                        ? "bg-oai-brand-50 text-oai-brand-700 dark:bg-oai-brand-950/40 dark:text-oai-brand-300"
                        : checked?.status === "failed"
                          ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                          : "bg-oai-gray-100 text-oai-gray-500 dark:bg-oai-gray-800 dark:text-oai-gray-400"
                  }`}
                  title={latencyTitle}
                >
                  {statusLabel(state)}
                  {latencyInline ? ` · ${latencyInline}` : ""}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void checkOneModel(model)}
                  disabled={modelLoading || checkingAll || state?.status === "checking"}
                >
                  {checked ? copy("proxy.upstream.health.retryOne") : copy("proxy.upstream.health.checkOne")}
                </Button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-oai-gray-100 px-5 py-4 dark:border-oai-gray-800">
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          {copy("proxy.upstream.common.close")}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void checkAllModels()}
          disabled={modelLoading || models.length === 0 || hasCheckingModel}
        >
          {checkingAll
            ? copy("proxy.upstream.health.checkingProgress", { checked: checkedCount, total: models.length })
            : copy("proxy.upstream.health.checkAll")}
        </Button>
      </div>
    </UpstreamModal>
  );
}
