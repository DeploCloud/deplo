"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { arcPath, gaugeFraction } from "@/lib/monitoring/chart-geometry";

const START_DEG = -120;
const SWEEP_DEG = 240;
const WARN_AT = 0.8;

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
  value: number;
  full: number;
  display: string;
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
          <p className="text-2xl font-semibold tracking-tight">{display}</p>
          <p className="truncate text-xs text-muted-foreground">{caption}</p>
        </div>
      </CardContent>
    </Card>
  );
}
