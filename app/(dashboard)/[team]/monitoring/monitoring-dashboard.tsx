"use client";

import * as React from "react";
import { ChevronLeft, ChevronsUpDown, Search, ServerOff } from "lucide-react";
import { TimeSeriesChart } from "@/components/monitoring/time-series-chart";
import { MonitoringGraphic } from "@/components/monitoring/monitoring-graphic";
import { EmptyState } from "@/components/shared/empty-state";
import { FleetList, type FleetRow } from "@/components/monitoring/fleet-list";
import { CleanupNowButton } from "@/components/monitoring/cleanup-now-button";
import { ManageServerButton } from "@/components/monitoring/host-chip";
import { ServerPicker } from "@/components/monitoring/server-picker";
import {
  FleetStatus,
  FleetStatusSkeleton,
} from "@/components/monitoring/fleet-status";
import { Bone, Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  METRIC_SERIES,
  METRICS,
  MetricDetail,
  MetricTabs,
  type Metric,
} from "@/components/monitoring/metric-panel";
import { TopApps } from "@/components/monitoring/top-apps";
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
import { serverLabel } from "@/lib/utils";

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
  const [view, setView] = React.useState<"server" | "all">("server");
  const [query, setQuery] = React.useState("");

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
          { serverMetricsHistory: ServerMetrics[]; fleetMetrics: FleetRow[] },
          { history: ServerMetrics[]; fleet: FleetRow[] }
        >(
          `query MonitoringTick($serverId: String!) {
            serverMetricsHistory(serverId: $serverId) { ${SERVER_FIELDS} }
            fleetMetrics { ${FLEET_FIELDS} }
          }`,
          { serverId: selectedId },
          (d) => ({ history: d.serverMetricsHistory, fleet: d.fleetMetrics }),
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
  }, [selectedId, online, pollMs]);

  const samples = React.useMemo(
    () => history[selectedId] ?? [],
    [history, selectedId],
  );
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

  const inWindow = React.useMemo(() => {
    const from = (cur?.ts ?? 0) - windowMs;
    return samples.filter((s) => s.ts >= from);
  }, [samples, cur, windowMs]);

  if (!selected) {
    return (
      <EmptyState
        icon={ServerOff}
        title="No servers yet"
        description="Add a server to start seeing live CPU, memory, disk and network."
      />
    );
  }

  const openServer = (id: string) => {
    setSelectedId(id);
    setView("server");
  };
  const q = query.trim().toLowerCase();
  const listed = q
    ? servers.filter((s) => serverLabel(s).toLowerCase().includes(q))
    : servers;

  return (
    <div className="space-y-8">
      <FleetStatus
        servers={servers}
        rows={fleet}
        onOpen={openServer}
        onSeeAll={view === "server" ? () => setView("all") : undefined}
      />

      {view === "all" ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => setView("server")}>
              <ChevronLeft className="size-4" />
              {serverLabel(selected)}
            </Button>
            <div className="relative ml-auto w-full sm:w-72">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search servers"
                aria-label="Search servers"
                className="pl-9"
              />
            </div>
          </div>
          <FleetList
            servers={listed}
            rows={fleet}
            selectedId={selected.id}
            onSelect={openServer}
            canManageServers={canManageServers}
          />
        </section>
      ) : (
        <div className="space-y-5">
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
            <>
              <MetricTabs
                active={metric}
                onSelect={setMetric}
                samples={inWindow}
              />
              <MetricDetail
                metric={metric}
                window={inWindow}
                chart={
                  <TimeSeriesChart
                    key={metric}
                    height={240}
                    unit={metric === "network" ? "bytesPerSec" : "percent"}
                    windowMs={windowMs}
                    points={points}
                    series={METRIC_SERIES[metric]}
                    ariaLabel={`${METRICS[metric].label} over time`}
                  />
                }
                action={
                  metric === "disk" &&
                  canManageServers && (
                    <CleanupNowButton
                      serverId={selected.id}
                      serverName={serverLabel(selected)}
                    />
                  )
                }
              />
              {canManageServers &&
                (metric === "cpu" || metric === "memory") && (
                  <div className="pt-3">
                    <TopApps serverId={selected.id} metric={metric} />
                  </div>
                )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function upFor(sec: number): string {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor(sec / 3600);
  if (days) return `Up for ${days} day${days === 1 ? "" : "s"}`;
  if (hours) return `Up for ${hours} hour${hours === 1 ? "" : "s"}`;
  return `Up for ${Math.max(1, Math.floor(sec / 60))} min`;
}

/** A reporting server's dashboard, before its numbers arrive. */
export function MonitoringDashboardSkeleton() {
  return (
    <div className="space-y-8" aria-busy inert>
      <FleetStatusSkeleton />
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Bone box>
            <Button variant="outline" size="sm" className="max-w-full gap-2">
              <span className="truncate font-medium">server-name</span>
              <ChevronsUpDown className="size-3.5" />
            </Button>
          </Bone>
          <WindowSelector windowMs={WINDOWS[0].ms} onChange={() => {}} />
        </div>
        <MetricTabs loading active="cpu" onSelect={() => {}} samples={[]} />
        <Skeleton className="h-[240px] w-full rounded-lg" />
      </div>
    </div>
  );
}
