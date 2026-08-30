// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The monitoring empty-state illustration: a trace drawing itself across a panel, lighting its live edge when it lands, then clearing and starting over. */
export function MonitoringGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A chart drawing a line across an empty panel, waiting for the first measurements"
      className={cn("size-32", className)}
    >
      <rect
        x="14"
        y="14"
        width="92"
        height="58"
        rx="4"
        className="stroke-ring"
        strokeWidth="2"
      />

      <g className="stroke-border" strokeWidth="2" strokeLinecap="round">
        <line x1="20" y1="33" x2="100" y2="33" />
        <line x1="20" y1="52" x2="100" y2="52" />
      </g>

      <path
        d="M22 60 L31 52 L39 56 L48 40 L57 46 L66 34 L74 38 L83 28 L92 32"
        className="deplo-metrics-trace"
        stroke="var(--chart-1)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <circle
        cx="92"
        cy="32"
        r="5"
        className="deplo-metrics-halo"
        stroke="var(--chart-1)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx="92"
        cy="32"
        r="3.5"
        className="deplo-metrics-live"
        fill="var(--chart-1)"
      />
    </svg>
  );
}
