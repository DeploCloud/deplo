"use client";

import * as React from "react";
import { MousePointerSquareDashed, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CardSelection } from "@/components/shared/use-card-selection";

export const MARQUEE_BOX =
  "pointer-events-none absolute z-10 hidden rounded-xl border-2 border-primary";

export const SELECTED_RING =
  "ring-2 ring-primary ring-offset-2 ring-offset-background";

export function SelectionCanvas({
  canvasRef,
  marqueeRef,
  className,
  children,
}: Pick<CardSelection, "canvasRef" | "marqueeRef"> & {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={canvasRef}
      className={cn("relative min-h-[60vh] select-none", className)}
    >
      <div ref={marqueeRef} className={MARQUEE_BOX} />
      {children}
    </div>
  );
}

type Modifiers = { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };

export function selectableProps(
  id: string,
  onSelect: (e: Modifiers) => boolean,
): {
  "data-card-id": string;
  onClickCapture: (e: React.MouseEvent<HTMLElement>) => void;
} {
  return {
    "data-card-id": id,
    onClickCapture(e) {
      if (!e.currentTarget.contains(e.target as Node)) return;
      if (!(e.metaKey || e.ctrlKey || e.shiftKey)) return;
      if ((e.target as HTMLElement).closest?.("[data-card-actions]")) return;
      e.preventDefault();
      e.stopPropagation();
      onSelect(e);
    },
  };
}

export function SelectableCard({
  id,
  selected,
  onSelect,
  children,
}: {
  id: string;
  selected: boolean;
  onSelect: (e: Modifiers) => boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      {...selectableProps(id, onSelect)}
      className={cn(
        "touch-manipulation rounded-xl select-none",
        selected && SELECTED_RING,
      )}
    >
      {children}
    </div>
  );
}

export function SelectionBar({
  count,
  onSelectAll,
  onClear,
  children,
}: {
  count: number;
  onSelectAll: () => void;
  onClear: () => void;
  children?: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div
      data-selection-bar=""
      className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-popover/95 py-1.5 pr-1.5 pl-4 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-popover/80">
        <span className="text-sm font-medium whitespace-nowrap">
          {count} selected
        </span>
        <span className="mx-1.5 h-5 w-px bg-border" />
        {children}
        <span className="mx-1.5 h-5 w-px bg-border" />
        <Button variant="ghost" size="sm" onClick={onSelectAll}>
          <MousePointerSquareDashed className="size-4" />
          Select all
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear selection"
          onClick={onClear}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function useSelectionShortcuts({
  count,
  selectAll,
  clear,
  onDelete,
}: {
  count: number;
  selectAll: () => void;
  clear: () => void;
  onDelete?: () => void;
}) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t?.closest("input, textarea, [contenteditable='true'], [role='dialog']")
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
      } else if (e.key === "Escape" && count > 0) {
        clear();
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        onDelete &&
        count > 0
      ) {
        e.preventDefault();
        onDelete();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, selectAll, clear, onDelete]);
}
