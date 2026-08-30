// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The Shared variables empty-state illustration: one definition at the top, streaming down three branches into three apps that light up as it lands. */
export function SharedVarsGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="One shared variable streaming down into three apps at once"
      className={cn("size-32", className)}
    >
      <rect
        x="42"
        y="6"
        width="36"
        height="20"
        rx="5"
        stroke="var(--violet)"
        strokeWidth="2"
      />
      <line
        x1="48"
        y1="16"
        x2="58"
        y2="16"
        stroke="var(--violet)"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <g fill="var(--violet)" fillOpacity="0.65">
        <circle cx="65" cy="16" r="2" />
        <circle cx="71" cy="16" r="2" />
      </g>

      <g
        className="deplo-svars-flow"
        stroke="var(--violet)"
        strokeWidth="2"
        strokeOpacity="0.6"
      >
        <path d="M60 28 C60 48 21 46 21 62" />
        <path d="M60 28 V62" />
        <path d="M60 28 C60 48 99 46 99 62" />
      </g>

      <g strokeWidth="2" className="stroke-ring">
        <rect x="8" y="62" width="26" height="20" rx="4" />
        <rect x="47" y="62" width="26" height="20" rx="4" />
        <rect x="86" y="62" width="26" height="20" rx="4" />
      </g>

      <g fill="var(--violet)">
        <circle className="deplo-svars-dot" cx="21" cy="72" r="3.5" />
        <circle className="deplo-svars-dot" cx="60" cy="72" r="3.5" />
        <circle className="deplo-svars-dot" cx="99" cy="72" r="3.5" />
      </g>
    </svg>
  );
}
