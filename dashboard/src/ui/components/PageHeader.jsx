import React from "react";

export function PageHeader({ title, description, actions, children }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="text-2xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-[28px]">{title}</h1>
        {description ? <p className="mt-2 max-w-3xl text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
