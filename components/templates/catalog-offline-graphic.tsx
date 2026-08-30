// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The "catalog unreachable" illustration: a request leaving this instance, climbing toward the template service, and dying at a broken link. */
export function CatalogOfflineGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label="A request rising from this instance toward the template catalog and stopping at a broken connection"
      className={cn("size-32", className)}
    >
      <path
        className="deplo-offline-cloud stroke-destructive/80"
        d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"
        transform="translate(28.8 -7) scale(2.6)"
        strokeWidth="2.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />

      <g
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="2 6"
      >
        <line x1="60" y1="44" x2="60" y2="54" />
        <line x1="60" y1="72" x2="60" y2="92" />
      </g>

      <g className="stroke-ring" strokeWidth="2.5">
        <rect x="38" y="96" width="44" height="20" rx="5" />
        <line x1="46" y1="106" x2="46" y2="106" strokeLinecap="round" />
      </g>

      <rect
        className="deplo-offline-packet fill-destructive"
        x="56"
        y="74"
        width="8"
        height="8"
        rx="2"
      />

      <g
        className="deplo-offline-break stroke-destructive"
        strokeWidth="3.5"
        strokeLinecap="round"
      >
        <line x1="52" y1="55" x2="68" y2="71" />
        <line x1="68" y1="55" x2="52" y2="71" />
      </g>
    </svg>
  );
}
