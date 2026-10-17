import React from "react";
import { copy } from "../lib/copy";

export function CodexCatalogOptions({ meta, onChange }) {
  const models = [...new Set((meta.codexCatalogModels || []).map(row => {
    return String(row.model || "").trim();
  }).filter(Boolean))];
  const reviewer = String(meta.codexAutoReviewModel || "");
  return <div className="space-y-3">
    <label className="block space-y-1 text-sm">
      <span>{copy("pswitch.catalog.auto_review")}</span>
      <select value={reviewer} onChange={event => onChange("codexAutoReviewModel", event.target.value || undefined)} className="w-full rounded-lg border border-oai-gray-300 bg-transparent px-3 py-2 dark:border-oai-gray-700">
        <option value="">{copy("pswitch.catalog.auto_review_default")}</option>
        {reviewer && !models.includes(reviewer) ? <option value={reviewer} disabled>{reviewer}</option> : null}
        {models.map(model => <option key={model} value={model}>{model}</option>)}
      </select>
    </label>
    <p className="text-xs text-oai-gray-500">{copy(reviewer && !models.includes(reviewer) ? "pswitch.catalog.auto_review_missing" : "pswitch.catalog.auto_review_hint")}</p>
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={meta.codexSpeedTiersEnabled !== false} onChange={event => onChange("codexSpeedTiersEnabled", event.target.checked)} />
      {copy("pswitch.catalog.speed_tiers")}
    </label>
    <p className="text-xs text-oai-gray-500">{copy("pswitch.catalog.speed_tiers_hint")}</p>
  </div>;
}
