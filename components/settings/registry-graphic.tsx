// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The Registries empty-state illustration: a whale afloat with its containers, breathing. */
export function RegistryGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A whale floating with a stack of containers on its back"
      className={cn("size-32", className)}
    >
      <g className="stroke-border" strokeWidth="2.5" strokeLinecap="round">
        <line x1="20" y1="74" x2="58" y2="74" />
        <line x1="66" y1="74" x2="100" y2="74" />
        <line x1="34" y1="82" x2="62" y2="82" />
        <line x1="70" y1="82" x2="88" y2="82" />
      </g>

      <g className="deplo-registry-whale">
        <g fill="var(--chart-1)">
          <circle
            className="deplo-registry-puff"
            cx="86"
            cy="38"
            r="3"
            opacity="0"
          />
          <circle
            className="deplo-registry-puff"
            cx="86"
            cy="38"
            r="2"
            opacity="0"
          />
        </g>

        <path d="M32 53 L16 43 L16 63 Z" fill="var(--chart-1)" />
        <rect
          x="30"
          y="42"
          width="62"
          height="22"
          rx="11"
          fill="var(--chart-1)"
        />
        <circle cx="84" cy="51" r="2" className="fill-card" />

        <g
          className="fill-card"
          stroke="var(--chart-1)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        >
          {[40, 54, 68].map((x) => (
            <rect key={x} x={x} y="32" width="12" height="11" rx="2" />
          ))}
          {[47, 61].map((x) => (
            <rect key={x} x={x} y="21" width="12" height="11" rx="2" />
          ))}
        </g>
      </g>
    </svg>
  );
}
