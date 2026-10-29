import React from "react";
import { copy } from "../lib/copy";
import { ModelDropdown } from "./provider-model-dropdown";

const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export function CodexSubagentFields({ agents = {}, models = [], onChange, onAddModel }) {
  const model = String(agents.default_subagent_model || "");
  const missing = model.trim() && models.length > 0 && !models.some(row => String(row.model || "").trim() === model.trim());
  const change = (key, value) => {
    const next = { ...agents };
    if (value.trim()) next[key] = value;
    else delete next[key];
    onChange(next);
  };
  return <div className="space-y-2">
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-sm">
        <span>{copy("pswitch.subagent.model")}</span>
        <div className="flex gap-1">
          <input value={model} onChange={event => change("default_subagent_model", event.target.value)} placeholder={copy("pswitch.subagent.inherit")} className="min-w-0 w-full rounded-lg border border-oai-gray-300 bg-transparent px-3 py-2 font-mono dark:border-oai-gray-700" />
          <ModelDropdown models={[...new Set(models.map(row => String(row.model || "").trim()).filter(Boolean))]} onSelect={value => change("default_subagent_model", value)} />
        </div>
      </label>
      <label className="space-y-1 text-sm">
        <span>{copy("pswitch.subagent.effort")}</span>
        <select value={agents.default_subagent_reasoning_effort || ""} onChange={event => change("default_subagent_reasoning_effort", event.target.value)} className="w-full rounded-lg border border-oai-gray-300 bg-transparent px-3 py-2 dark:border-oai-gray-700">
          <option value="">{copy("pswitch.subagent.inherit")}</option>
          {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </label>
    </div>
    <p className="text-xs text-oai-gray-500">{copy("pswitch.subagent.hint")}</p>
    {missing ? <p className="flex flex-wrap items-center gap-2 text-xs text-oai-gray-500">
      {copy("pswitch.subagent.missing")}
      <button type="button" onClick={() => onAddModel(model.trim())} className="text-oai-brand-600 hover:underline">{copy("pswitch.catalog.add_model")}</button>
    </p> : null}
  </div>;
}
