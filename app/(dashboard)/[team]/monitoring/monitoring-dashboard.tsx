"use client";

import * as React from "react";
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Network,
  ServerOff,
  ChevronsUpDown,
} from "lucide-react";
import { TimeSeriesChart } from "@/components/monitoring/time-series-chart";
import { MonitoringGraphic } from "@/components/monitoring/monitoring-graphic";
import { EmptyState } from "@/components/shared/empty-state";
import { FleetList, type FleetRow } from "@/components/monitoring/fleet-list";
import { CleanupNowButton } from "@/components/monitoring/cleanup-now-button";
import { ManageServerButton } from "@/components/monitoring/host-chip";
import { ServerPicker } from "@/components/monitoring/server-picker";
import { ServerWorkloads } from "@/components/servers/server-workloads";
import { PageHeader } from "@/components/shared/page-header";
import { Bone, Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  LiveStatusLine,
  MAX_POINTS,
  pollIntervalFor,
  STALE_AFTER_MS,
  WindowSelector,
  WINDOWS,
} from "@/components/monitoring/dashboard-parts";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerMetrics } from "@/lib/data/monitoring";
import type { ServerStatus } from "@/lib/types/server";
import type { AgentReach } from "@/lib/version";
import { cn, friendlyBytes, serverLabel } from "@/lib/utils";

interface ServerLite {
  id: string;
  name: string;
  status: ServerStatus;
  ip: string;
  dockerVersion: string;
  isDeploHost: boolean;
  agentReach: AgentReach;
}

const SERVER_FIELDS = `serverId online ts cpu cpuCores memUsed memTotal memPct
  memFree memCache diskUsed diskTotal diskPct netRx netTx load uptimeSec
  containers agentVersion expectedAgentVersion source`;
const FLEET_FIELDS = `serverId online ts cpu memPct diskPct containers
  agentVersion expectedAgentVersion source spark { ts cpu mem }`;

export function MonitoringDashboard({
  servers,
  initialHistory,
  initialFleet,
  canManageServers,
}: {
  servers: ServerLite[];
  initialHistory: ServerMetrics[];
  initialFleet: FleetRow[];
  canManageServers: boolean;
}) {
  const [selectedId, setSelectedId] = React.useState(servers[0]?.id ?? "");
  const [windowMs, setWindowMs] = React.useState<number>(WINDOWS[0].ms);
  const [history, setHistory] = React.useState<Record<string, ServerMetrics[]>>(
    () =>
      initialHistory.length && servers[0]
        ? { [servers[0].id]: initialHistory }
        : {},
  );
  const [fleet, setFleet] = React.useState<Record<string, FleetRow>>(() =>
    Object.fromEntries(initialFleet.map((r) => [r.serverId, r])),
  );
  const [now, setNow] = React.useState<number>(() => Date.now());
  const [metric, setMetric] = React.useState<Metric>("cpu");

  const selected = servers.find((s) => s.id === selectedId) ?? servers[0];
  const showFleet = servers.length > 1;
  const pollMs = React.useMemo(
    () => pollIntervalFor((history[selectedId] ?? []).map((x) => x.ts)),
    [history, selectedId],
  );
  const online = Boolean(selected) && selected.status !== "provisioning";

  React.useEffect(() => {
    if (!selectedId || !online) return;
    let active = true;
    let busy = false;
    const seed = async () => {
      setNow(Date.now());
      if (busy) return;
      busy = true;
      try {
        const res = await gqlAction<
          {
            serverMetricsHistory: ServerMetrics[];
            fleetMetrics?: FleetRow[];
          },
          { history: ServerMetrics[]; fleet: FleetRow[] }
        >(
          `query MonitoringTick($serverId: String!, $withFleet: Boolean!) {
            serverMetricsHistory(serverId: $serverId) { ${SERVER_FIELDS} }
            fleetMetrics @include(if: $withFleet) { ${FLEET_FIELDS} }
          }`,
          { serverId: selectedId, withFleet: showFleet },
          (d) => ({
            history: d.serverMetricsHistory,
            fleet: d.fleetMetrics ?? [],
          }),
        );
        if (!active || !res.ok || !res.data) return;
        if (res.data.fleet.length)
          setFleet(
            Object.fromEntries(res.data.fleet.map((r) => [r.serverId, r])),
          );
        const seeded = res.data.history;
        if (seeded.length === 0) return;
        setHistory((h) => {
          const prev = h[selectedId] ?? [];
          const byTs = new Map<number, ServerMetrics>();
          for (const s of [...prev, ...seeded]) byTs.set(s.ts, s);
          const merged = [...byTs.values()]
            .sort((a, b) => a.ts - b.ts)
            .slice(-MAX_POINTS);
          if (
            merged.length === prev.length &&
            merged[merged.length - 1]?.ts === prev[prev.length - 1]?.ts
          ) {
            return h;
          }
          return { ...h, [selectedId]: merged };
        });
      } finally {
        busy = false;
      }
    };
    void seed();
    const iv = setInterval(seed, pollMs);
    const onWake = () => {
      if (document.visibilityState !== "hidden") void seed();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      active = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [selectedId, online, pollMs, showFleet]);

  const samples = history[selectedId] ?? [];
  const cur = samples[samples.length - 1] ?? null;
  const stale = cur ? now - cur.ts > STALE_AFTER_MS : false;

  const points = React.useMemo(
    () =>
      samples.map((s) => ({
        ts: s.ts,
        values: {
          cpu: s.cpu,
          mem: s.memPct,
          disk: s.diskPct,
          rx: s.netRx,
          tx: s.netTx,
        },
      })),
    [samples],
  );

  if (!selected) {
    return (
      <EmptyState
        icon={ServerOff}
        title="No servers yet"
        description="Add a server to start seeing live CPU, memory, disk and network."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {showFleet ? (
            <ServerPicker
              servers={servers}
              rows={fleet}
              selectedId={selected.id}
              onSelect={setSelectedId}
            />
          ) : (
            <>
              <span
                className="max-w-full truncate text-sm font-medium"
                title={serverLabel(selected)}
              >
                {serverLabel(selected)}
              </span>
              {canManageServers && (
                <ManageServerButton id={selected.id} className="mr-0" />
              )}
            </>
          )}
          {cur && <LiveStatusLine stale={stale} asOf={cur.ts} />}
          {cur && cur.uptimeSec > 0 && (
            <span className="text-xs text-muted-foreground">
              {upFor(cur.uptimeSec)}
            </span>
          )}
        </div>
        {online && cur && (
          <WindowSelector windowMs={windowMs} onChange={setWindowMs} />
        )}
      </div>

      {!online || !cur ? (
        <EmptyState
          graphic={<MonitoringGraphic />}
          title="No live metrics"
          docs="monitoring.overview"
          description={
            selected.status === "provisioning"
              ? "This server is still provisioning. Metrics appear once its agent is online."
              : "Nothing has arrived from this server yet. Metrics appear as soon as it starts reporting."
          }
        />
      ) : (
        <div className="space-y-6">
          <MetricTabs
            active={metric}
            onSelect={setMetric}
            values={{
              cpu: { value: pct(cur.cpu), note: `${cur.cpuCores} cores` },
              memory: {
                value: pct(cur.memPct),
                note: `of ${friendlyBytes(cur.memTotal)}`,
              },
              disk: {
                value: pct(cur.diskPct),
                note: `of ${friendlyBytes(cur.diskTotal)}`,
              },
              network: {
                value: `${friendlyBytes(cur.netRx + cur.netTx)}/s`,
                note: "In and out",
              },
            }}
          />
          {metric === "disk" && canManageServers && (
            <div className="flex justify-end">
              <CleanupNowButton
                serverId={selected.id}
                serverName={serverLabel(selected)}
              />
            </div>
          )}
          <TimeSeriesChart
            key={metric}
            unit={metric === "network" ? "bytesPerSec" : "percent"}
            windowMs={windowMs}
            points={points}
            series={METRIC_SERIES[metric]}
            ariaLabel={`${METRIC_LABEL[metric]} over time`}
          />
        </div>
      )}

      {showFleet && (
        <section className="space-y-3">
          <PageHeader level="section" title="Servers" />
          <FleetList
            servers={servers}
            rows={fleet}
            selectedId={selected.id}
            onSelect={setSelectedId}
            canManageServers={canManageServers}
          />
        </section>
      )}

      {canManageServers && (
        <section className="space-y-3">
          <PageHeader
            level="section"
            title="Apps"
            description={serverLabel(selected)}
          />
          <ServerWorkloads key={selected.id} serverId={selected.id} />
        </section>
      )}
    </div>
  );
}

type Metric = "cpu" | "memory" | "disk" | "network";

const METRIC_LABEL: Record<Metric, string> = {
  cpu: "CPU",
  memory: "Memory",
  disk: "Disk",
  network: "Network",
};

const METRIC_ICON: Record<
  Metric,
  React.ComponentType<{ className?: string }>
> = { cpu: Cpu, memory: MemoryStick, disk: HardDrive, network: Network };

const METRIC_SERIES: Record<
  Metric,
  { key: string; label: string; color: string; fill?: boolean }[]
> = {
  cpu: [{ key: "cpu", label: "CPU", color: "var(--chart-1)", fill: true }],
  memory: [
    { key: "mem", label: "Memory", color: "var(--chart-1)", fill: true },
  ],
  disk: [{ key: "disk", label: "Disk", color: "var(--chart-1)", fill: true }],
  network: [
    { key: "rx", label: "Received", color: "var(--chart-1)" },
    { key: "tx", label: "Sent", color: "var(--chart-2)" },
  ],
};

const pct = (v: number) => `${Math.round(v)}%`;

function upFor(sec: number): string {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor(sec / 3600);
  if (days) return `Up for ${days} day${days === 1 ? "" : "s"}`;
  if (hours) return `Up for ${hours} hour${hours === 1 ? "" : "s"}`;
  return `Up for ${Math.max(1, Math.floor(sec / 60))} min`;
}

// The four numbers are the chart's tabs: one chart, the metric you picked.
function MetricTabs({
  active,
  onSelect,
  values,
  loading = false,
}: {
  active: Metric;
  onSelect: (m: Metric) => void;
  values: Record<Metric, { value: string; note: string }>;
  loading?: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label="Metric"
      className="grid grid-cols-2 border-b border-border sm:grid-cols-4"
    >
      {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => {
        const Icon = METRIC_ICON[m];
        const on = m === active;
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(m)}
            className={cn(
              "-mb-px flex cursor-pointer flex-col items-start gap-1 border-b-2 px-1 pt-1 pb-4 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:px-4",
              on
                ? "border-foreground"
                : "border-transparent hover:border-border",
            )}
          >
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs",
                on ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {METRIC_LABEL[m]}
            </span>
            <Bone loading={loading}>
              <span className="text-2xl font-semibold tracking-tight tabular-nums">
                {values[m].value}
              </span>
            </Bone>
            <span className="text-xs text-muted-foreground">
              {values[m].note}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A reporting server's dashboard, before its numbers arrive. */
export function MonitoringDashboardSkeleton() {
  const sample = { value: "12%", note: "of 8 GB" };
  return (
    <div className="space-y-6" aria-busy inert>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Bone box>
            <Button variant="outline" size="sm" className="max-w-full gap-2">
              <span className="truncate font-medium">server-name</span>
              <ChevronsUpDown className="size-3.5" />
            </Button>
          </Bone>
        </div>
        <WindowSelector windowMs={WINDOWS[0].ms} onChange={() => {}} />
      </div>
      <MetricTabs
        loading
        active="cpu"
        onSelect={() => {}}
        values={{ cpu: sample, memory: sample, disk: sample, network: sample }}
      />
      <Skeleton className="h-[200px] w-full rounded-lg" />
    </div>
  );
}
