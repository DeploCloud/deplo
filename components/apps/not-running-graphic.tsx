// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The "app is not running" empty-state illustration: a plug hanging out of its socket, swinging slowly, dipping towards the socket and never going in. */
export function NotRunningGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A plug hanging unplugged above its socket"
      className={cn("size-32", className)}
    >
      <line
        x1="8"
        y1="86"
        x2="112"
        y2="86"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <g className="stroke-ring" strokeWidth="2.5">
        <rect x="42" y="65" width="36" height="18" rx="4.5" />
        <g strokeLinecap="round">
          <line x1="54" y1="69" x2="54" y2="75.5" />
          <line x1="66" y1="69" x2="66" y2="75.5" />
        </g>
      </g>
      <circle cx="60" cy="79.5" r="2" className="fill-ring" />

      <g className="deplo-plug-sway">
        <g className="deplo-plug-dip">
          <g
            className="stroke-muted-foreground"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <path d="M40 5 C55 7, 65 19, 60 34" />

            <rect x="49" y="34" width="22" height="17" rx="4" />

            <line x1="54" y1="51" x2="54" y2="58" />
            <line x1="66" y1="51" x2="66" y2="58" />
          </g>

          <line
            x1="49"
            y1="43"
            x2="71"
            y2="43"
            className="stroke-muted-foreground"
            strokeWidth="2"
          />
        </g>
      </g>
    </svg>
  );
}
