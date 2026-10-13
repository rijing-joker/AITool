import React, { useMemo } from "react";
import { copy } from "../lib/copy";
import { authFileName, isOAuthCredentialFile, providerLabelForFile, authFileHealth } from "../lib/easy-auth";
import { usePrivacyText } from "../lib/proxy-privacy";

export function ProxyAccountOverview({ files, onSelect }) {
  const display = usePrivacyText();
  const groups = useMemo(() => {
    const result = new Map();
    for (const file of files) {
      if (!isOAuthCredentialFile(file)) continue;
      const provider = providerLabelForFile(file);
      if (!result.has(provider)) result.set(provider, []);
      result.get(provider).push(file);
    }
    return [...result].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);
  return <section aria-label={copy("proxy.accounts.title")} className="space-y-2">
    <h2 className="text-sm font-semibold">{copy("proxy.accounts.title")}</h2>
    {groups.length === 0 ? <p className="text-xs text-oai-gray-500">{copy("proxy.accounts.empty")}</p> : (
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map(([provider, accounts]) => <button key={provider} type="button" onClick={() => onSelect(provider)} aria-label={copy("proxy.accounts.view", { provider })} className="min-w-0 rounded-xl border border-oai-gray-200 p-3 text-left hover:bg-oai-gray-50 dark:border-oai-gray-800 dark:hover:bg-oai-gray-800/50">
          <div className="flex justify-between gap-2 text-sm"><strong>{provider}</strong><span>{copy("proxy.accounts.count", { count: accounts.length })}</span></div>
          <ul className="mt-2 space-y-1 text-xs text-oai-gray-500">
            {accounts.slice(0, 3).map((file) => {
              const identity = display(file.email || file.account || file.project_id || file.label || authFileName(file));
              return <li key={authFileName(file)} className="flex min-w-0 justify-between gap-2" title={identity}><span className="truncate">{identity}</span><span className="shrink-0">{copy(authFileHealth(file).label)}</span></li>;
            })}
            {3 < accounts.length ? <li>{copy("proxy.accounts.more", { count: accounts.length - 3 })}</li> : null}
          </ul>
        </button>)}
      </div>
    )}
  </section>;
}
