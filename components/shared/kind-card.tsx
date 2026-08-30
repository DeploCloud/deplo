"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * One option as a compact card - icon and title on one line, a caption under it,
 * selection carried by the border and a tint.
 */
export function KindCard({
  selected,
  onSelect,
  icon,
  title,
  caption,
  badge,
  disabled = false,
  disabledNote,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  caption: string;
  badge?: React.ReactNode;
  disabled?: boolean;
  /** Shown instead of the caption while disabled - say WHY, not that it is off. */
  disabledNote?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent/40",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
        selected && "border-primary bg-primary/[0.06] ring-1 ring-primary/60",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
        {badge}
      </span>
      <span className="mt-1 block text-xs text-muted-foreground">
        {disabled && disabledNote ? disabledNote : caption}
      </span>
    </button>
  );
}
