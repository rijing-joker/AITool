// Device-local quota display mode (cc-switch 4b7d548b port: Settings →
// Appearance → Quota display). Only flips the visible percentage between
// "what is left" and "what is used" — colors and warnings still key off the
// remaining share, and balances/credits always show what is left.

import React from "react";

const STORAGE_KEY = "aitool.quota-display";
const CHANGE_EVENT = "aitool:quota-display";

export const QUOTA_DISPLAY_MODES = {
  LEFT: "left",
  USED: "used",
};

export function getQuotaDisplayMode() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === QUOTA_DISPLAY_MODES.USED ? QUOTA_DISPLAY_MODES.USED : QUOTA_DISPLAY_MODES.LEFT;
  } catch {
    return QUOTA_DISPLAY_MODES.LEFT;
  }
}

export function setQuotaDisplayMode(mode) {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode === QUOTA_DISPLAY_MODES.USED ? QUOTA_DISPLAY_MODES.USED : QUOTA_DISPLAY_MODES.LEFT);
  } catch {
    // Private mode / disabled storage keeps the session-local default.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: getQuotaDisplayMode() }));
}

export function useQuotaDisplayMode() {
  const [mode, setMode] = React.useState(getQuotaDisplayMode);
  React.useEffect(() => {
    const onChange = () => setMode(getQuotaDisplayMode());
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return [mode, setQuotaDisplayMode];
}
