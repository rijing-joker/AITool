import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";

export const SessionContentContext = createContext(null);

// Disclosure requests one bounded page. Copy explicitly requests the complete
// field; search/export request the full transcript through the parent instead.
export function useSessionText(preview, reference, active = false) {
  const read = useContext(SessionContentContext);
  const [loaded, setLoaded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef(null);
  const latest = useRef(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const text = reference ? loaded ?? preview ?? "" : preview ?? "";
  const complete = !reference || (loaded != null && loaded.length >= reference.length);
  const load = async (all = false) => {
    if (complete || !read) return text;
    if (pending.current) await pending.current;
    if (!alive.current) return text;
    if (latest.current?.length >= reference.length) return latest.current;
    setBusy(true);
    setError(false);
    const task = (async () => {
      let content = latest.current ?? "";
      do {
        const page = await read(reference, content.length);
        if (page.nextOffset <= content.length) throw new Error("Invalid content page");
        content += page.content;
      } while (all && content.length < reference.length);
      if (alive.current) {
        latest.current = content;
        setLoaded(content);
      }
      return content;
    })();
    pending.current = task;
    try {
      return await task;
    } catch (cause) {
      if (alive.current) setError(true);
      throw cause;
    } finally {
      pending.current = null;
      if (alive.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (active && reference && loaded === null && !error && !busy) void load().catch(() => {});
  });
  return { text, complete, busy, error, load };
}

export function ContentLoadControl({ content }) {
  if (content.complete) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 text-xs">
      <button type="button" disabled={content.busy}
        onClick={() => { void content.load().catch(() => {}); }}
        className="min-h-10 text-oai-brand-700 disabled:opacity-60 dark:text-oai-brand-400">
        {copy(content.busy ? "clisessions.loading" : content.error ? "clisessions.content_retry" : "clisessions.load_more")}
      </button>
      {content.error ? <span role="alert" className="text-red-700 dark:text-red-400">{copy("clisessions.content_failed")}</span> : null}
    </div>
  );
}
