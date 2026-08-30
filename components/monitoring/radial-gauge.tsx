"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { arcPath, gaugeFraction } from "@/lib/monitoring/chart-geometry";

/** The sweep: 240 degrees, opening at the bottom so the caption sits in the gap. */
const START_DEG = -120;
const SWEEP_DEG = 240;
/** Same threshold as the old saturation bar - past it the whole arc goes amber. */
const WARN_AT = 0.8;

/**
 * A saturation reading against an honest ceiling. `full` is the ceiling the number
 * is really measured against - a configured cap, or the whole machine when there
 * is none - and `caption` says what that ceiling is in real units.
 */
export function RadialGauge({
  value,
  full,
  size = 92,
  color = "var(--chart-1)",
  ariaLabel,
}: {
  value: number;
  full: number;
  size?: number;
  color?: string;
  ariaLabel: string;
}) {
  const frac = gaugeFraction(value, full);
  const over = frac >= WARN_AT;
  const stroke = over ? "var(--warning)" : color;

  const r = size / 2 - 7;
  const c = size / 2;
  const track = arcPath(c, c, r, START_DEG, START_DEG + SWEEP_DEG);
  const fill = arcPath(c, c, r, START_DEG, START_DEG + SWEEP_DEG * frac);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
      role="img"
      aria-label={ariaLabel}
    >
      {/* The unfilled track has to be visible or the ceiling is invisible too -
          `--secondary` is one step off the card in dark and disappears. */}
      <path
        d={track}
        fill="none"
        className="stroke-border"
        strokeWidth={7}
        strokeLinecap="round"
      />
      {frac > 0 && (
        <path
          d={fill}
          fill="none"
          stroke={stroke}
          strokeWidth={7}
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/**
 * The gauge in a card: arc on the left, reading on the right. The number is always
 * text, so nothing here is carried by colour alone.
 */
export function GaugeTile({
  icon: Icon,
  label,
  value,
  full,
  display,
  caption,
  info,
  color,
}: {
  icon: LucideIcon;
  label: string;
  /** The raw reading. */
  value: number;
  /** The ceiling it is measured against - see RadialGauge. */
  full: number;
  /** The reading as a person says it ("34%"). */
  display: string;
  /** What the ceiling is, in real units ("2.99 of 8 cores"). */
  caption: React.ReactNode;
  info?: React.ReactNode;
  color?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <RadialGauge
          value={value}
          full={full}
          color={color}
          ariaLabel={`${label}: ${display}`}
        />
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Icon className="size-4" />
            <span className="text-xs">{label}</span>
            {info && <InfoTip content={info} side="top" />}
          </div>
          {/* Proportional figures: tabular-nums makes a big standalone number
              look loose. */}
          <p className="text-2xl font-semibold tracking-tight">{display}</p>
          <p className="truncate text-xs text-muted-foreground">{caption}</p>
        </div>
      </CardContent>
    </Card>
  );
}
