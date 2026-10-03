import React, { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { copy } from "../../lib/copy";
import { providerSwitchApi } from "../../lib/provider-switch-api";
import { Button } from "../../ui/components";
import { SectionCard } from "./Controls.jsx";

// Port of cc-switch's AppVisibilitySettings: toggle which agent tabs appear
// on the provider-switch page. The visibility map lives in the local CLI's
// provider-switch store (~/.aitool/provider-switch/providers.json) and the
// backend refuses to hide the last visible app.

const APP_ITEMS = [
  { id: "claude", labelKey: "pswitch.tab.claude" },
  { id: "codex", labelKey: "pswitch.tab.codex" },
  { id: "gemini", labelKey: "pswitch.tab.gemini" },
  { id: "opencode", labelKey: "pswitch.tab.opencode" },
  { id: "openclaw", labelKey: "pswitch.tab.openclaw" },
  { id: "mcode", labelKey: "pswitch.tab.mcode" },
  { id: "hermes", labelKey: "pswitch.tab.hermes" },
  { id: "pi", labelKey: "pswitch.tab.pi" },
  { id: "grokbuild", labelKey: "pswitch.tab.grokbuild" },
];

export function ProviderSwitchSection() {
  const [visibleApps, setVisibleApps] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    providerSwitchApi
      .getStatus()
      .then((status) => {
        if (!cancelled) setVisibleApps(status.visibleApps);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleCount = visibleApps ? APP_ITEMS.filter(({ id }) => visibleApps[id] !== false).length : 0;

  const handleToggle = useCallback(
    (appId) => {
      if (!visibleApps || busy) return;
      const next = { ...visibleApps, [appId]: visibleApps[appId] === false };
      setBusy(true);
      providerSwitchApi
        .updateVisibleApps(next)
        .then((res) => setVisibleApps(res.visibleApps))
        .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false));
    },
    [visibleApps, busy],
  );

  return (
    <div className="space-y-4">
      <SectionCard title={copy("settings.pswitch.visibility.title")}>
        <p className="mb-3 text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">
          {copy("settings.pswitch.visibility.description")}
        </p>
        {loadError ? (
          <p className="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">
            {copy("pswitch.error.load")}: {loadError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-oai-gray-200 bg-oai-gray-50 p-2 dark:border-oai-gray-800 dark:bg-oai-gray-900/60">
          {APP_ITEMS.map(({ id, labelKey }) => {
            const isVisible = visibleApps ? visibleApps[id] !== false : true;
            const isDisabled = !visibleApps || busy || (isVisible && visibleCount <= 1);
            return (
              <button
                key={id}
                type="button"
                onClick={() => handleToggle(id)}
                disabled={isDisabled}
                aria-pressed={isVisible}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:cursor-not-allowed disabled:opacity-50 ${
                  isVisible
                    ? "bg-white text-oai-black shadow-sm ring-1 ring-oai-gray-200 dark:bg-oai-gray-800 dark:text-white dark:ring-oai-gray-700"
                    : "text-oai-gray-400 hover:text-oai-gray-700 dark:text-oai-gray-500 dark:hover:text-oai-gray-300"
                }`}
              >
                {copy(labelKey)}
              </button>
            );
          })}
        </div>
      </SectionCard>
      <SectionCard title={copy("settings.pswitch.open.title")}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">
            {copy("settings.pswitch.open.hint")}
          </p>
          <Button variant="secondary" size="sm" as={Link} to="/provider-switch">
            {copy("settings.pswitch.open.action")}
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}

export default ProviderSwitchSection;
