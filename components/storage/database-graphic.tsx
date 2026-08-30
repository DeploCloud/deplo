// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The Databases empty-state illustration: the outline of a database that is not there, and a tumbleweed bouncing through the space where it would be. */
export function DatabaseGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="The dashed outline of a database with a tumbleweed bouncing past it"
      className={cn("size-32", className)}
    >
      <line
        x1="8"
        y1="70"
        x2="112"
        y2="70"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <g className="stroke-ring" strokeWidth="2" strokeDasharray="5 4">
        <ellipse cx="60" cy="40" rx="16" ry="5.5" />
        <path d="M44 40 L44 64.5" />
        <path d="M76 40 L76 64.5" />
        <path d="M44 64.5 A16 5.5 0 0 0 76 64.5" />
        <path d="M44 52 A16 5.5 0 0 0 76 52" />
      </g>

      <g transform="translate(-24 61)">
        <g className="deplo-db-roll">
          <g className="deplo-db-hop">
            <g
              className="deplo-db-spin"
              stroke="var(--chart-4)"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path
                d="M10.5 0 L6 6 L0 10.5 L-6.7 6.7 L-10.5 0 L-5.5 -5.5 L0 -10.5 L7.1 -7.1 Z"
                strokeWidth="1.75"
              />
              <g strokeWidth="1.5">
                <path d="M-9 -3 L8 4" />
                <path d="M-4 -9 L5 8" />
                <path d="M-8 5 L9 -2" />
                <path d="M2 -9 L-3 9" />
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
