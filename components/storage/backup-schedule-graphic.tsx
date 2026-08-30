// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The scheduled backups empty-state illustration: a loop closing around an archive, over and over. */
export function BackupScheduleGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="An arrow looping round an archive, closing and starting again"
      className={cn("size-32", className)}
    >
      <g
        className="stroke-border"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="46" y="34" width="28" height="22" rx="3" />
        <path d="M46 42 L74 42" />
        <path d="M56 49 L64 49" />
      </g>

      <path
        d="M60 15 A30 30 0 1 1 34.02 30"
        className="deplo-bk-loop"
        stroke="var(--chart-1)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <path
        d="M34.02 37 L34.02 30 L27.96 33.5"
        className="deplo-bk-arrow"
        stroke="var(--chart-1)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
