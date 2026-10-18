import React from "react";
import { cn } from "../../lib/cn";

export function PageHeader({ title, description, actions, children, className }) {
  return (
    <header className={cn("mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2", className)}>
      <h1 className="min-w-0 text-2xl font-semibold leading-tight tracking-tight text-oai-black dark:text-oai-white sm:text-[28px]">{title}</h1>
      {actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
      {description ? <p className="col-span-full max-w-3xl text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-400">{description}</p> : null}
      {children ? <div className="col-span-full">{children}</div> : null}
    </header>
  );
}
