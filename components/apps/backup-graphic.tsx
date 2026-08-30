// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The Backup artifacts empty-state illustration: copies landing on a shelf, one after another, building the stack the list will show. */
export function BackupGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="Copies landing one after another on a shelf, building a stack"
      className={cn("size-32", className)}
    >
      <line
        x1="22"
        y1="70"
        x2="98"
        y2="70"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <g fill="var(--chart-3)">
        <rect
          x="30"
          y="58"
          width="60"
          height="12"
          rx="3"
          className="deplo-backup-slab"
          fillOpacity="0.5"
        />
        <rect
          x="30"
          y="44"
          width="60"
          height="12"
          rx="3"
          className="deplo-backup-slab"
          fillOpacity="0.75"
        />
        <rect
          x="30"
          y="30"
          width="60"
          height="12"
          rx="3"
          className="deplo-backup-slab"
        />
      </g>
    </svg>
  );
}
