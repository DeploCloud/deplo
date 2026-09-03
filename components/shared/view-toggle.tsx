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

/**
 * The grid/list switch every list wears. The active background SLIDES between
 * the two buttons, same motion as the sidebar's selected item.
 */
export function ViewToggle({
  view,
  onView,
  gridLabel = "Grid view",
  listLabel = "List view",
  className,
}: {
  view: ListView;
  onView: (v: ListView) => void;
  /** What the two buttons are called - a real table says "Table view". */
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
              // z-10 keeps the icon above the sliding pill; the active button
              // paints no background of its own, the pill is it.
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
