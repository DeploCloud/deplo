// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The Logs empty-state illustration: an empty pane with a blinking caret, into which log lines arrive one after another before the buffer clears and waits again. */
export function LogsGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="An empty log pane filling with lines of output, one after another"
      className={cn("size-32", className)}
    >
      <rect
        x="10"
        y="14"
        width="100"
        height="62"
        rx="5"
        className="stroke-ring"
        strokeWidth="2"
      />
      <line
        x1="10"
        y1="28"
        x2="110"
        y2="28"
        className="stroke-ring"
        strokeWidth="2"
      />

      <g className="fill-border">
        <circle cx="18" cy="21" r="2" />
        <circle cx="25" cy="21" r="2" />
        <circle cx="32" cy="21" r="2" />
      </g>

      <g
        className="stroke-muted-foreground"
        strokeWidth="3"
        strokeLinecap="round"
      >
        <line className="deplo-logs-line" x1="20" y1="38" x2="76" y2="38" />
        <line className="deplo-logs-line" x1="20" y1="48" x2="94" y2="48" />
        <line className="deplo-logs-line" x1="20" y1="58" x2="62" y2="58" />
      </g>

      <line
        className="deplo-logs-caret stroke-muted-foreground"
        x1="20"
        y1="34"
        x2="20"
        y2="42"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
