import { Dialog } from "@base-ui/react/dialog";
import React from "react";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { Button } from "../ui/components";

// Progress dialog for the core-binary install task — the interaction port of
// EasyCLIProxyAPI's VersionManagementPage install dialog (install-dialog +
// CoreInstallTask): eyebrow, dynamic title, current-phase badge, progress bar
// with percent/byte counters (indeterminate while the total is unknown),
// technical message line, and Cancel-download / Close actions. The dialog
// ignores Esc/backdrop dismissals while the task is running, like the GUI's
// preventEscape behaviour.

const PHASE_LABEL_KEYS = {
  checking: "proxy.core.phase_checking",
  stopping: "proxy.core.phase_stopping",
  downloading: "proxy.core.phase_downloading",
  switching: "proxy.core.phase_downloading",
  extracting: "proxy.core.phase_extracting",
  restarting: "proxy.core.phase_restarting",
  complete: "proxy.core.phase_complete",
  failed: "proxy.core.phase_failed",
  canceled: "proxy.core.phase_canceled",
};

const byteFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  let scaled = value;
  while (scaled >= 1024) {
    scaled /= 1024;
    unit += 1;
  }
  const clamped = Math.min(unit, units.length - 1);
  return `${byteFormatter.format(value / 1024 ** clamped)} ${units[clamped]}`;
}

function dialogTitle(phase) {
  if (phase === "complete") return copy("proxy.core.title_complete");
  if (phase === "failed") return copy("proxy.core.title_failed");
  if (phase === "canceled") return copy("proxy.core.title_canceled");
  return copy("proxy.core.title_running");
}

function dialogMessage(task) {
  if (task.phase === "canceled" && !task.message && !task.error) return copy("proxy.core.canceled_message");
  if (task.phase === "switching" && task.source) {
    return copy("proxy.core.switching_message", { source: task.source });
  }
  return task.error || task.message || null;
}

export function CoreInstallDialog({ open, task, onCancel, onClose }) {
  if (!open || !task) return null;
  const running = task.running;
  const phase = task.phase;
  const tone = phase === "complete" ? "success" : phase === "failed" || phase === "canceled" ? "error" : "info";
  const indeterminate = running && !task.total;
  const percent = task.percent != null ? `${task.percent.toFixed(1)}%` : copy("proxy.core.progress_unknown");
  const bytes =
    task.total != null
      ? `${formatBytes(task.downloaded)} / ${formatBytes(task.total)}`
      : formatBytes(task.downloaded);

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && running) return; // no Esc/backdrop escape mid-install
        if (!next) onClose?.();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center p-4">
          <Dialog.Popup className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.25)] ring-1 ring-oai-gray-200 transition-[opacity,transform] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] data-[ending-style]:translate-y-2 data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0 dark:bg-oai-gray-950 dark:shadow-[0_20px_60px_-10px_rgba(0,0,0,0.65)] dark:ring-oai-gray-800">
            <Dialog.Title className="text-base font-semibold text-oai-black dark:text-white">
              {dialogTitle(phase)}
            </Dialog.Title>
            <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-oai-gray-400 dark:text-oai-gray-500">
              {copy("proxy.core.dialog_eyebrow")}
            </p>

            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">
                {copy("proxy.core.phase_label")}
              </span>
              <span
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs font-semibold",
                  tone === "success" && "bg-oai-brand-50 text-oai-brand-700 dark:bg-oai-brand-950/60 dark:text-oai-brand-300",
                  tone === "error" && "bg-red-50 text-red-600 dark:bg-red-950/60 dark:text-red-400",
                  tone === "info" && "bg-oai-gray-100 text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-300",
                )}
              >
                {copy(PHASE_LABEL_KEYS[phase] || "proxy.core.phase_checking")}
              </span>
            </div>

            <div
              className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-oai-gray-100 dark:bg-oai-gray-800"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={task.percent != null ? Math.round(task.percent) : undefined}
            >
              {indeterminate ? (
                <div className="h-full w-1/3 animate-pulse rounded-full bg-oai-brand-500" />
              ) : (
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-200 ease-out",
                    tone === "success" && "bg-oai-brand-600",
                    tone === "error" && "bg-red-500",
                    tone === "info" && "bg-oai-brand-500",
                  )}
                  style={{ width: `${task.percent != null ? Math.max(2, Math.min(100, task.percent)) : 100}%` }}
                />
              )}
            </div>

            <div className="mt-2 flex items-baseline justify-between gap-3">
              <strong className="text-sm font-semibold tabular-nums">{percent}</strong>
              <span className="text-xs tabular-nums text-oai-gray-500 dark:text-oai-gray-400">{bytes}</span>
            </div>

            {dialogMessage(task) ? (
              <p
                className={cn(
                  "mt-3 break-words rounded-lg px-3 py-2 text-xs leading-5",
                  tone === "error"
                    ? "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400"
                    : "bg-oai-gray-50 text-oai-gray-500 dark:bg-oai-gray-900 dark:text-oai-gray-400",
                )}
              >
                {dialogMessage(task)}
              </p>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              {running ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => onCancel?.()}>
                  {copy("proxy.core.action_cancel")}
                </Button>
              ) : (
                <Button type="button" size="sm" onClick={() => onClose?.()}>
                  {copy("proxy.core.action_close")}
                </Button>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
