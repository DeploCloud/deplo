// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The environment variables empty-state illustration: a variable being written into an empty list, its value scrambled, and the padlock clicking shut over what is left. */
export function EnvGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A variable being written into a list, its value scrambled and locked away masked"
      className={cn("size-32", className)}
    >
      <rect
        x="10"
        y="17"
        width="100"
        height="56"
        rx="10"
        className="stroke-ring"
        strokeWidth="2.5"
      />

      <g className="stroke-border" strokeWidth="2" strokeLinecap="round">
        <line x1="48" y1="41" x2="55" y2="41" />
        <line x1="48" y1="49" x2="55" y2="49" />
      </g>

      <line
        x1="20"
        y1="45"
        x2="40"
        y2="45"
        className="deplo-env-key"
        stroke="var(--info)"
        strokeWidth="6"
        strokeLinecap="round"
      />

      <g stroke="var(--info)" strokeWidth="4.5" strokeLinecap="round">
        <line className="deplo-env-plain" x1="62" y1="41.5" x2="62" y2="48.5" />
        <line className="deplo-env-plain" x1="71" y1="43" x2="71" y2="47" />
        <line className="deplo-env-plain" x1="80" y1="40.5" x2="80" y2="49.5" />
        <line className="deplo-env-plain" x1="89" y1="42.5" x2="89" y2="47.5" />
      </g>

      <g fill="var(--info)" fillOpacity="0.7">
        <circle cx="62" cy="45" r="3" className="deplo-env-dot" />
        <circle cx="71" cy="45" r="3" className="deplo-env-dot" />
        <circle cx="80" cy="45" r="3" className="deplo-env-dot" />
        <circle cx="89" cy="45" r="3" className="deplo-env-dot" />
      </g>

      <g className="deplo-env-lock">
        <rect
          x="95.5"
          y="43.5"
          width="9"
          height="9"
          rx="2"
          fill="var(--info)"
          fillOpacity="0.7"
        />
        <path
          d="M97.5 43.5 V40 A2.5 2.5 0 0 1 102.5 40 V43.5"
          className="deplo-env-shackle"
          stroke="var(--info)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
