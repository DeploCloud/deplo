"use client";

import * as React from "react";
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Network,
  Clock,
  Boxes,
  Gauge,
  ServerOff,
  ArrowDown,
  ArrowUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/shared/status-badge";
import { serverMetricsAction } from "@/lib/actions/monitoring";
import type { ServerMetrics } from "@/lib/data/monitoring";
import type { ServerStatus } from "@/lib/types";
import { cn, formatBytes, serverLabel } from "@/lib/utils";

interface ServerLite {
  id: string;
  name: string;
  type: "localhost" | "remote";
  status: ServerStatus;
  ip: string;
  dockerVersion: string;
}

/** How long the live charts look back (samples). At 2s/sample ~80s window. */
const MAX_POINTS = 40;
const POLL_MS = 2000;

export function MonitoringDashboard({
  servers,
  initialMetrics,
}: {
  servers: ServerLite[];
  initialMetrics: ServerMetrics[];
}) {
  const [selectedId, setSelectedId] = React.useState(servers[0]?.id ?? "");
  const [history, setHistory] = React.useState<Record<string, ServerMetrics[]>>(
    () => Object.fromEntries(initialMetrics.map((m) => [m.serverId, [m]])),
  );

  const selected = servers.find((s) => s.id === selectedId) ?? servers[0];
  const online = selected?.status === "online";

  // Poll the selected server while it is online; append to its rolling buffer.
  React.useEffect(() => {
    if (!selectedId || !online) return;
    let active = true;

    async function tick() {
      const res = await serverMetricsAction(selectedId);
      if (!active || !res.ok || !res.data) return;
      const sample = res.data;
      setHistory((h) => {
        const prev = h[selectedId] ?? [];
        return { ...h, [selectedId]: [...prev, sample].slice(-MAX_POINTS) };
      });
    }

    const iv = setInterval(tick, POLL_MS);
    tick();
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [selectedId, online]);

  const samples = history[selectedId] ?? [];
  const cur =
    samples[samples.length - 1] ??
    initialMetrics.find((m) => m.serverId === selectedId) ??
    null;

  return (
    <div className="space-y-6">
      {/* Server selector */}
      <div className="flex flex-wrap gap-2">
        {servers.map((s) => {
          // Compare against the resolved `selected` (which falls back to the
          // first server) so the highlight always matches the data on screen.
          const active = s.id === selected?.id;
          return (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                active
                  ? "border-foreground/30 bg-secondary"
                  : "border-border hover:bg-accent/50",
              )}
            >
              <StatusDot status={s.status} />
              <span className="font-medium">{serverLabel(s)}</span>
              <Badge variant={s.type === "localhost" ? "default" : "secondary"}>
                {s.type === "localhost" ? "master" : "remote"}
              </Badge>
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                {s.ip}
              </span>
            </button>
          );
        })}
      </div>

      {!online || !cur ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <ServerOff className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">No live metrics</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              {selected?.status === "provisioning"
                ? "This server is still provisioning. Metrics appear once the agent is online."
                : "This server is offline. Metrics resume when it reconnects."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Live status line */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--success)] opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-[var(--success)]" />
            </span>
            Live · sampling every {POLL_MS / 1000}s
          </div>

          {/* Current-value tiles */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              icon={Cpu}
              label="CPU"
              value={`${cur.cpu.toFixed(1)}%`}
              sub={`${cur.cpuCores} cores · load ${cur.load[0].toFixed(2)}`}
              pct={cur.cpu}
            />
            <StatTile
              icon={MemoryStick}
              label="Memory"
              value={`${cur.memPct.toFixed(1)}%`}
              sub={`${formatBytes(cur.memUsed)} / ${formatBytes(cur.memTotal)}`}
              pct={cur.memPct}
            />
            <StatTile
              icon={HardDrive}
              label="Disk"
              value={`${cur.diskPct.toFixed(1)}%`}
              sub={`${formatBytes(cur.diskUsed)} / ${formatBytes(cur.diskTotal)}`}
              pct={cur.diskPct}
            />
            <Card>
              <CardContent className="space-y-1.5 p-4">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Network className="size-4" />
                  <span className="text-xs">Network</span>
                </div>
                <div className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
                  <ArrowDown className="size-4 text-[var(--success)]" />
                  {formatBytes(cur.netRx)}/s
                </div>
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <ArrowUp className="size-4" />
                  {formatBytes(cur.netTx)}/s
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Real-time charts */}
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="CPU usage" caption={`${cur.cpu.toFixed(1)}%`}>
              <Spark
                series={[
                  {
                    values: samples.map((s) => s.cpu),
                    stroke: "stroke-foreground",
                    fill: "fill-foreground/10",
                  },
                ]}
                max={100}
              />
            </ChartCard>

            <ChartCard title="Memory usage" caption={`${cur.memPct.toFixed(1)}%`}>
              <Spark
                series={[
                  {
                    values: samples.map((s) => s.memPct),
                    stroke: "stroke-foreground",
                    fill: "fill-foreground/10",
                  },
                ]}
                max={100}
              />
            </ChartCard>

            <ChartCard
              title="Network I/O"
              caption={`↓ ${formatBytes(cur.netRx)}/s · ↑ ${formatBytes(cur.netTx)}/s`}
              className="lg:col-span-2"
            >
              <Spark
                series={[
                  {
                    values: samples.map((s) => s.netRx),
                    stroke: "stroke-[var(--success)]",
                  },
                  {
                    values: samples.map((s) => s.netTx),
                    stroke: "stroke-muted-foreground",
                  },
                ]}
                max={Math.max(
                  ...samples.flatMap((s) => [s.netRx, s.netTx]),
                  1,
                )}
              />
            </ChartCard>
          </div>

          {/* Info strip */}
          <Card>
            <CardContent className="grid grid-cols-2 gap-4 py-4 sm:grid-cols-4">
              <InfoItem icon={Clock} label="Uptime" value={fmtUptime(cur.uptimeSec)} />
              <InfoItem icon={Boxes} label="Containers" value={`${cur.containers}`} />
              <InfoItem
                icon={Gauge}
                label="Load (1/5/15m)"
                value={cur.load.map((l) => l.toFixed(2)).join(" / ")}
              />
              <InfoItem
                icon={Cpu}
                label="Docker"
                value={selected.dockerVersion || "—"}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  pct,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  sub: string;
  pct: number;
}) {
  const over = pct > 80;
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="size-4" />
          <span className="text-xs">{label}</span>
        </div>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              over ? "bg-[var(--warning)]" : "bg-foreground/80",
            )}
            style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

function ChartCard({
  title,
  caption,
  className,
  children,
}: {
  title: string;
  caption: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{caption}</p>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function InfoItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Cpu;
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

/** Inline multi-series SVG chart. The first series may render a gradient area. */
function Spark({
  series,
  max,
}: {
  series: { values: number[]; stroke: string; fill?: string }[];
  max: number;
}) {
  const W = 600;
  const H = 140;
  const pad = 4;
  const n = Math.max(...series.map((s) => s.values.length), 1);
  const stepX = n > 1 ? (W - pad * 2) / (n - 1) : 0;
  const yOf = (v: number) =>
    pad + (H - pad * 2) * (1 - Math.min(v, max) / (max || 1));

  if (n <= 1) {
    return <div className="h-32 w-full rounded-lg bg-secondary/40" />;
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-32 w-full text-foreground"
      role="img"
      aria-label="Live metric chart"
    >
      {series.map((s, si) => {
        if (s.values.length === 0) return null;
        const coords = s.values.map(
          (v, i) => [pad + i * stepX, yOf(v)] as const,
        );
        const line = coords.map(([x, y]) => `${x},${y}`).join(" ");
        const area = s.fill
          ? `M ${coords[0][0]},${H} L ${coords
              .map(([x, y]) => `${x},${y}`)
              .join(" L ")} L ${coords[coords.length - 1][0]},${H} Z`
          : null;
        return (
          <g key={si}>
            {area && <path d={area} className={s.fill} />}
            <polyline
              points={line}
              fill="none"
              className={s.stroke}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </svg>
  );
}

function fmtUptime(sec: number): string {
  if (sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
