import React, { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { EyeOff } from "lucide-react";
import { copy } from "./copy";
import { maskSensitiveText } from "./privacy-mask";
import { getLocalApiAuthHeaders } from "./local-api-auth";
import { showToast } from "../ui/components/Toast";

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
  try { window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off"); } catch {}
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
  return <button type="button" aria-pressed={enabled} disabled={!ready || busy} onClick={() => void toggle()} title={copy("proxy.privacy.hint")} className="inline-flex h-9 items-center gap-2 rounded-lg border border-oai-gray-200 px-3 text-sm disabled:opacity-50 dark:border-oai-gray-700">
    <EyeOff size={15} aria-hidden="true" />{copy("proxy.privacy.label")}
  </button>;
}
