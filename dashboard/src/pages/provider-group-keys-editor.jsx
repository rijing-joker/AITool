import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { copy } from "../lib/copy";
import {
  effectiveProviderKey,
  isRecord,
  maskSecret,
  providerKeyDraft,
  providerKeyOverrides,
  readString,
} from "../lib/easy-providers";

// Per-key editor inside the group dialog (EasyCLIProxyAPI's
// ProviderGroupKeysEditor). Each key carries its own api-key/weight and may
// override shared group fields; an unchecked override inherits the group
// value, a checked one replaces it (null/absent = inherit in v8).
const OVERRIDE_FIELDS = [
  { field: "priority", kind: "number", initial: 0 },
  { field: "proxy-url", kind: "text", initial: "" },
  { field: "prefix", kind: "text", initial: "" },
  { field: "request-retry", kind: "number", initial: 0 },
  { field: "disable-cooling", kind: "boolean", initial: false },
  { field: "headers", kind: "lines", initial: {} },
  { field: "excluded-models", kind: "lines", initial: [] },
];

const overrideFieldLabel = (field) => {
  switch (field) {
    case "priority":
      return copy("proxy.upstream.field.priority");
    case "proxy-url":
      return copy("proxy.upstream.field.proxyUrl");
    case "prefix":
      return copy("proxy.upstream.field.prefix");
    case "request-retry":
      return copy("proxy.upstream.groups.retry");
    case "disable-cooling":
      return copy("proxy.upstream.cooling.title");
    case "headers":
      return copy("proxy.upstream.field.headers");
    default:
      return copy("proxy.upstream.field.excludedModels");
  }
};

const inputClass = "w-full rounded-md border border-oai-gray-300 bg-oai-white px-3 text-sm text-oai-black placeholder-oai-gray-400 transition-colors focus:border-oai-brand focus:outline-none focus:ring-1 focus:ring-oai-brand/30 disabled:cursor-not-allowed disabled:bg-oai-gray-50 disabled:text-oai-gray-400 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-white dark:placeholder-oai-gray-500 dark:disabled:bg-oai-gray-800";
const labelClass = "block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300";

export function ProviderGroupKeysEditor({ keys, shared, section, disabled, onChange }) {
  const [visible, setVisible] = useState({});
  const update = (id, patch) => onChange(keys.map((draft) => (draft.id === id ? patch(draft) : draft)));
  const set = (id, field, value) => update(id, (draft) => {
    const next = { ...draft.value };
    if (value === undefined) delete next[field];
    else next[field] = value;
    const text = { ...draft.text };
    delete text[field];
    return { ...draft, value: next, text };
  });
  const setText = (id, field, value) => update(id, (draft) => ({ ...draft, text: { ...draft.text, [field]: value } }));
  const emptyKeys = keys.length === 0;
  return (
    <section aria-label={copy("proxy.upstream.groups.keys")} className="rounded-lg border border-oai-gray-200 p-3 dark:border-oai-gray-800">
      <div className="flex items-start justify-between gap-2">
        <div>
          <strong className="text-sm font-medium text-oai-black dark:text-white">{copy("proxy.upstream.groups.keys")}</strong>
          <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.upstream.groups.keysHint")}</p>
        </div>
      </div>
      {emptyKeys ? <p className="mt-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.upstream.groups.emptyKeys")}</p> : null}
      {keys.map((draft, index) => {
        const key = draft.value;
        const overrideCount = providerKeyOverrides(key).length;
        const effective = effectiveProviderKey(shared, key);
        const keyNumberLabel = copy("proxy.upstream.groups.keyNumber", { number: index + 1 });
        return (
          <fieldset key={draft.id} disabled={disabled} className="mt-3 rounded-md border border-oai-gray-200 p-3 dark:border-oai-gray-800">
            <legend className="px-1 text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{keyNumberLabel}</legend>
            <div className="flex items-end gap-2">
              <label className="min-w-0 flex-1">
                <span className={labelClass}>{copy("proxy.upstream.field.keysMany")}</span>
                <input
                  type={visible[draft.id] ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={keyNumberLabel}
                  value={readString(key, "api-key")}
                  onChange={(event) => set(draft.id, "api-key", event.currentTarget.value)}
                  placeholder="sk-..."
                  className={`${inputClass} font-mono`}
                />
              </label>
              <button
                type="button"
                aria-pressed={Boolean(visible[draft.id])}
                className="shrink-0 rounded-md border border-oai-gray-300 px-2 py-1.5 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-oai-gray-700 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800"
                onClick={() => setVisible((state) => ({ ...state, [draft.id]: !state[draft.id] }))}
              >
                {copy("proxy.upstream.groups.showKey")}
              </button>
              <button
                type="button"
                aria-label={copy("proxy.upstream.groups.removeKey", { number: index + 1 })}
                className="shrink-0 rounded-md p-1.5 text-oai-gray-400 transition-colors hover:bg-oai-red-50 hover:text-oai-red-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-oai-red-950"
                onClick={() => onChange(keys.filter((item) => item.id !== draft.id))}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-oai-gray-600 dark:text-oai-gray-400">
                {`${copy("proxy.upstream.groups.keySettings")} · ${overrideCount
                  ? copy("proxy.upstream.groups.overrides", { count: overrideCount })
                  : copy("proxy.upstream.groups.inherits")}`}
              </summary>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label>
                  <span className={labelClass}>{copy("proxy.upstream.groups.weight")}</span>
                  <input
                    type="number"
                    min="0"
                    max="1000000"
                    step="1"
                    placeholder="1"
                    value={key.weight == null ? "" : String(key.weight)}
                    onChange={(event) => set(draft.id, "weight", event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value))}
                    className={inputClass}
                  />
                </label>
              </div>
              <p className="mt-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.upstream.groups.overrideHint")}</p>
              <div className="mt-2 flex flex-col gap-2">
                {OVERRIDE_FIELDS.map(({ field, kind, initial }) => {
                  const overridden = key[field] != null;
                  const content = draft.text?.[field] ?? (field === "headers" && isRecord(key[field])
                    ? Object.entries(key[field]).map(([name, value]) => `${name}: ${value}`).join("\n")
                    : Array.isArray(key[field]) ? key[field].join("\n") : String(key[field] ?? ""));
                  return (
                    <div key={field} className="rounded-md border border-oai-gray-100 p-2 dark:border-oai-gray-800">
                      <label className="flex items-center gap-2 text-xs font-medium text-oai-gray-700 dark:text-oai-gray-300">
                        <input
                          type="checkbox"
                          checked={overridden}
                          onChange={(event) => set(draft.id, field, event.currentTarget.checked ? structuredClone(effective[field] ?? initial) : undefined)}
                        />
                        <span>{copy("proxy.upstream.groups.overrideField", { field: overrideFieldLabel(field) })}</span>
                      </label>
                      {overridden && kind === "lines" ? (
                        <textarea
                          aria-label={overrideFieldLabel(field)}
                          rows={3}
                          value={content}
                          onChange={(event) => setText(draft.id, field, event.currentTarget.value)}
                          className={`${inputClass} mt-1.5 font-mono text-xs`}
                        />
                      ) : null}
                      {overridden && kind === "boolean" ? (
                        <select
                          aria-label={overrideFieldLabel(field)}
                          value={String(key[field])}
                          onChange={(event) => set(draft.id, field, event.currentTarget.value === "true")}
                          className={`${inputClass} mt-1.5`}
                        >
                          <option value="false">{copy("proxy.upstream.cooling.enable")}</option>
                          <option value="true">{copy("proxy.upstream.cooling.disable")}</option>
                        </select>
                      ) : null}
                      {overridden && (kind === "number" || kind === "text") ? (
                        <input
                          aria-label={overrideFieldLabel(field)}
                          type={kind}
                          step={kind === "number" ? "1" : undefined}
                          value={String(key[field] ?? "")}
                          onChange={(event) => set(draft.id, field, kind === "number" ? Number(event.currentTarget.value) : event.currentTarget.value)}
                          className={`${inputClass} mt-1.5`}
                        />
                      ) : null}
                    </div>
                  );
                })}
                <div className="rounded-md border border-oai-gray-100 p-2 dark:border-oai-gray-800">
                  <label className="flex items-center gap-2 text-xs font-medium text-oai-gray-700 dark:text-oai-gray-300">
                    <input
                      type="checkbox"
                      checked={key.models != null}
                      onChange={(event) => set(draft.id, "models", event.currentTarget.checked ? structuredClone(effective.models ?? []) : undefined)}
                    />
                    <span>{copy("proxy.upstream.groups.overrideModels")}</span>
                  </label>
                  {Array.isArray(key.models) ? (
                    <div className="mt-2 flex flex-col gap-2">
                      {key.models.map((raw, modelIndex) => {
                        const model = isRecord(raw) ? raw : { name: String(raw) };
                        const change = (patch) => set(draft.id, "models", key.models.map((item, i) => (i === modelIndex ? { ...model, ...patch } : item)));
                        return (
                          <div key={modelIndex} className="flex items-center gap-2">
                            <input
                              aria-label={copy("proxy.upstream.models.namePlaceholder")}
                              value={readString(model, "name")}
                              onChange={(event) => change({ name: event.currentTarget.value })}
                              className={inputClass}
                            />
                            <input
                              aria-label={copy("proxy.upstream.models.aliasPlaceholder")}
                              value={readString(model, "alias")}
                              onChange={(event) => change({ alias: event.currentTarget.value })}
                              className={inputClass}
                            />
                            <button
                              type="button"
                              aria-label={copy("proxy.upstream.models.remove")}
                              className="shrink-0 rounded-md p-1.5 text-oai-gray-400 transition-colors hover:bg-oai-red-50 hover:text-oai-red-600 dark:hover:bg-oai-red-950"
                              onClick={() => set(draft.id, "models", key.models.filter((_, i) => i !== modelIndex))}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 self-start rounded-md border border-oai-gray-300 px-2 py-1 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-50 dark:border-oai-gray-700 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800"
                        onClick={() => set(draft.id, "models", [...key.models, { name: "", alias: "" }])}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {copy("proxy.upstream.models.add")}
                      </button>
                    </div>
                  ) : null}
                </div>
                {section === "codex-api-key" ? (
                  <label className="rounded-md border border-oai-gray-100 p-2 text-xs font-medium text-oai-gray-700 dark:border-oai-gray-800 dark:text-oai-gray-300">
                    <span>WebSocket</span>
                    <select
                      value={key.websockets == null ? "" : String(key.websockets)}
                      onChange={(event) => set(draft.id, "websockets", event.currentTarget.value === "" ? undefined : event.currentTarget.value === "true")}
                      className={`${inputClass} mt-1.5`}
                    >
                      <option value="">{copy("proxy.upstream.option.inherit")}</option>
                      <option value="true">{copy("proxy.upstream.common.enabled")}</option>
                      <option value="false">{copy("proxy.upstream.common.disabled")}</option>
                    </select>
                  </label>
                ) : null}
                {section === "claude-api-key" ? (
                  <div className="flex flex-col gap-2 rounded-md border border-oai-gray-100 p-2 dark:border-oai-gray-800">
                    <label className="text-xs font-medium text-oai-gray-700 dark:text-oai-gray-300">
                      <span>{copy("proxy.upstream.cloak.mode")}</span>
                      <select
                        value={isRecord(key.cloak) ? readString(key.cloak, "mode") : ""}
                        onChange={(event) => {
                          const cloak = isRecord(key.cloak) ? { ...key.cloak } : {};
                          if (event.currentTarget.value) cloak.mode = event.currentTarget.value;
                          else delete cloak.mode;
                          set(draft.id, "cloak", Object.keys(cloak).length ? cloak : undefined);
                        }}
                        className={`${inputClass} mt-1.5`}
                      >
                        <option value="">{copy("proxy.upstream.cloak.default")}</option>
                        <option value="auto">{copy("proxy.upstream.cloak.auto")}</option>
                        <option value="always">{copy("proxy.upstream.cloak.always")}</option>
                        <option value="never">{copy("proxy.upstream.cloak.never")}</option>
                      </select>
                    </label>
                    <label className="text-xs font-medium text-oai-gray-700 dark:text-oai-gray-300">
                      <span>{copy("proxy.upstream.cloak.words")}</span>
                      <textarea
                        rows={3}
                        value={draft.text?.["cloak-words"] ?? (isRecord(key.cloak) && Array.isArray(key.cloak["sensitive-words"]) ? key.cloak["sensitive-words"].join("\n") : "")}
                        onChange={(event) => setText(draft.id, "cloak-words", event.currentTarget.value)}
                        className={`${inputClass} mt-1.5 font-mono text-xs`}
                      />
                    </label>
                    {["strict-mode", "cache-user-id"].map((field) => (
                      <label key={field} className="text-xs font-medium text-oai-gray-700 dark:text-oai-gray-300">
                        <span>{copy(field === "strict-mode" ? "proxy.upstream.cloak.strict" : "proxy.upstream.cloak.cacheUser")}</span>
                        <select
                          value={isRecord(key.cloak) && key.cloak[field] != null ? String(key.cloak[field]) : ""}
                          onChange={(event) => {
                            const cloak = isRecord(key.cloak) ? { ...key.cloak } : {};
                            if (event.currentTarget.value === "") delete cloak[field];
                            else cloak[field] = event.currentTarget.value === "true";
                            set(draft.id, "cloak", Object.keys(cloak).length ? cloak : undefined);
                          }}
                          className={`${inputClass} mt-1.5`}
                        >
                          <option value="">{copy("proxy.upstream.option.inherit")}</option>
                          <option value="true">{copy("proxy.upstream.common.enabled")}</option>
                          <option value="false">{copy("proxy.upstream.common.disabled")}</option>
                        </select>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            </details>
            <p className="mt-2 font-mono text-xs text-oai-gray-400">{maskSecret(readString(key, "api-key"))}</p>
          </fieldset>
        );
      })}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md border border-oai-gray-300 px-2 py-1 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-oai-gray-700 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800"
          onClick={() => onChange([...keys, providerKeyDraft({ "api-key": "" })])}
        >
          <Plus className="h-3.5 w-3.5" />
          {copy("proxy.upstream.groups.addKey")}
        </button>
      </div>
    </section>
  );
}
