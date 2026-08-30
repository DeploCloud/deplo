// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@/components/ui/skeleton";

// Widths of the placeholder prompt lines, in terminal order: a couple of
// commands and their output, then the caret line.
const LINES = ["w-52", "w-2/3", "w-1/3", "w-44", "w-3/4", "w-1/2", "w-24"];

/**
 * The console route's loading frame, at the size the real pane will be. Shared
 * by the App and database routes, which render the same pane.
 */
export function ConsoleSkeleton({ label }: { label: string }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      role="status"
      aria-busy
      aria-label={label}
    >
      {/* Toolbar: name, container picker, status, shell picker, Shell/Attach,
          and the three actions on the right. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
        <Skeleton className="size-4" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-9 w-32 rounded-md" />
        <Skeleton className="h-4 w-16 rounded-full" />
        <Skeleton className="h-9 w-24 rounded-md" />
        <Skeleton className="h-9 w-40 rounded-lg" />
        <div className="ml-auto flex items-center gap-1">
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="size-9 rounded-md" />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-hidden bg-terminal p-3">
        {LINES.map((w, i) => (
          <Skeleton shimmer key={i} className={`h-4 ${w}`} />
        ))}
      </div>
    </div>
  );
}
