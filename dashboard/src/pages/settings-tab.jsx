import React, { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";
import { proxyApi } from "../lib/proxy-api";
import { Button, Card } from "../ui/components";
import { UnsavedChangesGuard } from "../ui/components/UnsavedChangesGuard";

// ---------------------------------------------------------------------------
// Settings tab (设置) — EasyCLIProxyAPI's ConfigPanel general/network/routing/
// retry/diagnostics sections, ported interaction-for-interaction: per-section
// drafts with dirty tracking, validated numeric fields, selects for routing
// strategy, and section-scoped save buttons that PATCH individual config.yaml
// fields (the running core hot-reloads, exactly like the Rust GUI). The
// desktop-only software/TLS sections and the raw YAML editor remain: YAML
// stays as the advanced escape hatch.
// ---------------------------------------------------------------------------

const inputClass = "h-9 w-full rounded-lg border border-oai-gray-200 bg-transparent px-3 text-sm placeholder:text-oai-gray-400 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-700";

function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        {hint ? <p className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50 ${
          checked ? "bg-oai-brand-600" : "bg-oai-gray-300 dark:bg-oai-gray-600"
        }`}
      >
        <span
          className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-[24px]" : "translate-x-[3px]"
          }`}
        />
      </button>
    </div>
  );
}

function NumberField({ label, hint, value, onChange, error }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        inputMode="numeric"
        className={inputClass}
      />
      <span className={`block text-xs ${error ? "text-red-600 dark:text-red-400" : "text-oai-gray-400 dark:text-oai-gray-500"}`}>
        {error || hint}
      </span>
    </label>
  );
}

const integerOrNull = (value) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

function normalizedDrafts(next) {
  const read = (key, fallback) => next[key] ?? fallback;
  return {
    network: {
      host: String(read("server.host", "127.0.0.1")),
      port: String(read("server.port", 8318)),
      proxyUrl: String(read("proxy-url", "")),
    },
    routing: {
      strategy: String(read("routing.strategy", "round-robin")),
      sessionAffinity: Boolean(read("routing.session-affinity", false)),
      sessionTtl: String(read("routing.session-affinity-ttl", "")),
      disableCooling: Boolean(read("routing.cooldown.disable-cooling", false)),
      requestRetry: String(read("routing.retry.request-retry", 0)),
      maxRetryCredentials: String(read("routing.retry.max-retry-credentials", 0)),
      maxRetryInterval: String(read("routing.retry.max-retry-interval", 30)),
      streamingBootstrapRetries: String(read("routing.retry.streaming-bootstrap-retries", 0)),
    },
    diagnostics: {
      debug: Boolean(read("debug", false)),
      loggingToFile: Boolean(read("logging-to-file", false)),
      usageStatistics: Boolean(read("observability.usage.usage-statistics-enabled", true)),
      redisRetention: String(read("observability.usage.redis-usage-queue-retention-seconds", 3600)),
    },
    codex: {
      codexApplyPatch: Boolean(read("client.codex.enable-apply-patch", false)),
      codexOptimizeMultiAgent: Boolean(read("client.codex.optimize-multi-agent-v2", false)),
    },
  };
}

export function SettingsTab({ status, onRefresh, onInstallCore }) {
  const [fields, setFields] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [busyField, setBusyField] = useState("");
  const [autoStart, setAutoStart] = useState(status?.core.autoStart ?? true);
  useEffect(() => {
    if (typeof status?.core?.autoStart === "boolean") setAutoStart(status.core.autoStart);
  }, [status?.core?.autoStart]);
  const [yaml, setYaml] = useState(null);
  const [yamlDirty, setYamlDirty] = useState(false);
  const [yamlError, setYamlError] = useState(null);
  const yamlReadVersion = useRef(0);
  const [savedDrafts, setSavedDrafts] = useState(null);
  const busyRef = useRef(false);

  // Drafts (strings for inputs; null = not loaded)
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [strategy, setStrategy] = useState("round-robin");
  const [sessionAffinity, setSessionAffinity] = useState(false);
  const [sessionTtl, setSessionTtl] = useState("");
  const [disableCooling, setDisableCooling] = useState(false);
  const [requestRetry, setRequestRetry] = useState("");
  const [maxRetryCredentials, setMaxRetryCredentials] = useState("");
  const [maxRetryInterval, setMaxRetryInterval] = useState("");
  const [streamingBootstrapRetries, setStreamingBootstrapRetries] = useState("");
  const [debug, setDebug] = useState(false);
  const [loggingToFile, setLoggingToFile] = useState(false);
  const [usageStatistics, setUsageStatistics] = useState(true);
  const [redisRetention, setRedisRetention] = useState("");
  const [codexApplyPatch, setCodexApplyPatch] = useState(false);
  const [codexOptimizeMultiAgent, setCodexOptimizeMultiAgent] = useState(false);

  const drafts = {
    network: { host, port, proxyUrl },
    routing: { strategy, sessionAffinity, sessionTtl, disableCooling, requestRetry, maxRetryCredentials, maxRetryInterval, streamingBootstrapRetries },
    diagnostics: { debug, loggingToFile, usageStatistics, redisRetention },
    codex: { codexApplyPatch, codexOptimizeMultiAgent },
  };
  const dirtySections = Object.keys(drafts).filter((section) => savedDrafts &&
    JSON.stringify(drafts[section]) !== JSON.stringify(savedDrafts[section]));
  const structuredDirty = dirtySections.length > 0;
  const revertSection = (section) => {
    const setters = { host: setHost, port: setPort, proxyUrl: setProxyUrl, strategy: setStrategy, sessionAffinity: setSessionAffinity, sessionTtl: setSessionTtl, disableCooling: setDisableCooling, requestRetry: setRequestRetry, maxRetryCredentials: setMaxRetryCredentials, maxRetryInterval: setMaxRetryInterval, streamingBootstrapRetries: setStreamingBootstrapRetries, debug: setDebug, loggingToFile: setLoggingToFile, usageStatistics: setUsageStatistics, redisRetention: setRedisRetention, codexApplyPatch: setCodexApplyPatch, codexOptimizeMultiAgent: setCodexOptimizeMultiAgent };
    for (const [key, value] of Object.entries(savedDrafts[section])) setters[key](value);
  };
  const applyFields = useCallback((next) => {
    const normalized = normalizedDrafts(next);
    setHost(normalized.network.host);
    setPort(normalized.network.port);
    setProxyUrl(normalized.network.proxyUrl);
    setStrategy(normalized.routing.strategy);
    setSessionAffinity(normalized.routing.sessionAffinity);
    setSessionTtl(normalized.routing.sessionTtl);
    setDisableCooling(normalized.routing.disableCooling);
    setRequestRetry(normalized.routing.requestRetry);
    setMaxRetryCredentials(normalized.routing.maxRetryCredentials);
    setMaxRetryInterval(normalized.routing.maxRetryInterval);
    setStreamingBootstrapRetries(normalized.routing.streamingBootstrapRetries);
    setDebug(normalized.diagnostics.debug);
    setLoggingToFile(normalized.diagnostics.loggingToFile);
    setUsageStatistics(normalized.diagnostics.usageStatistics);
    setRedisRetention(normalized.diagnostics.redisRetention);
    setCodexApplyPatch(normalized.codex.codexApplyPatch);
    setCodexOptimizeMultiAgent(normalized.codex.codexOptimizeMultiAgent);
    setSavedDrafts(normalized);
  }, []);

  const loadFields = useCallback(async () => {
    try {
      const data = await fetch("/api/proxy/config-fields", { cache: "no-store" }).then((response) => response.json());
      if (!data?.ok) throw new Error(data?.error || "HTTP config-fields");
      applyFields(data.fields);
      setFields(data.fields);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [applyFields]);

  useEffect(() => {
    void loadFields();
  }, [loadFields]);

  const loadYaml = useCallback(async () => {
    const version = ++yamlReadVersion.current;
    try {
      const data = await proxyApi.configYaml();
      if (version !== yamlReadVersion.current) return;
      setYaml(data.yaml);
      setYamlDirty(false);
      setYamlError(null);
    } catch (error) {
      if (version === yamlReadVersion.current) {
        setYaml(null);
        setYamlError(error instanceof Error ? error.message : String(error));
      }
    }
  }, []);
  useEffect(() => {
    void loadYaml();
    return () => { yamlReadVersion.current += 1; };
  }, [loadYaml]);
  const revertYaml = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyField("yaml-read");
    try { await loadYaml(); }
    finally { busyRef.current = false; setBusyField(""); }
  };

  const patchFields = async (section, patch) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const submittedDraft = drafts[section];
    setBusyField(section);
    setError(null);
    setNotice(null);
    try {
      const { getLocalApiAuthHeaders } = await import("../lib/local-api-auth");
      const response = await fetch("/api/proxy/config-fields", {
        method: "PATCH",
        headers: { ...(await getLocalApiAuthHeaders()), "content-type": "application/json" },
        body: JSON.stringify({ fields: patch }),
      });
      const data = await response.json().catch(() => null);
      if (!data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      setFields(data.fields);
      setSavedDrafts((previous) => ({ ...previous, [section]: submittedDraft }));
      // Keep the YAML view in sync; it cannot be edited while a section saves.
      await loadYaml();
      onRefresh?.();
      setNotice(copy("proxy.settings.sectionSaved"));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Preserve every draft on failure so the user can retry.
      return false;
    } finally {
      busyRef.current = false;
      setBusyField("");
    }
  };

  const toggleAutoStart = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyField("autostart");
    const next = !autoStart;
    setAutoStart(next);
    try {
      await proxyApi.setSettings({ autoStart: next });
    } catch (e) {
      setAutoStart(!next);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusyField("");
    }
  };

  const portValue = integerOrNull(port);
  const portError = portValue === undefined || portValue === null || portValue < 1 || portValue > 65535
    ? copy("proxy.settings.errors.port")
    : "";
  const hostError = !host.trim() ? copy("proxy.settings.errors.host") : "";
  const intField = (value, { min = 0, max = 4294967295 } = {}) => {
    const parsed = integerOrNull(value);
    if (parsed === undefined || parsed === null || parsed < min || parsed > max) {
      return copy("proxy.settings.errors.nonNegativeInteger");
    }
    return "";
  };
  const redisError = (() => {
    const parsed = integerOrNull(redisRetention);
    if (parsed === undefined || parsed === null || parsed < 1 || parsed > 3600) {
      return copy("proxy.settings.errors.redisRetention");
    }
    return "";
  })();

  const retryValues = [requestRetry, maxRetryCredentials, maxRetryInterval, streamingBootstrapRetries];
  const retryErrors = retryValues.map((value) => intField(value, { min: 0, max: 100000 }));

  return (
    <div className="flex flex-col gap-4">
      <UnsavedChangesGuard dirty={structuredDirty || yamlDirty} busy={busyField !== ""} />
      {loadError || error ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <span className="break-words">{error || loadError}</span>
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-lg border border-oai-brand-200 dark:border-oai-brand-900 bg-oai-brand-50 dark:bg-oai-brand-950/40 px-3.5 py-2.5 text-sm text-oai-brand-700 dark:text-oai-brand-300">
          {notice}
        </div>
      ) : null}

      <Card>
        <Toggle
          disabled={!status || busyField !== ""}
          checked={autoStart}
          onChange={() => void toggleAutoStart()}
          label={copy("proxy.settings.autostart")}
          hint={copy("proxy.settings.autostart_hint")}
        />
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{copy("proxy.settings.core")}</p>
            <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {status?.core.version
                ? copy("proxy.settings.core_version", { version: status.core.version })
                : !status ? copy("proxy.state.unknown") : copy("proxy.core.missing_hint")}
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={busyField !== "" || !status}
            onClick={onInstallCore}
          >
            {copy("proxy.settings.fetch_core")}
          </Button>
        </div>
      </Card>

      <fieldset disabled={busyField !== "" || fields === null || yamlDirty} className="min-w-0 space-y-4">
      {/* Network (server.host / server.port / proxy-url) */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{copy("proxy.settings.network.title")}</p>
            <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.settings.network.hint")}</p>
          </div>
          <div className="flex items-center gap-2">
            {dirtySections.includes("network") ? <Button variant="ghost" size="sm" onClick={() => revertSection("network")}>{copy("proxy.action.revert")}</Button> : null}
          <Button
            disabled={Boolean(portError || hostError) || busyField !== "" || fields === null || !dirtySections.includes("network")}
            onClick={() => void patchFields("network", {
              "server.host": host.trim(),
              "server.port": portValue,
              ...(proxyUrl.trim() ? { "proxy-url": proxyUrl.trim() } : { "proxy-url": null }),
            })}
          >
            {busyField === "network" ? copy("proxy.settings.saving") : copy("proxy.action.save_config")}
          </Button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.settings.network.host")}</span>
            <input value={host} onChange={(event) => setHost(event.currentTarget.value)} className={inputClass} />
            <span className={`block text-xs ${hostError ? "text-red-600 dark:text-red-400" : "text-oai-gray-400 dark:text-oai-gray-500"}`}>
              {hostError || copy("proxy.settings.network.hostHint")}
            </span>
          </label>
          <NumberField
            label={copy("proxy.settings.network.port")}
            hint={copy("proxy.settings.network.portHint")}
            value={port}
            onChange={setPort}
            error={portError}
          />
          <label className="block space-y-1">
            <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.settings.network.proxyUrl")}</span>
            <input
              value={proxyUrl}
              onChange={(event) => setProxyUrl(event.currentTarget.value)}
              placeholder="socks5://127.0.0.1:1080"
              className={inputClass}
            />
            <span className="block text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.settings.network.proxyUrlHint")}</span>
          </label>
        </div>
      </Card>

      {/* Routing + retry */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{copy("proxy.settings.routing.title")}</p>
            <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.settings.routing.hint")}</p>
          </div>
          <div className="flex items-center gap-2">
            {dirtySections.includes("routing") ? <Button variant="ghost" size="sm" onClick={() => revertSection("routing")}>{copy("proxy.action.revert")}</Button> : null}
          <Button
            disabled={retryErrors.some(Boolean) || busyField !== "" || fields === null || !dirtySections.includes("routing")}
            onClick={() => void patchFields("routing", {
              ...(strategy === "round-robin" ? { "routing.strategy": null } : { "routing.strategy": strategy }),
              "routing.session-affinity": sessionAffinity,
              ...(sessionTtl.trim() ? { "routing.session-affinity-ttl": sessionTtl.trim() } : { "routing.session-affinity-ttl": null }),
              "routing.cooldown.disable-cooling": disableCooling,
              "routing.retry.request-retry": integerOrNull(requestRetry) ?? 0,
              "routing.retry.max-retry-credentials": integerOrNull(maxRetryCredentials) ?? 0,
              "routing.retry.max-retry-interval": integerOrNull(maxRetryInterval) ?? 30,
              "routing.retry.streaming-bootstrap-retries": integerOrNull(streamingBootstrapRetries) ?? 0,
            })}
          >
            {busyField === "routing" ? copy("proxy.settings.saving") : copy("proxy.action.save_config")}
          </Button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.settings.routing.strategy")}</span>
            <select value={strategy} onChange={(event) => setStrategy(event.currentTarget.value)} className={inputClass}>
              <option value="round-robin">{copy("proxy.settings.routing.roundRobin")}</option>
              <option value="fill-first">{copy("proxy.settings.routing.fillFirst")}</option>
            </select>
            <span className="block text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.settings.routing.strategyHint")}</span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.settings.routing.sessionTtl")}</span>
            <input
              value={sessionTtl}
              onChange={(event) => setSessionTtl(event.currentTarget.value)}
              placeholder="8h"
              className={inputClass}
            />
            <span className="block text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.settings.routing.sessionTtlHint")}</span>
          </label>
        </div>
        <div className="mt-3 space-y-3 border-t border-oai-gray-100 pt-3 dark:border-oai-gray-800">
          <Toggle
            checked={sessionAffinity}
            onChange={setSessionAffinity}
            label={copy("proxy.settings.routing.affinity")}
            hint={copy("proxy.settings.routing.affinityHint")}
          />
          <Toggle
            checked={disableCooling}
            onChange={setDisableCooling}
            label={copy("proxy.settings.routing.disableCooling")}
            hint={copy("proxy.settings.routing.disableCoolingHint")}
          />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-oai-gray-100 pt-3 sm:grid-cols-4 dark:border-oai-gray-800">
          <NumberField
            label={copy("proxy.settings.routing.requestRetry")}
            hint={copy("proxy.settings.routing.requestRetryHint")}
            value={requestRetry}
            onChange={setRequestRetry}
            error={retryErrors[0]}
          />
          <NumberField
            label={copy("proxy.settings.routing.maxRetryCredentials")}
            hint={copy("proxy.settings.routing.maxRetryCredentialsHint")}
            value={maxRetryCredentials}
            onChange={setMaxRetryCredentials}
            error={retryErrors[1]}
          />
          <NumberField
            label={copy("proxy.settings.routing.maxRetryInterval")}
            hint={copy("proxy.settings.routing.maxRetryIntervalHint")}
            value={maxRetryInterval}
            onChange={setMaxRetryInterval}
            error={retryErrors[2]}
          />
          <NumberField
            label={copy("proxy.settings.routing.streamingBootstrapRetries")}
            hint={copy("proxy.settings.routing.streamingBootstrapRetriesHint")}
            value={streamingBootstrapRetries}
            onChange={setStreamingBootstrapRetries}
            error={retryErrors[3]}
          />
        </div>
      </Card>

      {/* Diagnostics */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{copy("proxy.settings.diagnostics.title")}</p>
            <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.settings.diagnostics.hint")}</p>
          </div>
          <div className="flex items-center gap-2">
            {dirtySections.includes("diagnostics") ? <Button variant="ghost" size="sm" onClick={() => revertSection("diagnostics")}>{copy("proxy.action.revert")}</Button> : null}
          <Button
            disabled={Boolean(redisError) || busyField !== "" || fields === null || !dirtySections.includes("diagnostics")}
            onClick={() => void patchFields("diagnostics", {
              debug,
              "logging-to-file": loggingToFile,
              "observability.usage.usage-statistics-enabled": usageStatistics,
              "observability.usage.redis-usage-queue-retention-seconds": integerOrNull(redisRetention) ?? 3600,
            })}
          >
            {busyField === "diagnostics" ? copy("proxy.settings.saving") : copy("proxy.action.save_config")}
          </Button>
          </div>
        </div>
        <div className="mt-3 space-y-3">
          <Toggle checked={debug} onChange={setDebug} label={copy("proxy.settings.diagnostics.debug")} hint={copy("proxy.settings.diagnostics.debugHint")} />
          <Toggle checked={loggingToFile} onChange={setLoggingToFile} label={copy("proxy.settings.diagnostics.logToFile")} hint={copy("proxy.settings.diagnostics.logToFileHint")} />
          <Toggle checked={usageStatistics} onChange={setUsageStatistics} label={copy("proxy.settings.diagnostics.usageStatistics")} hint={copy("proxy.settings.diagnostics.usageStatisticsHint")} />
          <NumberField
            label={copy("proxy.settings.diagnostics.redisRetention")}
            hint={copy("proxy.settings.diagnostics.redisRetentionHint")}
            value={redisRetention}
            onChange={setRedisRetention}
            error={redisError}
          />
        </div>
      </Card>

      {/* Codex client (client.codex — core 8.0.11+) */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{copy("proxy.settings.codex.title")}</p>
            <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.settings.codex.hint")}</p>
          </div>
          <div className="flex items-center gap-2">
            {dirtySections.includes("codex") ? <Button variant="ghost" size="sm" onClick={() => revertSection("codex")}>{copy("proxy.action.revert")}</Button> : null}
            <Button
              disabled={busyField !== "" || fields === null || !dirtySections.includes("codex")}
              onClick={() => void patchFields("codex", {
                "client.codex.enable-apply-patch": codexApplyPatch,
                "client.codex.optimize-multi-agent-v2": codexOptimizeMultiAgent,
              })}
            >
              {busyField === "codex" ? copy("proxy.settings.saving") : copy("proxy.action.save_config")}
            </Button>
          </div>
        </div>
        <div className="mt-3 space-y-3">
          <Toggle checked={codexApplyPatch} onChange={setCodexApplyPatch} label={copy("proxy.settings.codex.applyPatch")} hint={copy("proxy.settings.codex.applyPatchHint")} />
          <Toggle checked={codexOptimizeMultiAgent} onChange={setCodexOptimizeMultiAgent} label={copy("proxy.settings.codex.optimizeMultiAgent")} hint={copy("proxy.settings.codex.optimizeMultiAgentHint")} />
        </div>
      </Card>

      </fieldset>

      {/* Raw YAML (advanced escape hatch) */}
      <Card>
        <p className="mb-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("proxy.settings.edit_mode_hint")}</p>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold">{copy("proxy.settings.config")}</p>
          <div className="flex items-center gap-2">
            {yamlDirty ? (
              <button
                type="button"
                disabled={busyField !== ""}
                onClick={() => void revertYaml()}
                className="text-xs font-medium text-oai-gray-500 hover:text-oai-black dark:hover:text-white"
              >
                {copy("proxy.action.revert")}
              </button>
            ) : null}
            <Button
              disabled={!yamlDirty || busyField !== "" || structuredDirty}
              onClick={async () => {
                if (yaml === null || busyRef.current) return;
                busyRef.current = true;
                setBusyField("yaml");
                setError(null);
                try {
                  await proxyApi.putConfigYaml(yaml);
                  setYamlDirty(false);
                  await loadFields();
                  onRefresh?.();
                  setNotice(copy("proxy.settings.config_saved"));
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  busyRef.current = false;
                  setBusyField("");
                }
              }}
            >
              {copy("proxy.action.save_config")}
            </Button>
          </div>
        </div>
        {yamlError ? <div role="alert" className="mt-3 flex items-center justify-between gap-3 text-sm text-amber-700 dark:text-amber-300">
          <span className="break-words">{yamlError}</span>
          <Button size="sm" variant="secondary" disabled={busyField !== ""} onClick={() => void revertYaml()}>{copy("shared.action.retry")}</Button>
        </div> : null}
        <textarea
          aria-label={copy("proxy.settings.config")}
          disabled={structuredDirty || busyField !== "" || yaml === null}
          value={yaml ?? ""}
          onChange={(event) => {
            setYaml(event.currentTarget.value);
            setYamlDirty(true);
          }}
          spellCheck={false}
          rows={16}
          className="mt-3 w-full resize-y rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-oai-gray-50 dark:bg-oai-gray-950 p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
          placeholder={copy("proxy.settings.config")}
        />
        <p className="mt-2 text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.settings.config_hint")}</p>
      </Card>
    </div>
  );
}
