"use client";

import * as React from "react";
import { LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  SlidingBackground,
  useSlidingRect,
} from "@/components/ui/sliding-underline";
import { cn } from "@/lib/utils";

export type ListView = "grid" | "list";

export function ViewToggle({
  view,
  onView,
  gridLabel = "Grid view",
  listLabel = "List view",
  className,
}: {
  view: ListView;
  onView: (v: ListView) => void;
  gridLabel?: string;
  listLabel?: string;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const rect = useSlidingRect(
    ref,
    () =>
      ref.current?.querySelector<HTMLElement>('[data-active="true"]') ?? null,
    [view],
  );

  const options = [
    ["grid", gridLabel, LayoutGrid],
    ["list", listLabel, List],
  ] as const;

  return (
    <div
      ref={ref}
      className={cn(
        "relative isolate flex items-center gap-1 rounded-lg border border-border p-0.5",
        className,
      )}
    >
      <SlidingBackground rect={rect} className="bg-secondary" />
      {options.map(([value, label, Icon]) => {
        const active = view === value;
        return (
          <SimpleTooltip key={value} content={label}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onView(value)}
              aria-label={label}
              aria-pressed={active}
              data-active={active ? "true" : undefined}
              className={cn(
                "relative z-10",
                active
                  ? "text-foreground hover:bg-transparent"
                  : "text-muted-foreground",
              )}
            >
              <Icon className="size-4" />
            </Button>
          </SimpleTooltip>
        );
      })}
    </div>
  );
}

// The same choice as a labelled full-width pair, for the mobile filters sheet.
export function ViewChoice({
  view,
  onView,
  gridLabel = "Grid view",
  listLabel = "List view",
}: {
  view: ListView;
  onView: (v: ListView) => void;
  gridLabel?: string;
  listLabel?: string;
}) {
  const options = [
    ["grid", gridLabel, LayoutGrid],
    ["list", listLabel, List],
  ] as const;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Layout</p>
      <div role="group" aria-label="Layout" className="grid grid-cols-2 gap-2">
        {options.map(([value, label, Icon]) => (
          <Button
            key={value}
            type="button"
            variant={view === value ? "secondary" : "outline"}
            aria-pressed={view === value}
            onClick={() => onView(value)}
          >
            <Icon />
            {label}
          </Button>
        ))}
      </div>
    </div>
  );
}
