import React, { useCallback, useMemo, useState } from "react";
import { copy } from "../lib/copy";
import { Card } from "../ui/components";
import { formatCostUsd } from "../lib/cost-format";
import { useVisiblePolling } from "../hooks/use-visible-polling";

// 53-week usage heatmap (cc-switch cf2e6a7's surviving "All" range): a
// GitHub-style day grid over the proxy request log. Columns are weeks
// (Monday-first), color levels are quartiles over the non-zero days so one
// spike cannot flatten the rest, and hovering a cell shows that day's
// tokens / requests / cost.

const WEEKS = 53;
const DAY_MS = 24 * 60 * 60 * 1000;
const METRICS = ["tokens", "requests", "cost"];

// Full class strings so Tailwind keeps every step of the brand scale.
const LEVEL_CLASSES = [
  "bg-oai-gray-100 dark:bg-oai-gray-800",
  "bg-oai-brand-500/25",
  "bg-oai-brand-500/45",
  "bg-oai-brand-500/70",
  "bg-oai-brand-500",
];

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function weekdayIndex(date) {
  return (date.getDay() + 6) % 7;
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function getHeatmapStart(now) {
  const today = startOfDay(now);
  const thisMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - weekdayIndex(today));
  return new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - (WEEKS - 1) * 7);
}

function buildThresholds(values) {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return [at(0.25), at(0.5), at(0.75)];
}

function levelOf(value, thresholds) {
  if (value <= 0) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  return 4;
}

function compactTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

const compactNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export function UsageHeatmap() {
  const [days, setDays] = useState(null);
  const [metric, setMetric] = useState("tokens");

  // useVisiblePolling keys its effect on this callback: an inline function
  // would restart the loop (and refetch) on every render.
  const load = useCallback(async (signal) => {
    try {
      const data = await fetch("/api/proxy/usage/heatmap", { cache: "no-store", signal }).then((response) => response.json());
      if (signal.aborted) return;
      if (data?.ok) setDays(data.days ?? []);
    } catch {
      if (!signal?.aborted) setDays((current) => current ?? []);
    }
  }, []);
  useVisiblePolling(load, 60_000);

  const heat = useMemo(() => {
    const byDay = new Map();
    for (const day of days ?? []) byDay.set(day.date, day);
    const today = startOfDay(new Date());
    const start = getHeatmapStart(today);
    const weeks = [];
    for (let w = 0; w < WEEKS; w++) {
      const column = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
        const entry = byDay.get(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`);
        column.push({
          key: dayKey(date),
          date,
          tokens: entry?.tokens ?? 0,
          requests: entry?.requests ?? 0,
          costUsd: entry?.costUsd ?? 0,
          future: date.getTime() > today.getTime(),
        });
      }
      weeks.push(column);
    }
    const seen = weeks.flat().filter((cell) => !cell.future);
    const valueOf = (cell) => (metric === "tokens" ? cell.tokens : metric === "requests" ? cell.requests : cell.costUsd);
    const thresholds = buildThresholds(seen.map(valueOf));
    // A month label sits on the first column that contains the 1st of a month.
    const monthLabels = weeks.map((column, index) => {
      if (index === 0) return column[0].date.getMonth() + 1;
      const first = column.find((cell) => cell.date.getDate() === 1);
      return first ? first.date.getMonth() + 1 : null;
    });
    return { weeks, thresholds, valueOf, monthLabels };
  }, [days, metric]);

  const weekdayLabels = useMemo(() => (
    Array.from({ length: 7 }, (_, d) => new Date(2024, 0, 1 + d).toLocaleDateString(undefined, { weekday: "short" }))
  ), []);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-oai-black dark:text-white">{copy("proxy.heatmap.title")}</h2>
          <p className="mt-0.5 text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("proxy.heatmap.subtitle")}</p>
        </div>
        <div className="inline-flex rounded-lg border border-oai-gray-200 p-0.5 dark:border-oai-gray-800">
          {METRICS.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => setMetric(entry)}
              aria-pressed={metric === entry}
              className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                metric === entry
                  ? "bg-oai-gray-100 text-oai-black dark:bg-oai-gray-800 dark:text-white"
                  : "text-oai-gray-500 hover:text-oai-black dark:hover:text-white"
              }`}
            >
              {copy(`proxy.heatmap.metric.${entry}`)}
            </button>
          ))}
        </div>
      </div>
      {days === null ? (
        <div className="flex h-[140px] items-center justify-center text-sm text-oai-gray-400">{copy("proxy.loading")}</div>
      ) : (
        <div className="mt-3 overflow-x-auto pb-1">
          <div
            className="grid min-w-[760px] items-center gap-[3px]"
            style={{ gridTemplateColumns: "max-content repeat(53, minmax(0, 1fr))" }}
          >
            <span />
            {heat.monthLabels.map((label, w) => (
              <span key={`m${w}`} className="h-4 overflow-visible whitespace-nowrap text-[10px] leading-4 text-oai-gray-400">
                {label != null ? new Date(2024, label - 1, 1).toLocaleDateString(undefined, { month: "short" }) : ""}
              </span>
            ))}
            {weekdayLabels.map((label, d) => (
              <React.Fragment key={`r${d}`}>
                <span className="pe-1.5 text-[10px] leading-none text-oai-gray-400">{d % 2 === 0 ? label : ""}</span>
                {heat.weeks.map((column) => {
                  const cell = column[d];
                  const level = cell.future ? 0 : levelOf(heat.valueOf(cell), heat.thresholds);
                  const tooltip = cell.future
                    ? undefined
                    : copy("proxy.heatmap.day", {
                        date: cell.date.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" }),
                        tokens: compactTokens(cell.tokens),
                        requests: compactNumber.format(cell.requests),
                        cost: formatCostUsd(cell.costUsd) ?? "$0",
                      });
                  return (
                    <div
                      key={cell.key}
                      title={tooltip}
                      className={`aspect-square w-full rounded-[3px] ${LEVEL_CLASSES[level]}`}
                    />
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
