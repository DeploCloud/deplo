"use client";

import * as React from "react";
import {
  ArrowDownUp,
  Cpu,
  HardDrive,
  MemoryStick,
  type LucideIcon,
} from "lucide-react";
import { Sparkline } from "@/components/monitoring/sparkline";
import { SlidingButtonGroup } from "@/components/ui/sliding-button-group";
import { Bone } from "@/components/ui/skeleton";
import type { ServerMetrics } from "@/lib/data/monitoring";
import { cn, friendlyBytes } from "@/lib/utils";

export type Metric = "cpu" | "memory" | "disk" | "network";

export const METRICS: Record<
  Metric,
  { label: string; icon: LucideIcon; color: string }
> = {
  cpu: { label: "CPU", icon: Cpu, color: "var(--chart-1)" },
  memory: { label: "Memory", icon: MemoryStick, color: "var(--violet)" },
  disk: { label: "Disk", icon: HardDrive, color: "var(--chart-4)" },
  network: { label: "Network", icon: ArrowDownUp, color: "var(--chart-5)" },
};

const ORDER = Object.keys(METRICS) as Metric[];

export const METRIC_SERIES: Record<
  Metric,
  { key: string; label: string; color: string; fill?: boolean }[]
> = {
  cpu: [{ key: "cpu", label: "CPU", color: METRICS.cpu.color, fill: true }],
  memory: [
    { key: "mem", label: "Memory", color: METRICS.memory.color, fill: true },
  ],
  disk: [{ key: "disk", label: "Disk", color: METRICS.disk.color, fill: true }],
  network: [
    { key: "rx", label: "Received", color: METRICS.network.color },
    { key: "tx", label: "Sent", color: "var(--chart-1)" },
  ],
};

const pct = (v: number) => `${Math.round(v)}%`;
const rate = (v: number) => `${friendlyBytes(v)}/s`;

export function metricValue(m: Metric, s: ServerMetrics): number {
  if (m === "cpu") return s.cpu;
  if (m === "memory") return s.memPct;
  if (m === "disk") return s.diskPct;
  return s.netRx + s.netTx;
}

export function formatMetric(m: Metric, v: number): string {
  return m === "network" ? rate(v) : pct(v);
}

export function MetricIcon({
  metric,
  className,
}: {
  metric: Metric;
  className?: string;
}) {
  const { icon: Icon, color } = METRICS[metric];
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md text-white",
        className,
      )}
      style={{ background: color }}
    >
      <Icon className="size-3.5" strokeWidth={2.25} />
    </span>
  );
}

// The four numbers are the chart's tabs: one chart, the metric you picked.
export function MetricTabs({
  active,
  onSelect,
  samples,
  loading = false,
}: {
  active: Metric;
  onSelect: (m: Metric) => void;
  samples: ServerMetrics[];
  loading?: boolean;
}) {
  const cur = samples[samples.length - 1];
  return (
    <SlidingButtonGroup
      aria-label="Metric"
      className="grid grid-cols-2 gap-1 rounded-xl p-1 lg:grid-cols-4"
    >
      {ORDER.map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={m === active}
          onClick={() => onSelect(m)}
          className="flex cursor-pointer flex-col gap-3 rounded-md px-4 pt-3.5 pb-3 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="flex items-center gap-2.5 text-sm font-medium">
            <MetricIcon metric={m} />
            {METRICS[m].label}
          </span>
          <span className="flex items-end justify-between gap-3">
            <Bone loading={loading}>
              <span className="text-[26px] leading-none font-semibold tracking-tight tabular-nums">
                {cur ? formatMetric(m, metricValue(m, cur)) : "12%"}
              </span>
            </Bone>
            {!loading && (
              <Sparkline
                values={samples.map((s) => metricValue(m, s))}
                width={96}
                height={28}
                color={METRICS[m].color}
                ariaLabel={`${METRICS[m].label} trend`}
                className="hidden sm:block"
              />
            )}
          </span>
        </button>
      ))}
    </SlidingButtonGroup>
  );
}

function headline(m: Metric, cur: ServerMetrics): [string, string] {
  if (m === "cpu") return [pct(cur.cpu), `busy across ${cur.cpuCores} cores`];
  if (m === "memory")
    return [
      friendlyBytes(cur.memUsed),
      `used of ${friendlyBytes(cur.memTotal)}`,
    ];
  if (m === "disk")
    return [
      friendlyBytes(cur.diskUsed),
      `used of ${friendlyBytes(cur.diskTotal)}`,
    ];
  return [rate(cur.netRx), `in · ${rate(cur.netTx)} out`];
}

function stats(m: Metric, window: ServerMetrics[]): [string, string][] {
  const cur = window[window.length - 1];
  const of = (f: (s: ServerMetrics) => number) => window.map(f);
  const peak = (xs: number[]) => Math.max(...xs);
  if (m === "cpu") {
    const cpu = of((s) => s.cpu);
    const avg = cpu.reduce((a, b) => a + b, 0) / cpu.length;
    return [
      ["Average", pct(avg)],
      ["Highest", pct(peak(cpu))],
      ["Cores", String(cur.cpuCores)],
    ];
  }
  if (m === "memory")
    return [
      ["Used", friendlyBytes(cur.memUsed)],
      ["Free", friendlyBytes(cur.memTotal - cur.memUsed)],
      ["Highest", pct(peak(of((s) => s.memPct)))],
    ];
  if (m === "disk")
    return [
      ["Used", friendlyBytes(cur.diskUsed)],
      ["Free", friendlyBytes(cur.diskTotal - cur.diskUsed)],
      ["Total", friendlyBytes(cur.diskTotal)],
    ];
  return [
    ["Received", rate(cur.netRx)],
    ["Sent", rate(cur.netTx)],
    ["Highest", rate(peak(of((s) => s.netRx + s.netTx)))],
  ];
}

// What the chart is about in one line above it, and three numbers under it.
export function MetricDetail({
  metric,
  window,
  chart,
  action,
}: {
  metric: Metric;
  window: ServerMetrics[];
  chart: React.ReactNode;
  action?: React.ReactNode;
}) {
  const cur = window[window.length - 1];
  const [lead, rest] = headline(metric, cur);
  return (
    <div className="space-y-4">
      <p className="text-sm">
        <span className="font-medium tabular-nums">{lead}</span>{" "}
        <span className="text-muted-foreground">{rest}</span>
      </p>
      {chart}
      <div className="flex flex-wrap items-center gap-y-3">
        {stats(metric, window).map(([label, value], i) => (
          <div
            key={label}
            className={cn("min-w-28 flex-1 pr-5", i > 0 && "border-l pl-5")}
          >
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                aria-hidden
                className="size-2 rounded-[3px]"
                style={{ background: METRICS[metric].color }}
              />
              {label}
            </p>
            <p className="mt-1 text-lg font-semibold tracking-tight tabular-nums">
              {value}
            </p>
          </div>
        ))}
        {action}
      </div>
    </div>
  );
}
