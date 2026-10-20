import React, { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { Eye, EyeOff } from "lucide-react";
import { copy } from "./copy";
import { maskSensitiveText } from "./privacy-mask";
import { getLocalApiAuthHeaders } from "./local-api-auth";
import { showToast } from "../ui/components/Toast";
import { Button } from "../ui/components/Button";

const STORAGE_KEY = "aitool.proxy.privacy-mode";
const CHANGE = "aitool:proxy-privacy";
const subscribe = (listener) => {
  window.addEventListener(CHANGE, listener);
  window.addEventListener("storage", listener);
  return () => { window.removeEventListener(CHANGE, listener); window.removeEventListener("storage", listener); };
};
let memory;
const get = () => {
  try { return window.localStorage.getItem(STORAGE_KEY) === "on"; } catch { return memory ?? false; }
};
export function setProxyPrivacy(enabled) {
  memory = enabled;
  try { window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off"); } catch { /* The in-memory preference remains available. */ }
  window.dispatchEvent(new Event(CHANGE));
}
export const useProxyPrivacy = () => useSyncExternalStore(subscribe, get, () => false);
export const PrivacyIdentities = createContext([]);
export function authFileIdentities(file) {
  return [file.email, file.account, file.account_id, file.project_id].filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
}
export function usePrivacyText(identities) {
  const enabled = useProxyPrivacy();
  const inherited = useContext(PrivacyIdentities);
  return (value, extraIdentities = []) => enabled
    ? maskSensitiveText(String(value ?? ""), [...(identities ?? inherited), ...extraIdentities])
    : value;
}

export function ProxyPrivacyToggle() {
  const enabled = useProxyPrivacy();
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/proxy/privacy").then((response) => response.json()).then((data) => {
      if (!active || !data.ok) return;
      if (typeof data.enabled === "boolean") setProxyPrivacy(data.enabled);
      setReady(true);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  const toggle = async () => {
    setBusy(true);
    try {
      const headers = await getLocalApiAuthHeaders();
      const response = await fetch("/api/proxy/privacy", { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error();
      setProxyPrivacy(!enabled);
    } catch { showToast({ title: copy("proxy.privacy.saveFailed"), type: "error" }); }
    finally { setBusy(false); }
  };
  const Icon = enabled ? EyeOff : Eye;
  return <Button type="button" variant={enabled ? "primary" : "secondary"} aria-pressed={enabled} aria-busy={busy} disabled={!ready || busy} onClick={() => void toggle()} title={copy("proxy.privacy.hint")} className="px-3">
    <Icon size={15} aria-hidden="true" />{copy(!ready ? "proxy.loading" : enabled ? "proxy.privacy.on" : "proxy.privacy.off")}
  </Button>;
}

export function ProxyPrivacyNotice() {
  const enabled = useProxyPrivacy();
  return <div role="status" aria-live="polite">
    {enabled ? <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-oai-gray-200 bg-oai-gray-50 px-3 py-2.5 text-xs leading-5 text-oai-gray-700 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-gray-300">
      <span className="flex min-w-0 flex-1 items-start gap-2"><EyeOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{copy("proxy.privacy.activeHint")}</span>
      <span className="break-all">{copy("proxy.privacy.example")}</span>
    </div> : null}
  </div>;
}
