"use client";

import * as React from "react";
import {
  Cpu,
  MemoryStick,
  Network,
  Boxes,
  ListTree,
  ServerOff,
  ArrowDown,
  ArrowUp,
  ArrowUpCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { TimeSeriesChart } from "@/components/monitoring/time-series-chart";
import {
  StatTile,
  ChartCard,
  WindowSelector,
  LiveStatusLine,
  WINDOWS,
  POLL_MS,
  MAX_POINTS,
} from "@/components/monitoring/dashboard-parts";
import { gqlAction } from "@/lib/graphql-client";
import { formatBytes } from "@/lib/utils";

/* The client-side shape of a ContainerMetrics / ContainerMetricsSample (the
 * server types are `server-only`, so the client redeclares the wire shape). */
interface InstanceMetrics {
  name: string;
  running: boolean;
  cpu: number;
  memUsed: number;
  memLimit: number;
  memPct: number;
  netRx: number;
  netTx: number;
  blockRead: number;
  blockWrite: number;
  pids: number;
}
export interface ContainerSample {
  online: boolean;
  ts: number;
  cpu: number;
  memUsed: number;
  memLimit: number;
  memPct: number;
  netRx: number; // cumulative bytes
  netTx: number;
  blockRead: number;
  blockWrite: number;
  pids: number;
  running: number;
  containers: number;
}
interface ContainerLive extends ContainerSample {
  unsupported: boolean;
  instances: InstanceMetrics[];
}

const SAMPLE_FIELDS = `online ts cpu memUsed memLimit memPct netRx netTx blockRead blockWrite pids running containers`;
const LIVE_FIELDS = `${SAMPLE_FIELDS} unsupported instances { name running cpu memUsed memLimit memPct netRx netTx blockRead blockWrite pids }`;

/** Per-second rate from two cumulative-counter samples; a counter reset
 *  (container restart, so the total dropped) clamps to 0 rather than a spike. */
function rate(cur: number, prev: number, dtSec: number): number {
  if (dtSec <= 0) return 0;
  return Math.max(0, (cur - prev) / dtSec);
}

/**
 * The per-app / per-database Monitoring tab. Mirrors the fleet Monitoring page,
 * but scoped to ONE stack's containers (the agent ContainerStats RPC) and with a
 * per-resource "Save metrics" switch that defaults OFF.
 */
export function ContainerMonitoringDashboard({
  kind,
  id,
  initialSaveMetrics,
  initialHistory,
  canManageInfra,
}: {
  kind: "app" | "database";
  id: string;
  /** The stored per-resource "Save metrics" switch state (default false). */
  initialSaveMetrics: boolean;
  /** Buffered history (when saving is on) to seed the charts on load. */
  initialHistory: ContainerSample[];
  /** Cosmetic gate for the switch; the mutation enforces `manage_infra` itself. */
  canManageInfra: boolean;
}) {
  const noun = kind === "app" ? "app" : "database";
  const metricsField = kind === "app" ? "appMetrics" : "databaseMetrics";
  const historyField = kind === "app" ? "appMetricsHistory" : "databaseMetricsHistory";
  const idArg = kind === "app" ? "appId" : "databaseId";
  const setMutation = kind === "app" ? "setAppSaveMetrics" : "setDatabaseSaveMetrics";

  const [windowMs, setWindowMs] = React.useState<number>(WINDOWS[0].ms);
  const [saveMetrics, setSaveMetrics] = React.useState(initialSaveMetrics);
  const [savingToggle, setSavingToggle] = React.useState(false);
  // Chart history holds live MEASUREMENTS with a running container only (real
  // usage). `last` is the latest poll whatever its flags, so the status line can
  // say "not answering" / "stopped" while the charts keep the honest gap.
  const [samples, setSamples] = React.useState<ContainerSample[]>(() =>
    initialHistory.filter((s) => s.online),
  );
  const [last, setLast] = React.useState<ContainerLive | null>(null);

  // Poll this stack's live metrics. A measurement takes ~1-2s (docker stats
  // samples a CPU window), so guard against overlapping requests stacking up.
  React.useEffect(() => {
    let active = true;
    let busy = false;

    async function tick() {
      if (busy) return;
      busy = true;
      try {
        const res = await gqlAction<Record<string, ContainerLive | null>, ContainerLive | null>(
          `query Metrics($id: String!) {
            ${metricsField}(${idArg}: $id) { ${LIVE_FIELDS} }
          }`,
          { id },
          (d) => d[metricsField],
        );
        if (!active || !res.ok || !res.data) return;
        const sample = res.data;
        setLast(sample);
        // Only chart online samples that actually have a running container.
        if (!sample.online || sample.running === 0) return;
        setSamples((prev) => [...prev, sample].slice(-MAX_POINTS));
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
  }, [id, metricsField, idArg]);

  // Seed the charts from buffered history (when saving is on): a reload starts
  // from the saved window instead of empty. Merge by ts; live samples win.
  React.useEffect(() => {
    if (!saveMetrics) return;
    let active = true;
    (async () => {
      const res = await gqlAction<Record<string, ContainerSample[]>, ContainerSample[]>(
        `query History($id: String!) {
          ${historyField}(${idArg}: $id) { ${SAMPLE_FIELDS} }
        }`,
        { id },
        (d) => d[historyField],
      );
      if (!active || !res.ok || !res.data || res.data.length === 0) return;
      const seeded = res.data.filter((s) => s.online && s.running > 0);
      setSamples((prev) => {
        const byTs = new Map<number, ContainerSample>();
        for (const s of [...seeded, ...prev]) byTs.set(s.ts, s);
        return [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_POINTS);
      });
    })();
    return () => {
      active = false;
    };
  }, [id, historyField, idArg, saveMetrics]);

  // Flip the per-resource "Save metrics" switch. Optimistic with a revert on error.
  async function toggleSaveMetrics(next: boolean) {
    setSaveMetrics(next);
    setSavingToggle(true);
    try {
      const res = await gqlAction<Record<string, boolean>, boolean>(
        `mutation SetSaveMetrics($id: String!, $enabled: Boolean!) {
          ${setMutation}(${idArg}: $id, enabled: $enabled)
        }`,
        { id, enabled: next },
        (d) => d[setMutation],
      );
      if (!res.ok) {
        setSaveMetrics(!next);
        toast.error(res.error);
      }
    } finally {
      setSavingToggle(false);
    }
  }

  // One shared point list feeds every chart; net/block are cumulative counters,
  // so each point's rate is derived from the previous sample's delta.
  const points = React.useMemo(
    () =>
      samples.map((s, i) => {
        const prev = samples[i - 1];
        const dt = prev ? (s.ts - prev.ts) / 1000 : 0;
        return {
          ts: s.ts,
          values: {
            cpu: s.cpu,
            mem: s.memPct,
            rx: prev ? rate(s.netRx, prev.netRx, dt) : 0,
            tx: prev ? rate(s.netTx, prev.netTx, dt) : 0,
            bread: prev ? rate(s.blockRead, prev.blockRead, dt) : 0,
            bwrite: prev ? rate(s.blockWrite, prev.blockWrite, dt) : 0,
          },
        };
      }),
    [samples],
  );

  const cur = samples[samples.length - 1] ?? null;
  // Current network / block rates from the last two chart samples.
  const prev = samples[samples.length - 2];
  const dt = cur && prev ? (cur.ts - prev.ts) / 1000 : 0;
  const curNetRx = cur && prev ? rate(cur.netRx, prev.netRx, dt) : 0;
  const curNetTx = cur && prev ? rate(cur.netTx, prev.netTx, dt) : 0;

  const saveSwitch = (
    <div className="flex items-center gap-2">
      <Switch
        id="save-metrics"
        checked={saveMetrics}
        disabled={!canManageInfra || savingToggle}
        onCheckedChange={toggleSaveMetrics}
        aria-label={`Save metrics for this ${noun}`}
      />
      <FieldLabel
        htmlFor="save-metrics"
        className="text-sm font-normal text-muted-foreground"
        info={
          <>
            Off by default. When on, the control plane keeps a rolling ~15-minute
            history of this {noun}&apos;s metrics in memory and samples its
            container in the background every few seconds — even when you&apos;re
            not on this tab. It&apos;s a small, bounded cost per {noun} (RAM only,
            nothing hits the database), but it adds steady work on the owning
            server and memory that adds up across many opted-in{" "}
            {noun === "app" ? "apps" : "databases"}. Best turned on while
            you&apos;re actively debugging, and off when you&apos;re done.
          </>
        }
      >
        Save metrics
      </FieldLabel>
    </div>
  );

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {cur ? (
        <LiveStatusLine stale={Boolean(last && !last.online)} asOf={cur.ts} />
      ) : (
        <span className="text-xs text-muted-foreground">Live container metrics</span>
      )}
      <div className="flex items-center gap-3">
        {cur && <WindowSelector windowMs={windowMs} onChange={setWindowMs} />}
        {canManageInfra ? (
          saveSwitch
        ) : (
          <SimpleTooltip content="Requires the Manage infrastructure capability">
            <span tabIndex={0}>{saveSwitch}</span>
          </SimpleTooltip>
        )}
      </div>
    </div>
  );

  // Empty states, in priority order.
  let body: React.ReactNode;
  if (last?.unsupported) {
    body = (
      <EmptyCard
        icon={ArrowUpCircle}
        title="Update the agent"
        text={`The agent on this ${noun}'s server is too old to report per-container metrics. Update the agent on that server (Servers → the server → update) to enable this tab.`}
      />
    );
  } else if (!cur) {
    if (last && !last.online) {
      body = (
        <EmptyCard
          icon={ServerOff}
          title="No live metrics"
          text={`This ${noun}'s server isn't answering. Metrics resume as soon as its agent does.`}
        />
      );
    } else if (last && last.running === 0) {
      body = (
        <EmptyCard
          icon={ServerOff}
          title="Not running"
          text={`This ${noun} isn't running, so there's nothing to measure. Start it to see live resource usage here.`}
        />
      );
    } else {
      body = (
        <EmptyCard
          icon={Boxes}
          title="Collecting…"
          text="Waiting for the first measurement from the agent."
        />
      );
    }
  } else {
    body = (
      <>
        {/* Current-value tiles */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            icon={Cpu}
            label="CPU"
            value={`${cur.cpu.toFixed(1)}%`}
            sub={`${cur.running} of ${cur.containers} container${cur.containers === 1 ? "" : "s"} running`}
            pct={cur.cpu}
          />
          <StatTile
            icon={MemoryStick}
            label="Memory"
            value={`${cur.memPct.toFixed(1)}%`}
            sub={
              cur.memLimit > 0
                ? `${formatBytes(cur.memUsed)} / ${formatBytes(cur.memLimit)}`
                : formatBytes(cur.memUsed)
            }
            pct={cur.memPct}
          />
          <Card>
            <CardContent className="space-y-1.5 p-4">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Network className="size-4" />
                <span className="text-xs">Network</span>
              </div>
              <div className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
                <ArrowDown className="size-4 text-[var(--success)]" />
                {formatBytes(curNetRx)}/s
              </div>
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <ArrowUp className="size-4" />
                {formatBytes(curNetTx)}/s
              </div>
            </CardContent>
          </Card>
          <StatTile
            icon={ListTree}
            label="Processes"
            value={`${cur.pids}`}
            sub="PIDs across the stack"
          />
        </div>

        {/* Real-time charts */}
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="CPU usage" caption={`${cur.cpu.toFixed(1)}%`}>
            <TimeSeriesChart
              unit="percent"
              windowMs={windowMs}
              points={points}
              series={[{ key: "cpu", label: "CPU", color: "var(--chart-1)", fill: true }]}
              ariaLabel={`CPU usage over time, currently ${cur.cpu.toFixed(1)}%`}
            />
          </ChartCard>

          <ChartCard
            title="Memory usage"
            caption={
              cur.memLimit > 0
                ? `${formatBytes(cur.memUsed)} of ${formatBytes(cur.memLimit)} · ${cur.memPct.toFixed(1)}%`
                : formatBytes(cur.memUsed)
            }
          >
            <TimeSeriesChart
              unit="percent"
              windowMs={windowMs}
              points={points}
              series={[{ key: "mem", label: "Memory", color: "var(--chart-1)", fill: true }]}
              ariaLabel={`Memory usage over time, currently ${cur.memPct.toFixed(1)}%`}
            />
          </ChartCard>

          <ChartCard title="Network I/O">
            <TimeSeriesChart
              unit="bytesPerSec"
              windowMs={windowMs}
              points={points}
              series={[
                { key: "rx", label: "↓ Received", color: "var(--chart-1)" },
                { key: "tx", label: "↑ Sent", color: "var(--chart-2)" },
              ]}
              ariaLabel="Network throughput over time, received and sent bytes per second"
            />
          </ChartCard>

          <ChartCard title="Disk I/O">
            <TimeSeriesChart
              unit="bytesPerSec"
              windowMs={windowMs}
              points={points}
              series={[
                { key: "bread", label: "Read", color: "var(--chart-1)" },
                { key: "bwrite", label: "Write", color: "var(--chart-2)" },
              ]}
              ariaLabel="Block device throughput over time, read and write bytes per second"
            />
          </ChartCard>
        </div>

        {/* Per-container breakdown (multi-container stacks only) */}
        {last && last.instances.length > 1 && (
          <ContainerBreakdown instances={last.instances} />
        )}
      </>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      {body}
    </div>
  );
}

function EmptyCard({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof ServerOff;
  title: string;
  text: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <Icon className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{text}</p>
      </CardContent>
    </Card>
  );
}

/** A compact per-container table for multi-container (compose) stacks. */
function ContainerBreakdown({ instances }: { instances: InstanceMetrics[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Container</th>
                <th className="px-4 py-2 text-right font-medium">CPU</th>
                <th className="px-4 py-2 text-right font-medium">Memory</th>
                <th className="px-4 py-2 text-right font-medium">PIDs</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((c) => (
                <tr key={c.name} className="border-b last:border-0">
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-2">
                      <span
                        className={
                          c.running
                            ? "inline-flex size-2 rounded-full bg-[var(--success)]"
                            : "inline-flex size-2 rounded-full bg-muted-foreground/40"
                        }
                      />
                      <span className="font-mono text-xs">{c.name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {c.running ? `${c.cpu.toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {c.running ? formatBytes(c.memUsed) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {c.running ? c.pids : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
