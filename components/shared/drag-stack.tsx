// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/**
 * The lifted card that follows the cursor. A multi-selection drag stacks a
 * couple of card-shaped layers behind it and badges the count, so the whole
 * block reads as moving together, not just the card the drag started from.
 */
export function DragStack({
  count,
  className,
  children,
}: {
  /** How many cards move together (1 = a plain single-card drag). */
  count: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none relative rotate-[1.5deg] cursor-grabbing",
        className,
      )}
    >
      {count > 2 && (
        <div
          aria-hidden
          className="absolute inset-0 translate-x-4 translate-y-4 rounded-xl border border-border bg-card shadow-lg"
        />
      )}
      {count > 1 && (
        <div
          aria-hidden
          className="absolute inset-0 translate-x-2 translate-y-2 rounded-xl border border-border bg-card shadow-lg"
        />
      )}
      <div className="relative rounded-xl shadow-2xl ring-1 ring-border/60">
        {children}
      </div>
      {count > 1 && (
        <span className="absolute -top-2 -right-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground shadow-md ring-2 ring-background">
          {count}
        </span>
      )}
    </div>
  );
}
