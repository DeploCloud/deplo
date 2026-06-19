"use client";

import * as React from "react";
import { Cpu, MemoryStick, HardDrive } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { gql } from "@/lib/graphql-client";
import type { ServerMetrics } from "@/lib/data/monitoring";

/** Poll cadence. The collector itself takes ~1.2s, so ticks may overlap; the
 *  in-flight guard below skips a tick whenever the previous call is still
 *  running, so requests never stack up at this cadence. */
const POLL_MS = 1000;

/** Fallback metric values served from the server component for a single card,
 *  used before the first client poll resolves and for remote servers that have
 *  no live data (keeps SSR/CSR markup identical — no hydration mismatch). */
export interface MetricFallback {
  cpu: number;
  memPct: number;
  diskPct: number;
}

function usageTone(value: number): string | undefined {
  if (value >= 90) return "bg-destructive";
  if (value >= 75) return "bg-[var(--warning)]";
  return undefined;
}

function Metric({
  icon: Icon,
  label,
  value,
  caption,
}: {
  icon: typeof Cpu;
  label: string;
  value: number;
  caption: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Icon className="size-4" />
          {label}
        </span>
        <span className="font-mono tabular-nums">{value}%</span>
      </div>
      <Progress value={value} indicatorClassName={usageTone(value)} />
      <p className="text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}

type MetricsMap = Record<string, ServerMetrics>;

const MetricsContext = React.createContext<MetricsMap>({});

/** Single poll loop for the whole grid. Mounted once at page level, it polls
 *  the allServerMetrics query every second (skipping a tick while one is still
 *  in flight) and publishes a serverId -> ServerMetrics map through context. The
 *  map is expected to be exhaustive: allServerMetrics covers every server. */
export function ServerMetricsProvider({
  initialMetrics,
  children,
}: {
  initialMetrics: ServerMetrics[];
  children: React.ReactNode;
}) {
  const [metrics, setMetrics] = React.useState<MetricsMap>(() =>
    Object.fromEntries(initialMetrics.map((m) => [m.serverId, m])),
  );

  React.useEffect(() => {
    let active = true;
    let busy = false;

    async function tick() {
      if (busy) return; // previous ~1.2s call still running — skip this tick
      busy = true;
      try {
        const data = await gql<{ allServerMetrics: ServerMetrics[] }>(
          `query { allServerMetrics { serverId online cpu memPct diskPct } }`,
        );
        if (!active || !data.allServerMetrics) return;
        setMetrics(
          Object.fromEntries(
            data.allServerMetrics.map((m) => [m.serverId, m]),
          ),
        );
      } catch {
        // a failed poll just skips this tick — the next one tries again
      } finally {
        busy = false;
      }
    }

    const iv = setInterval(tick, POLL_MS);
    tick();
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, []);

  return (
    <MetricsContext.Provider value={metrics}>
      {children}
    </MetricsContext.Provider>
  );
}

/** Per-card consumer. Reads its own server's live metrics from context and
 *  falls back to the server-rendered values until the first poll resolves. */
export function LiveServerMetrics({
  serverId,
  fallback,
  cpuCores,
  memoryGb,
  diskGb,
}: {
  serverId: string;
  fallback: MetricFallback;
  cpuCores: number;
  memoryGb: number;
  diskGb: number;
}) {
  const map = React.useContext(MetricsContext);
  const metrics = map[serverId];

  if (metrics && !metrics.online) {
    return (
      <p className="text-sm text-muted-foreground">
        No live metrics — remote servers report usage once an agent is
        installed.
      </p>
    );
  }

  return (
    <>
      <Metric
        icon={Cpu}
        label="CPU"
        value={metrics?.cpu ?? fallback.cpu}
        caption={`${cpuCores} cores`}
      />
      <Metric
        icon={MemoryStick}
        label="Memory"
        value={metrics?.memPct ?? fallback.memPct}
        caption={`${memoryGb} GB RAM`}
      />
      <Metric
        icon={HardDrive}
        label="Disk"
        value={metrics?.diskPct ?? fallback.diskPct}
        caption={`${diskGb} GB disk`}
      />
    </>
  );
}
