"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

import { Collapse } from "@/components/shared/collapse";
import { cn } from "@/lib/utils";

// SettingsDrawer - a shut-by-default drawer whose summary keeps its values readable while closed.
export function SettingsDrawer({
  title,
  summary,
  defaultOpen = false,
  className,
  children,
}: {
  title: string;
  // What the drawer holds right now, for the caller to summarise while it is shut.
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <div className={cn("rounded-lg border border-border", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-4 py-3 text-left text-sm transition-colors hover:bg-surface"
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
      <Collapse open={open} className="space-y-4 border-t border-border p-4">
        {children}
      </Collapse>
    </div>
  );
}
