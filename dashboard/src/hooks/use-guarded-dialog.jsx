import React, { useLayoutEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";
import { ConfirmModal } from "../ui/components/ConfirmModal";

// Dialogs own close/discard; the page owns the single route/unload blocker.
export function useGuardedDialog({ open = true, dirty, busy = false, onClose, onEditorStateChange }) {
  const [discardOpen, setDiscardOpen] = useState(false);
  const report = useRef(onEditorStateChange);
  report.current = onEditorStateChange;
  useLayoutEffect(() => {
    report.current?.({ open, dirty: open && dirty, busy: open && busy });
    if (!open) setDiscardOpen(false);
  }, [open, dirty, busy]);
  useLayoutEffect(() => () => {
    report.current?.({ open: false, dirty: false, busy: false });
  }, []);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  };
  return {
    requestClose,
    confirmation: <ConfirmModal
      open={open && discardOpen}
      title={copy("shared.unsaved.title")}
      description={copy("shared.unsaved.description")}
      confirmLabel={copy("shared.unsaved.discard")}
      cancelLabel={copy("shared.unsaved.keep_editing")}
      destructive busy={busy}
      onCancel={() => setDiscardOpen(false)}
      onConfirm={() => { if (!busy) { setDiscardOpen(false); onClose(); } }}
    />,
  };
}
