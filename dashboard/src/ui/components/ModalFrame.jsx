import React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { cn } from "../../lib/cn";

/** Shared focus, escape and nesting behavior for management dialogs. */
export function ModalFrame({ open, onClose, busy = false, label, children, className }) {
  return (
    <Dialog.Root open={open} onOpenChange={(next, details) => {
      if (!next && details.reason === "escape-key" && details.event.target?.closest?.('[aria-roledescription="sortable"][aria-pressed="true"]')) {
        details.cancel();
        details.allowPropagation();
        return;
      }
      if (!next && !busy) onClose();
    }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center p-3 sm:p-4">
          <Dialog.Popup
            aria-label={label}
            onKeyDown={(event) => {
              // Active dnd-kit handles need arrow/Escape events to reach their
              // document sensor; the popup otherwise stops composite keys.
              if (event.target.closest?.('[aria-roledescription="sortable"][aria-pressed="true"]')) {
                event.preventBaseUIHandler();
              }
            }}
            className={cn("flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-oai-white shadow-2xl ring-1 ring-oai-gray-200 dark:bg-oai-gray-900 dark:ring-oai-gray-700", className)}
          >
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
