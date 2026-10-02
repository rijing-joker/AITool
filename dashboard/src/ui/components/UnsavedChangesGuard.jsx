import React, { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { copy } from "../../lib/copy";
import { ConfirmModal } from "./ConfirmModal";

/** Guard route changes (including back/forward) and closing the browser tab. */
export function UnsavedChangesGuard({ dirty, busy = false }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    (dirty || busy) && `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}` !==
      `${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`,
  );
  useEffect(() => {
    if (!dirty && !busy) return undefined;
    const beforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, busy]);
  return (
    <ConfirmModal
      open={blocker.state === "blocked"}
      title={copy("shared.unsaved.title")}
      description={copy("shared.unsaved.description")}
      confirmLabel={copy("shared.unsaved.discard")}
      cancelLabel={copy("shared.unsaved.keep_editing")}
      busy={busy}
      onConfirm={() => blocker.proceed?.()}
      onCancel={() => blocker.reset?.()}
    />
  );
}
