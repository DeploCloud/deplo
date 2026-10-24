"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

import { Collapse } from "@/components/shared/collapse";
import { cn } from "@/lib/utils";

export function SettingsDrawer({
  title,
  summary,
  defaultOpen = false,
  flush = false,
  className,
  children,
}: {
  title: string;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  // A row of a card instead of a box of its own.
  flush?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <div className={cn(!flush && "rounded-lg border border-border", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full cursor-pointer items-center justify-between gap-2 text-left text-sm transition-colors hover:bg-surface",
          flush ? "px-6 py-4" : "rounded-lg px-4 py-3",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-medium">{title}</span>
          {!open && summary && (
            <span className="truncate text-xs text-muted-foreground">
              {summary}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      <Collapse
        open={open}
        className={cn(
          "space-y-4 border-t border-border",
          flush ? "px-6 py-4" : "p-4",
        )}
      >
        {children}
      </Collapse>
    </div>
  );
}
