"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { areaPath, linePath, type XY } from "@/lib/monitoring/chart-geometry";
import { cn } from "@/lib/utils";

/**
 * A trace with no axes, no grid and no tooltip - the shape beside a number, not a
 * chart. Fewer than two points draws nothing: the row says "No data" instead of
 * showing a flat line at zero, which reads as an idle host rather than an
 * unmeasured one.
 */
export function Sparkline({
  values,
  width = 72,
  height = 22,
  color = "var(--chart-1)",
  ariaLabel,
  className,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  color?: string;
  ariaLabel: string;
  className?: string;
}) {
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gradId = `spark-${uid}`;
  if (values.length < 2) return null;

  // Zero-based, so the trace reads as magnitude rather than as the wiggle a
  // min-max scale would blow up out of a flat 2% line.
  const max = Math.max(...values, 1e-9);
  const pts: XY[] = values.map((v, i) => ({
    x: (i / (values.length - 1)) * width,
    y: height - (Math.max(0, v) / max) * (height - 2) - 1,
  }));

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("shrink-0", className)}
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath(pts, height)} fill={`url(#${gradId})`} />
      <path
        d={linePath(pts)}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
