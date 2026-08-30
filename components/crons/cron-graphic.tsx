// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The Cron jobs empty-state illustration: a dial with a hand sweeping round it, firing the job every time it crosses the top mark. */
export function CronGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label="A clock hand sweeping round a dial, firing a job each time it passes the top mark"
      className={cn("size-32", className)}
    >
      <circle
        cx="60"
        cy="60"
        r="42"
        className="stroke-ring"
        strokeWidth="2.5"
      />

      <g className="stroke-border" strokeWidth="2" strokeLinecap="round">
        <line x1="93" y1="60" x2="100" y2="60" />
        <line x1="60" y1="93" x2="60" y2="100" />
        <line x1="27" y1="60" x2="20" y2="60" />
      </g>

      <circle
        cx="60"
        cy="18"
        r="5"
        className="deplo-cron-pulse"
        stroke="var(--success)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />

      <line
        x1="60"
        y1="60"
        x2="60"
        y2="32"
        className="deplo-cron-hand stroke-primary"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="60" cy="60" r="3" className="fill-primary" />

      <circle
        cx="60"
        cy="18"
        r="5"
        className="deplo-cron-fire"
        fill="var(--success)"
      />
    </svg>
  );
}
