import React, { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { copy } from "../lib/copy";
import { Button, ConfirmModal } from "../ui/components";

const CLOSED_EDITOR = { open: false, dirty: false, busy: false };

// Each editor mounts with its own draft. Comparing the visible fields (including
// invalid text) with that mount's snapshot also makes reverting a field clean.
// Only ProviderSwitchPage owns the route/beforeunload guard: do not useBlocker here.
export function useProviderPanelEditor({ snapshot, busy = false, onClose, onEditorStateChange }) {
  const initialSnapshot = useRef(snapshot);
  const reportRef = useRef(onEditorStateChange);
  reportRef.current = onEditorStateChange;
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const dirty = snapshot !== initialSnapshot.current;
  const blocked = busy || saving;

  useLayoutEffect(() => {
    reportRef.current?.({ open: true, dirty, busy: blocked });
  }, [dirty, blocked]);
  // Separate teardown from updates: clearing on every dirty change (or on an
  // inline callback's identity change) can flicker the page tabs or loop renders.
  useLayoutEffect(() => () => { reportRef.current?.(CLOSED_EDITOR); }, []);

  const requestClose = useCallback(() => {
    if (busy || savingRef.current) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  }, [busy, dirty, onClose]);

  const beginSave = () => {
    if (busy || savingRef.current || discardOpen) return false;
    savingRef.current = true;
    setSaving(true);
    return true;
  };
  const endSave = () => {
    savingRef.current = false;
    setSaving(false);
  };

  return {
    dirty, busy: blocked, discardOpen, requestClose, beginSave, endSave,
    keepEditing: () => setDiscardOpen(false),
    discard: () => {
      if (!busy && !savingRef.current) onClose();
    },
  };
}

/** A page-local editor, not a modal: the app sidebar stays available. */
export function ProviderPanelEditor({ title, context, editor, canSave, onSave, children }) {
  const titleId = useId();
  const heading = useRef(null);
  useLayoutEffect(() => { heading.current?.focus(); }, []);

  return (
    <>
      <section
        aria-labelledby={titleId}
        aria-busy={editor.busy}
        className="flex min-w-0 flex-1 flex-col gap-5"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          editor.requestClose();
        }}
      >
        <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-oai-gray-200 bg-oai-white py-3 dark:border-oai-gray-800 dark:bg-oai-gray-950">
          <Button variant="ghost" disabled={editor.busy} onClick={editor.requestClose}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {copy("clisessions.back")}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" disabled={editor.busy} onClick={editor.requestClose}>{copy("pswitch.action.cancel")}</Button>
            <Button disabled={!canSave || editor.busy || editor.discardOpen} onClick={onSave}>
              {editor.busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              {copy("pswitch.action.save")}
            </Button>
          </div>
        </header>
        <div className="min-w-0">
          <h2 id={titleId} ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">{title}</h2>
          {context ? <p className="mt-1 break-all text-xs text-oai-gray-500 dark:text-oai-gray-400">{context}</p> : null}
        </div>
        <fieldset disabled={editor.busy || editor.discardOpen} className="flex min-w-0 flex-1 flex-col gap-4">
          {children}
        </fieldset>
      </section>
      <ConfirmModal
        open={editor.discardOpen}
        title={copy("shared.unsaved.title")}
        description={copy("shared.unsaved.description")}
        confirmLabel={copy("shared.unsaved.discard")}
        cancelLabel={copy("shared.unsaved.keep_editing")}
        busy={editor.busy}
        destructive
        onConfirm={editor.discard}
        onCancel={editor.keepEditing}
      />
    </>
  );
}
