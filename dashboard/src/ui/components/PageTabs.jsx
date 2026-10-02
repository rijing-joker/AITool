import React, { useLayoutEffect, useRef } from "react";

export function PageTabs({ options, value, onChange, label, panelId }) {
  const track = useRef(null);
  const buttons = useRef(new Map());
  useLayoutEffect(() => {
    const reveal = () => {
    const node = buttons.current.get(value);
    const parent = track.current;
    if (!node || !parent) return;
    const left = node.offsetLeft;
    if (left < parent.scrollLeft) parent.scrollLeft = left;
    else if (left + node.offsetWidth > parent.scrollLeft + parent.clientWidth) {
      parent.scrollLeft = left + node.offsetWidth - parent.clientWidth;
    }
    };
    reveal();
    if (typeof ResizeObserver === "undefined" || !track.current) return undefined;
    const observer = new ResizeObserver(reveal);
    observer.observe(track.current);
    return () => observer.disconnect();
  }, [value, options]);
  const onKeyDown = (event, index) => {
    const nextIndex = { ArrowRight: (index + 1) % options.length, ArrowLeft: (index - 1 + options.length) % options.length, Home: 0, End: options.length - 1 }[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = options[nextIndex].id;
    onChange(next);
    buttons.current.get(next)?.focus();
  };
  return (
    <div ref={track} role="tablist" aria-label={label} className="relative flex w-fit max-w-full shrink-0 overflow-x-auto rounded-xl border border-oai-gray-200 bg-oai-gray-50 p-1 dark:border-oai-gray-800 dark:bg-oai-gray-800/60">
      {options.map(({ id, label: text, icon: Icon }, index) => (
        <button key={id} ref={(node) => { if (node) buttons.current.set(id, node); else buttons.current.delete(id); }}
          id={panelId ? `${panelId}-${id}` : undefined} aria-controls={panelId} type="button" role="tab" aria-selected={value === id} tabIndex={value === id ? 0 : -1}
          onClick={() => onChange(id)} onKeyDown={(event) => onKeyDown(event, index)}
          className={`inline-flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500 sm:min-h-8 ${value === id ? "bg-white text-oai-black shadow-sm dark:bg-oai-gray-900 dark:text-white" : "text-oai-gray-500 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-white"}`}>
          {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}{text}
        </button>
      ))}
    </div>
  );
}
