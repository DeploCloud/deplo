"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { MousePointerSquareDashed, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CardSelection } from "@/components/shared/use-card-selection";

/** The multi-selection highlight, shared by every selectable card. */
export const SELECTED_RING =
  "ring-2 ring-primary ring-offset-2 ring-offset-background";

/**
 * The surface a marquee is drawn on: tall enough to have empty space to start a
 * drag in, and the coordinate space the hook hit-tests against.
 */
export function SelectionCanvas({
  canvasRef,
  marqueeRef,
  onPointerDown,
  className,
  children,
}: Pick<CardSelection, "canvasRef" | "marqueeRef"> & {
  onPointerDown: CardSelection["onCanvasPointerDown"];
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={canvasRef}
      onPointerDown={onPointerDown}
      className={cn("relative min-h-[60vh] select-none", className)}
    >
      {/* Positioned imperatively by the selection hook during a drag (no
          re-render per pointermove); hidden when idle. */}
      <div
        ref={marqueeRef}
        className="pointer-events-none absolute z-20 hidden rounded-sm border border-primary bg-primary/10"
      />
      {children}
    </div>
  );
}

type Modifiers = { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };

/**
 * What makes an element part of the selection: the marquee's hit-test target,
 * and modifier-click instead of whatever a plain click does. Spread on a card
 * wrapper or straight onto a table row.
 */
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
      // A menu or dialog this row opened is portalled out of its DOM but not out
      // of its React tree (see lib/portal-event-scope.ts).
      if (!e.currentTarget.contains(e.target as Node)) return;
      if (!(e.metaKey || e.ctrlKey || e.shiftKey)) return;
      if ((e.target as HTMLElement).closest?.("[data-card-actions]")) return;
      e.preventDefault();
      e.stopPropagation();
      onSelect(e);
    },
  };
}

/** A card wrapper carrying {@link selectableProps} and the highlight. */
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

/**
 * The bulk-actions bar: it floats at the bottom of the viewport whenever one or
 * more items are selected. `children` are this list's own actions.
 */
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
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
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

/** Page-scoped shortcuts: ⌘/Ctrl+A selects all, Esc clears, Delete removes. */
export function useSelectionShortcuts({
  count,
  selectAll,
  clear,
  onDelete,
}: {
  count: number;
  selectAll: () => void;
  clear: () => void;
  /** Omit when the viewer may not delete - Delete then does nothing. */
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
