// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The command palette's no-results illustration: a query typed into a panel whose floor has given way, its rows lying below. */
export function PaletteEmptyGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A command palette with a hole in its floor and its rows fallen through"
      className={cn("size-32", className)}
    >
      <line
        x1="12"
        y1="78"
        x2="108"
        y2="78"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <g
        className="stroke-ring"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* The panel, its floor open: this is where the rows went. */}
        <path d="M42 48 H32 A6 6 0 0 1 26 42 V14 A6 6 0 0 1 32 8 H88 A6 6 0 0 1 94 14 V42 A6 6 0 0 1 88 48 H64" />
        <path d="M26 26 H94" />
      </g>

      <g
        className="stroke-muted-foreground"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <path d="M35 17.5 H49" />
        <path d="M55 14 V21" />
      </g>

      <g className="stroke-ring" strokeWidth="3" strokeLinecap="round">
        <path d="M45 55 L67 58" />
        <path d="M34 66 L60 70" />
        <path d="M42 77.5 L76 77" />
      </g>
    </svg>
  );
}
