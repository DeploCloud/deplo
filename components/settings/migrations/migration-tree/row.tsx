"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";

// Column widths, shared by the header and every row so they line up.
const COL = {
  status: "w-32",
  build: "w-32",
  run: "w-36",
};

// Row is one line of the tree: a project, an environment or a service.
export function Row({
  id,
  depth,
  label,
  mark,
  meta,
  status,
  build,
  run,
  showBuild,
  expandable,
  expanded,
  onToggleExpand,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  depth: number;
  label: string;
  mark: React.ReactNode;
  meta?: React.ReactNode;
  status?: React.ReactNode;
  build?: React.ReactNode;
  run?: React.ReactNode;
  showBuild: boolean;
  expandable: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  checked: boolean | "indeterminate";
  disabled: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 py-2 pr-3",
        depth === 0 && "bg-surface",
      )}
      // Indent by depth rather than a class per level, exactly as the scope
      // picker does - the two trees have to line up visually.
      style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
    >
      {expandable ? (
        <button
          type="button"
          onClick={onToggleExpand}
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          aria-expanded={expanded}
          className="rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronRight
            className={cn(
              "size-4 transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>
      ) : (
        <span className="size-4" aria-hidden />
      )}
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onCheckedChange(v === true)}
      />
      <label
        htmlFor={id}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2",
          !disabled && "cursor-pointer",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {mark}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-sm",
              depth === 0 && "font-medium",
            )}
          >
            {label}
          </span>
          {meta && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {meta}
            </span>
          )}
        </span>
      </label>
      {/* Fixed-width cells on every row, empty ones included: the tree indents
          only on the left, so this is what keeps the columns a column. */}
      <div className={cn("flex shrink-0 items-center justify-end", COL.status)}>
        {status}
      </div>
      {showBuild && <div className={cn("shrink-0", COL.build)}>{build}</div>}
      <div className={cn("shrink-0", COL.run)}>{run}</div>
    </div>
  );
}
