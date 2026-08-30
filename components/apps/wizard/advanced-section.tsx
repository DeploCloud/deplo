"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The wizard's one collapsed drawer. Everything a first deploy does not need to
 * decide lives here, with its summary on the trigger so nobody has to open it to
 * find out where the app lands.
 */
export function AdvancedSection({
  summary,
  children,
}: {
  /** What the closed drawer already tells you, e.g. the target server. */
  summary?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="font-medium">Advanced</span>
        <span className="flex min-w-0 items-center gap-2">
          {summary && !open && (
            <span className="truncate text-xs text-muted-foreground">
              {summary}
            </span>
          )}
          <ChevronDown
            className={cn(
              "size-4 shrink-0 transition-transform",
              open && "rotate-180",
            )}
          />
        </span>
      </button>
      {open && (
        <div className="space-y-5 border-t border-border p-4">{children}</div>
      )}
    </div>
  );
}

/** One titled block inside the drawer - the same rule-and-label the build fields use. */
export function AdvancedGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      {children}
    </div>
  );
}
