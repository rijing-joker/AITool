import React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { cn } from "../../lib/cn";

/** Shared focus, escape and nesting behavior for management dialogs. */
export function ModalFrame({ open, onClose, busy = false, label, children, className }) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center p-3 sm:p-4">
          <Dialog.Popup
            aria-label={label}
            className={cn("flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:ring-oai-gray-800", className)}
          >
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
