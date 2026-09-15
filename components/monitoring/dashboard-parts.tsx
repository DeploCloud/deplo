"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { GAP_MS } from "@/lib/monitoring/chart-gaps";
import { cn } from "@/lib/utils";

export const POLL_MS = 1000;

const MAX_POLL_MS = 10_000;

export function pollIntervalFor(timestamps: readonly number[]): number {
  const gaps: number[] = [];
  for (let i = Math.max(1, timestamps.length - 6); i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return POLL_MS;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (!Number.isFinite(median)) return POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(POLL_MS, Math.round(median / 2)));
}
export const STALE_AFTER_MS = GAP_MS;
export const MAX_POINTS = 1200;

export const WINDOWS = [
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
] as const;

export function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  info,
  pct,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: React.ReactNode;
  info?: React.ReactNode;
  pct?: number;
}) {
  const over = (pct ?? 0) > 80;
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="size-4" />
          <span className="text-xs">{label}</span>
          {info && <InfoTip content={info} side="top" />}
        </div>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        {pct !== undefined && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                over ? "bg-[var(--warning)]" : "bg-muted-foreground",
              )}
              style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

export function ChartCard({
  title,
  caption,
  className,
  children,
}: {
  title: string;
  caption?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm lg:text-sm">{title}</CardTitle>
        {caption && (
          <p className="text-xs text-muted-foreground tabular-nums">
            {caption}
          </p>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function InfoItem({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className="truncate font-mono text-sm tabular-nums">{value}</p>
    </div>
  );
}

export function WindowSelector({
  windowMs,
  onChange,
}: {
  windowMs: number;
  onChange: (ms: number) => void;
}) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border p-0.5"
      role="group"
      aria-label="Chart time window"
    >
      {WINDOWS.map((w) => (
        <button
          key={w.label}
          type="button"
          onClick={() => onChange(w.ms)}
          aria-pressed={windowMs === w.ms}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs transition-colors",
            windowMs === w.ms
              ? "bg-secondary font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Last {w.label}
        </button>
      ))}
    </div>
  );
}

export function LiveStatusLine({
  stale,
  asOf,
}: {
  stale: boolean;
  asOf: number;
}) {
  if (stale) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--warning)]">
        <span className="inline-flex size-2 rounded-full bg-[var(--warning)]" />
        Not answering - showing data up to {fmtClock(asOf)}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--success)] opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-[var(--success)]" />
      </span>
      Live · streaming
    </div>
  );
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
