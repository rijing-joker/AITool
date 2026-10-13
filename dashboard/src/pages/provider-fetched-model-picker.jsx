import React, { useState } from "react";
import { X } from "lucide-react";
import { copy } from "../lib/copy";
import { ModalFrame } from "../ui/components/ModalFrame";

export function modelMetadataForId(metadata, id) {
  const key = String(id ?? "").split("/").pop().split(":")[0].trim().replace(/@/g, "-").toLowerCase().replace(/\[1m\]$/, "").trim();
  return metadata?.[key] ?? null;
}

// cc-switch f7244745 / 644b7d5c: the dialog owns a draft selection. Only
// Apply edits the provider; refetches keep the draft and expose missing ids.
export function FetchedModelPicker({ fetchedModels, configuredIds, modelMetadata, fetchState, onFetch, onApply, onClose }) {
  const [selected, setSelected] = useState(() => new Set(configuredIds));
  const [search, setSearch] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const available = new Set(fetchedModels || []);
  const ids = [...new Set([...(fetchedModels || []), ...configuredIds, ...selected])];
  const visible = ids.filter(id => id.toLowerCase().includes(search.trim().toLowerCase()) && (!onlySelected || selected.has(id)));
  const changeMany = (values, checked) => setSelected(current => {
    const next = new Set(current);
    for (const id of values) { if (checked) next.add(id); else next.delete(id); }
    return next;
  });
  const groups = [true, false].map(present => ({ present, ids: visible.filter(id => available.has(id) === present) })).filter(function nonempty(group) { return group.ids.length; });
  return (
    <ModalFrame open onClose={onClose} label={copy("pswitch.catalog.choose")}>
      <div className="flex items-center justify-between border-b border-oai-gray-200 p-4 dark:border-oai-gray-800">
        <h2 className="font-semibold">{copy("pswitch.catalog.choose")}</h2>
        <button type="button" onClick={onClose} aria-label={copy("proxy.upstream.common.close")} className="rounded-md p-2"><X size={18} /></button>
      </div>
      <div className="space-y-3 border-b border-oai-gray-200 p-4 dark:border-oai-gray-800">
        <input value={search} onChange={event => setSearch(event.target.value)} aria-label={copy("pswitch.catalog.picker_search")} placeholder={copy("pswitch.catalog.picker_search")} className="w-full rounded-lg border border-oai-gray-300 bg-transparent px-3 py-2 dark:border-oai-gray-700" />
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <button type="button" onClick={() => changeMany(visible, true)}>{copy("pswitch.catalog.select_all")}</button>
          <button type="button" onClick={() => changeMany(visible, false)}>{copy("pswitch.catalog.select_none")}</button>
          <label className="flex items-center gap-2"><input type="checkbox" checked={onlySelected} onChange={event => setOnlySelected(event.target.checked)} />{copy("pswitch.catalog.only_selected")}</label>
          <button type="button" onClick={onFetch} disabled={fetchState === "loading"} className="ml-auto text-oai-brand-600 disabled:opacity-50">{copy(fetchState === "loading" ? "pswitch.models.fetching" : "pswitch.catalog.refetch")}</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {visible.length === 0 ? <p className="py-6 text-center text-sm text-oai-gray-500">{copy("pswitch.catalog.picker_empty")}</p> : null}
        {groups.map(({ present, ids: group }) => {
          return <div key={String(present)} className="mb-3 space-y-1">
            {!present ? <p className="py-2 text-xs text-oai-gray-500">{copy("pswitch.catalog.unavailable")}</p> : null}
            {group.map(id => {
              const metadata = modelMetadataForId(modelMetadata, id);
              return <label key={id} className="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-900">
                <input type="checkbox" checked={selected.has(id)} onChange={event => changeMany([id], event.target.checked)} aria-label={id} className="mt-1" />
                <span className="min-w-0 flex-1">
                  <span className="block break-all font-mono text-sm">{id}</span>
                  <span className="flex flex-wrap gap-x-3 text-xs text-oai-gray-500">
                    {0 < metadata?.contextWindow ? <span>{copy("pswitch.catalog.context_preview", { count: metadata.contextWindow })}</span> : null}
                    {metadata?.reasoning === true || metadata?.reasoningEfforts?.length ? <span>{copy("pswitch.catalog.reasoning_preview")}</span> : null}
                    {metadata?.inputModalities?.includes("image") ? <span>{copy("pswitch.catalog.image_preview")}</span> : null}
                  </span>
                </span>
              </label>;
            })}
          </div>;
        })}
      </div>
      <div className="flex items-center justify-between border-t border-oai-gray-200 p-4 text-sm dark:border-oai-gray-800">
        <span>{copy("pswitch.catalog.selected_count", { count: selected.size })}</span>
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-oai-gray-300 px-4 dark:border-oai-gray-700">{copy("shared.action.cancel")}</button>
          <button type="button" onClick={() => onApply([...selected])} className="min-h-10 rounded-lg bg-oai-brand-600 px-4 text-white">{copy("shared.action.apply")}</button>
        </div>
      </div>
    </ModalFrame>
  );
}
