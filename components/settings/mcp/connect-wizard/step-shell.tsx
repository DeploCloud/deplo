"use client";

import * as React from "react";

export function StepShell({
  mark,
  title,
  lead,
  children,
  action,
}: {
  mark?: React.ReactNode;
  title: string;
  lead: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-5">
      <div>
        {mark ? <span className="mb-3 flex">{mark}</span> : null}
        <h2 className="text-base font-semibold lg:text-lg">{title}</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">{lead}</p>
      </div>
      {children}
      {action ? (
        <div className="flex w-full flex-wrap items-center justify-end gap-3">
          {action}
        </div>
      ) : null}
    </div>
  );
}
