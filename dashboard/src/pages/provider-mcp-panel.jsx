import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Import, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { copy } from "../lib/copy";
import { mcpApi } from "../lib/provider-switch-api";
import { Button, Card, ConfirmModal } from "../ui/components";
import { ModalFrame } from "../ui/components/ModalFrame";
import { showToast } from "../ui/components/Toast";

// MCP server management (cc-switch's unified mcp_servers panel): one list of
// server specs shared by every agent, each with per-app toggles that project
// the spec into the app's native MCP config (codex [mcp_servers.*] tables,
// ~/.claude.json, gemini settings, opencode.json, hermes YAML, MiniMax's
// mcp.json). The spec is edited as JSON — the shape every app already
// documents — with a few well-known presets to start from.

const MCP_APPS = [
  { id: "claude", labelKey: "pswitch.tab.claude" },
  { id: "codex", labelKey: "pswitch.tab.codex" },
  { id: "gemini", labelKey: "pswitch.tab.gemini" },
  { id: "grokbuild", labelKey: "pswitch.tab.grokbuild" },
  { id: "opencode", labelKey: "pswitch.tab.opencode" },
  { id: "hermes", labelKey: "pswitch.tab.hermes" },
  { id: "mcode", labelKey: "pswitch.tab.mcode" },
];

const MCP_PRESETS = [
  {
    id: "fetch",
    name: "mcp-server-fetch",
    server: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "time",
    name: "@modelcontextprotocol/server-time",
    server: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-time"] },
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "memory",
    name: "@modelcontextprotocol/server-memory",
    server: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "sequential-thinking",
    name: "@modelcontextprotocol/server-sequential-thinking",
    server: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "context7",
    name: "@upstash/context7-mcp",
    server: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
    homepage: "https://context7.com",
  },
];

const inputClass = "h-9 w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700";
const chipOn = "bg-oai-brand-600 text-white border-oai-brand-600";
const chipOff = "bg-transparent text-oai-gray-500 border-oai-gray-200 hover:border-oai-gray-300 dark:border-oai-gray-700 dark:text-oai-gray-400";

function specSummary(spec) {
  if (!spec || typeof spec !== "object") return "";
  const type = specTransport(spec);
  if (type === "stdio") {
    const args = Array.isArray(spec.args) && spec.args.length ? ` ${spec.args.join(" ")}` : "";
    return `${String(spec.command || "")}${args}`;
  }
  return String(spec.url || "");
}

function specTransport(spec) {
  const has = (key) => typeof spec?.[key] === "string" && spec[key].trim() !== "";
  const explicit = typeof spec?.type === "string" ? spec.type : null;
  if ((explicit === null || explicit === "stdio") && !has("command") && has("url")) return "http";
  return explicit || "stdio";
}

function searchHay(server) {
  const spec = server.server || {};
  return [
    server.id, server.name, server.description, ...(Array.isArray(server.tags) ? server.tags : []),
    spec.command, ...(Array.isArray(spec.args) ? spec.args : []), spec.url,
  ].filter((value) => typeof value === "string").join("\n").toLowerCase();
}

function specJsonOf(server) {
  const spec = server?.server && typeof server.server === "object" ? server.server : { type: "stdio", command: "" };
  return JSON.stringify(spec, null, 2);
}

export function ProviderMcpPanel() {
  const [servers, setServers] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await mcpApi.list();
      setServers(data.servers);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (action, { successTitle } = {}) => {
    if (busy) return null;
    setBusy(true);
    try {
      const result = await action();
      if (result && Array.isArray(result.servers)) setServers(result.servers);
      if (successTitle) {
        const failures = result && Array.isArray(result.failures) ? result.failures : [];
        if (failures.length) {
          showToast({ title: `${successTitle} — ${failures[0]}` });
        } else {
          showToast({ title: successTitle });
        }
      }
      return result;
    } catch (error) {
      showToast({ title: `${copy("pswitch.mcp.toast_error")} — ${error instanceof Error ? error.message : String(error)}` });
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const handleToggle = (server, app) => {
    const enabled = !(server.apps && server.apps[app] === true);
    void run(() => mcpApi.toggle(server.id, app, enabled));
  };

  const handleBulkToggle = (app) => {
    const list = servers || [];
    const allOn = list.every((server) => server.apps && server.apps[app] === true);
    void run(async () => {
      const failures = [];
      let last = null;
      for (const server of list) {
        const enabled = server.apps && server.apps[app] === true;
        if (enabled === !allOn) continue;
        const result = await mcpApi.toggle(server.id, app, !allOn);
        if (result.failures && result.failures.length) failures.push(...result.failures);
        last = result;
      }
      return { ...(last || { servers }), failures };
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    void run(async () => {
      const result = await mcpApi.remove(deleteTarget.id);
      setDeleteTarget(null);
      return result;
    }, { successTitle: copy("pswitch.mcp.toast_deleted") });
  };

  const handleImport = () => {
    void run(async () => {
      const result = await mcpApi.import();
      if (result.changed === 0 && result.skipped.length === 0) {
        showToast({ title: copy("pswitch.mcp.import_none") });
      } else if (result.skipped.length) {
        showToast({ title: `${copy("pswitch.mcp.import_done", { count: result.changed })} — ${result.skipped[0]}` });
      } else {
        showToast({ title: copy("pswitch.mcp.import_done", { count: result.changed }) });
      }
      return result;
    });
  };

  const filtered = useMemo(() => {
    const list = servers || [];
    const needle = search.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((server) => searchHay(server).includes(needle));
  }, [servers, search]);

  const countFor = (app) => (servers || []).filter((server) => server.apps && server.apps[app] === true).length;
  const showNoMatch = servers !== null && servers.length > 0 && filtered.length === 0;

  const openAdd = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (server) => { setEditing(server); setDialogOpen(true); };
  const closeDialog = () => { setDialogOpen(false); setEditing(null); };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{copy("pswitch.mcp.title", { count: (servers || []).length })}</p>
            <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={handleImport}>
              <Import /> {copy("pswitch.mcp.import")}
            </Button>
            <Button size="sm" disabled={busy} onClick={openAdd}>
              <Plus /> {copy("pswitch.mcp.add")}
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-oai-gray-100 pt-3 dark:border-oai-gray-800">
          {MCP_APPS.map((app) => (
            <button
              key={app.id}
              type="button"
              disabled={busy || !servers || servers.length === 0}
              title={copy("pswitch.mcp.bulk_hint")}
              onClick={() => handleBulkToggle(app.id)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${countFor(app.id) > 0 ? chipOn : chipOff}`}
            >
              {`${copy(app.labelKey)} · ${countFor(app.id)}`}
            </button>
          ))}
        </div>
        {loadError ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{loadError}</p> : null}
      </Card>

      <input
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
        placeholder={copy("pswitch.mcp.search")}
        aria-label={copy("pswitch.mcp.search")}
        className={inputClass}
      />

      {servers !== null && servers.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Server className="h-8 w-8 text-oai-gray-300 dark:text-oai-gray-600" />
            <p className="text-sm font-medium">{copy("pswitch.mcp.empty_title")}</p>
            <p className="max-w-md text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.empty_hint")}</p>
          </div>
        </Card>
      ) : null}

      {showNoMatch ? (
        <p className="py-6 text-center text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.no_match")}</p>
      ) : null}

      <div className="flex min-w-0 flex-col gap-2">
        {filtered.map((server) => (
          <McpServerCard
            key={server.id}
            server={server}
            busy={busy}
            onToggle={handleToggle}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
          />
        ))}
      </div>

      <McpServerDialog
        open={dialogOpen}
        editing={editing}
        busy={busy}
        existingIds={(servers || []).map((server) => server.id)}
        onClose={closeDialog}
        onSaved={(result) => {
          setServers(result.servers);
          setDialogOpen(false);
          setEditing(null);
          if (result.failures.length) {
            showToast({ title: `${copy("pswitch.mcp.toast_saved")} — ${result.failures[0]}` });
          } else {
            showToast({ title: copy("pswitch.mcp.toast_saved") });
          }
        }}
      />

      <ConfirmModal
        open={deleteTarget !== null}
        title={copy("pswitch.mcp.delete_title")}
        description={copy("pswitch.mcp.delete_hint", { id: deleteTarget ? deleteTarget.id : "" })}
        confirmLabel={copy("pswitch.action.delete")}
        cancelLabel={copy("pswitch.action.cancel")}
        destructive
        busy={busy}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function McpServerCard({ server, busy, onToggle, onEdit, onDelete }) {
  const summary = specSummary(server.server);
  const description = String(server.description || "").trim();
  const summaryText = summary || copy("pswitch.mcp.spec_empty");
  return (
    <Card>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <strong className="min-w-0 truncate text-sm font-medium text-oai-black dark:text-white" title={server.name}>
              {server.name}
            </strong>
            <code className="shrink-0 rounded bg-oai-gray-100 px-1.5 py-0.5 font-mono text-xs text-oai-gray-500 dark:bg-oai-gray-800 dark:text-oai-gray-400">
              {server.id}
            </code>
            {Array.isArray(server.tags) && server.tags.length ? (
              <span className="shrink-0 truncate text-xs text-oai-gray-400 dark:text-oai-gray-500">{server.tags.join(" · ")}</span>
            ) : null}
          </div>
          {description ? (
            <p className="mt-1 line-clamp-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">{description}</p>
          ) : null}
          <p className="mt-1 truncate font-mono text-xs text-oai-gray-500 dark:text-oai-gray-400" title={summaryText}>
            {summaryText}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onEdit(server)} aria-label={copy("pswitch.mcp.edit")}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDelete(server)} aria-label={copy("pswitch.mcp.delete_title")}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 border-t border-oai-gray-100 pt-2 dark:border-oai-gray-800">
        {MCP_APPS.map((app) => {
          const enabled = server.apps && server.apps[app.id] === true;
          const label = copy(app.labelKey);
          return (
            <button
              key={app.id}
              type="button"
              disabled={busy}
              aria-pressed={enabled}
              onClick={() => onToggle(server, app.id)}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${enabled ? chipOn : chipOff}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function McpServerDialog({ open, editing, busy, existingIds, onClose, onSaved }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [configText, setConfigText] = useState("{\n  \"type\": \"stdio\",\n  \"command\": \"\"\n}");
  const [configError, setConfigError] = useState("");
  const [apps, setApps] = useState({});
  const [description, setDescription] = useState("");
  const [homepage, setHomepage] = useState("");
  const [docs, setDocs] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setId(editing ? editing.id : "");
    setName(editing ? editing.name : "");
    setConfigText(specJsonOf(editing));
    setConfigError("");
    setApps(editing ? { ...editing.apps } : {});
    setDescription(editing ? editing.description || "" : "");
    setHomepage(editing ? editing.homepage || "" : "");
    setDocs(editing ? editing.docs || "" : "");
    setTags(editing && Array.isArray(editing.tags) ? editing.tags.join(", ") : "");
  }, [open, editing]);

  const parseSpec = () => {
    try {
      const spec = JSON.parse(configText);
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        return { error: copy("pswitch.mcp.json_object") };
      }
      return { spec };
    } catch (error) {
      return { error: `${copy("pswitch.mcp.json_invalid")}: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const applyPreset = (presetId) => {
    const preset = MCP_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const nextId = editing ? editing.id : uniqueId(preset.id, existingIds);
    setId(nextId);
    if (!name) setName(preset.name);
    setConfigText(JSON.stringify(preset.server, null, 2));
    setHomepage(preset.homepage || "");
    setConfigError("");
  };

  const idTaken = !editing && existingIds.includes(id.trim());
  const idValid = /^[A-Za-z0-9_-]{1,64}$/.test(id.trim());
  const parsed = open ? parseSpec() : { spec: null };
  const canSave = open && !busy && !saving && id.trim() !== "" && idValid && !idTaken && !parsed.error && configError === "";

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const result = await mcpApi.upsert({
        id: id.trim(),
        name: name.trim() || id.trim(),
        server: parsed.spec,
        apps,
        description,
        homepage,
        docs,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      });
      onSaved(result);
    } catch (error) {
      showToast({ title: `${copy("pswitch.mcp.toast_error")} — ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalFrame open={open} onClose={onClose} busy={busy || saving} label={copy("pswitch.mcp.dialog_title")}>
      <div className="flex min-w-0 flex-col gap-3">
        <h2 className="text-sm font-semibold">{editing ? copy("pswitch.mcp.edit") : copy("pswitch.mcp.add")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.field_id")}</span>
            <input
              value={id}
              disabled={Boolean(editing)}
              onChange={(event) => setId(event.currentTarget.value)}
              placeholder="fetch"
              spellCheck={false}
              className={`${inputClass} font-mono`}
            />
            <span className={`block text-xs ${idValid && !idTaken ? "text-oai-gray-400 dark:text-oai-gray-500" : "text-red-600 dark:text-red-400"}`}>
              {idTaken ? copy("pswitch.mcp.id_taken") : !idValid ? copy("pswitch.mcp.id_invalid") : copy("pswitch.mcp.id_hint")}
            </span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.field_name")}</span>
            <input value={name} onChange={(event) => setName(event.currentTarget.value)} className={inputClass} />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.preset")}</span>
          <select
            value=""
            onChange={(event) => applyPreset(event.currentTarget.value)}
            className={inputClass}
          >
            <option value="">{copy("pswitch.mcp.preset_none")}</option>
            {MCP_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.name}</option>
            ))}
          </select>
        </label>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.field_spec")}</span>
            <button
              type="button"
              className="text-xs font-medium text-oai-gray-500 hover:text-oai-black dark:hover:text-white"
              onClick={() => {
                if (parsed.error) { setConfigError(parsed.error); return; }
                setConfigText(JSON.stringify(parsed.spec, null, 2));
                setConfigError("");
              }}
            >
              {copy("pswitch.mcp.format")}
            </button>
          </div>
          <textarea
            aria-label={copy("pswitch.mcp.field_spec")}
            rows={8}
            spellCheck={false}
            value={configText}
            onChange={(event) => {
              setConfigText(event.currentTarget.value);
              setConfigError("");
            }}
            className="w-full resize-y rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-oai-gray-50 dark:bg-oai-gray-950 p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
          />
          {configError || parsed.error ? (
            <p className="text-xs text-red-600 dark:text-red-400">{configError || parsed.error}</p>
          ) : null}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.apps")}</legend>
          <div className="flex flex-wrap gap-1.5">
            {MCP_APPS.map((app) => {
              const enabled = apps[app.id] === true;
              const label = copy(app.labelKey);
              return (
                <button
                  key={app.id}
                  type="button"
                  aria-pressed={enabled}
                  onClick={() => setApps((current) => ({ ...current, [app.id]: !enabled }))}
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${enabled ? chipOn : chipOff}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("pswitch.mcp.apps_hint")}</p>
        </fieldset>

        <details>
          <summary className="cursor-pointer text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.metadata")}</summary>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block space-y-1 sm:col-span-2">
              <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.field_description")}</span>
              <input value={description} onChange={(event) => setDescription(event.currentTarget.value)} className={inputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.field_homepage")}</span>
              <input value={homepage} onChange={(event) => setHomepage(event.currentTarget.value)} className={inputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.field_docs")}</span>
              <input value={docs} onChange={(event) => setDocs(event.currentTarget.value)} className={inputClass} />
            </label>
            <label className="block space-y-1 sm:col-span-2">
              <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.mcp.field_tags")}</span>
              <input value={tags} onChange={(event) => setTags(event.currentTarget.value)} placeholder="stdio, web" className={inputClass} />
            </label>
          </div>
        </details>

        <div className="flex items-center justify-end gap-2 border-t border-oai-gray-100 pt-3 dark:border-oai-gray-800">
          <Button variant="secondary" size="sm" disabled={busy || saving} onClick={onClose}>{copy("pswitch.action.cancel")}</Button>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>{copy("pswitch.action.save")}</Button>
        </div>
      </div>
    </ModalFrame>
  );
}

function uniqueId(base, existing) {
  let candidate = base;
  let index = 2;
  while (existing.includes(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}
