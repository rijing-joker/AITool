import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Button, Card, Input } from "../ui/components";
import { copy } from "../lib/copy";
import { skillsApi } from "../lib/provider-switch-api";

// Skills panel (cc-switch's UnifiedSkillsPanel, v1): one SSOT list discovered
// from the agents' skills directories, with per-app toggles that project each
// skill into the app's skills directory (symlink, falling back to a stamped
// copy). No repo discovery/install yet — Import rescans the local dirs.
export function ProviderSkillsPanel({ onEditorStateChange }) {
  const [skills, setSkills] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState([]);
  const [notice, setNotice] = useState(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    onEditorStateChange?.({ open: false, dirty: false, busy: false });
  }, [onEditorStateChange]);

  const load = useCallback(async () => {
    try {
      const res = await skillsApi.list();
      setSkills(res.skills || []);
      setApps(res.apps || []);
      setFailures([]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async (fn) => {
    setBusy(true);
    try {
      const res = await fn();
      setSkills(res.skills ?? []);
      setFailures(res.failures ?? []);
      if (res.discovered != null) setNotice(copy("pswitch.skills.imported", { count: res.discovered }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const filtered = skills.filter((skill) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${skill.name}\n${skill.description}\n${skill.sourceDir}`.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-oai-gray-800 dark:text-oai-gray-200">
            {copy("pswitch.skills.title", { count: skills.length })}
          </h2>
          <p className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.skills.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy("pswitch.skills.search")}
            aria-label={copy("pswitch.skills.search")}
            className="h-8 w-48"
          />
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => skillsApi.import())}>
            <Download className="mr-1 h-3.5 w-3.5" />
            {copy("pswitch.skills.import")}
          </Button>
        </div>
      </div>

      {notice ? <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{notice}</p> : null}
      {failures.length > 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
          {failures.map((line) => (
            <p key={line} className="break-all">{line}</p>
          ))}
        </div>
      ) : null}

      {loading ? (
        <Card><p className="px-4 py-4 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("pswitch.skills.loading")}</p></Card>
      ) : filtered.length === 0 ? (
        <Card><p className="px-4 py-4 text-sm text-oai-gray-500 dark:text-oai-gray-400">
          {query.trim() ? copy("pswitch.skills.no_match") : copy("pswitch.skills.empty")}
        </p></Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((skill) => (
            <Card key={skill.id}>
              <div className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-oai-gray-800 dark:text-oai-gray-200">{skill.name}</p>
                  {skill.description ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">{skill.description}</p>
                  ) : null}
                  <p className="mt-1 truncate text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{skill.sourceDir}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {apps.map((app) => {
                    const enabled = skill.apps?.[app] === true;
                    return (
                      <button
                        key={app}
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => skillsApi.toggle(skill.id, app, !enabled))}
                        aria-pressed={enabled}
                        className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                          enabled
                            ? "border-oai-brand-600 bg-oai-brand-600 text-white"
                            : "border-oai-gray-200 text-oai-gray-500 hover:border-oai-brand-500 hover:text-oai-brand-600 dark:border-oai-gray-700 dark:text-oai-gray-400 dark:hover:text-oai-brand-400"
                        }`}
                      >
                        {copy(`pswitch.tab.${app}`)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
