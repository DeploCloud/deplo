import "server-only";

import { hasCapability, requireActiveTeamId } from "../membership";
import { hasAppCapability } from "./node-access";
import { loadTeamApp } from "./app-graph-load";
import { loadDatabaseForTeam } from "./databases/rows";
import type { ContainerStat as PbContainerStat } from "../agent/gen/agent";
import {
  getContainerHistory,
  latestContainerSample,
  latestContainerInstances,
} from "../monitoring/container-history";
import { metricsStreamUnsupported } from "../monitoring/stream-modes";

// ContainerInstanceMetrics - one container's live usage in the breakdown table.
export interface ContainerInstanceMetrics {
  name: string;
  running: boolean;
  cpu: number; // percent, across all cores
  memUsed: number; // bytes
  memLimit: number; // bytes
  memPct: number;
  netRx: number; // cumulative bytes
  netTx: number;
  blockRead: number; // cumulative bytes
  blockWrite: number;
  pids: number;
  // Raw docker state (running | exited | restarting | ...); empty from an agent too old.
  state: string;
  // healthy | unhealthy | starting; empty when there is NO healthcheck, which is not healthy.
  health: string;
  restartCount: number;
  // Containers sharing a namespace report the SAME counters, so count them once. 0 = old agent.
  netNsId: number;
  // network_mode: host - net is 0 here, because those bytes are the machine's.
  netNsHost: boolean;
}

// ContainerMetricsSample - the aggregate stored in the ring buffer and charted.
export interface ContainerMetricsSample {
  id: string;
  online: boolean;
  // epoch ms (control-plane clock at measurement).
  ts: number;
  cpu: number; // percent of ONE core, summed across running containers
  memUsed: number; // bytes, summed
  memLimit: number; // the HOST's RAM - the machine is the ceiling, counted once
  memPct: number; // memUsed/memLimit*100
  netRx: number; // cumulative bytes, one counter per network namespace
  netTx: number;
  blockRead: number; // cumulative bytes, summed
  blockWrite: number;
  pids: number; // summed
  running: number;
  containers: number;
  // The owning machine's core count, so cpu also reads as "3.0 of 8 cores". 0 before the first frame.
  hostCores: number;
}

// ContainerMetrics - the live DTO: a sample plus the agent flag and the breakdown.
export interface ContainerMetrics extends ContainerMetricsSample {
  // True only when the agent is too old for ContainerStats - distinct from offline.
  unsupported: boolean;
  instances: ContainerInstanceMetrics[];
}

function unavailable(
  id: string,
  ts: number,
  unsupported: boolean,
): ContainerMetrics {
  return {
    id,
    online: false,
    unsupported,
    ts,
    cpu: 0,
    memUsed: 0,
    memLimit: 0,
    memPct: 0,
    netRx: 0,
    netTx: 0,
    blockRead: 0,
    blockWrite: 0,
    pids: 0,
    running: 0,
    containers: 0,
    hostCores: 0,
    instances: [],
  };
}

function toInstance(s: PbContainerStat): ContainerInstanceMetrics {
  return {
    name: s.name,
    running: s.running,
    cpu: s.cpuPct,
    memUsed: s.memUsed,
    memLimit: s.memLimit,
    memPct: s.memPct,
    netRx: s.netRx,
    netTx: s.netTx,
    blockRead: s.blockRead,
    blockWrite: s.blockWrite,
    pids: s.pids,
    state: s.state,
    health: s.health,
    restartCount: s.restartCount,
    netNsId: s.netNsId,
    netNsHost: s.netNsHost,
  };
}

// HostCapacity - what the OWNING MACHINE can give a stack, from the same telemetry frame.
export interface HostCapacity {
  memTotal: number;
  cpuCores: number;
}

// aggregateContainerStats - fold the agent's per-container stats into the app-total DTO.
export function aggregateContainerStats(
  id: string,
  stats: PbContainerStat[],
  ts: number,
  host: HostCapacity,
): ContainerMetrics {
  return aggregate(id, stats, ts, host);
}

// One counter per network namespace: a sidecar sharing one reads the very same bytes.
function netContributors(running: PbContainerStat[]): PbContainerStat[] {
  const byNs = new Map<string, PbContainerStat>();
  for (const s of running) {
    if (s.netNsHost) continue;
    // No namespace id (an agent too old) proves nothing shared, so each counts for itself.
    const key = s.netNsId ? `ns:${s.netNsId}` : `c:${s.containerId || s.name}`;
    if (!byNs.has(key)) byNs.set(key, s);
  }
  return [...byNs.values()];
}

function aggregate(
  id: string,
  stats: PbContainerStat[],
  ts: number,
  host: HostCapacity,
): ContainerMetrics {
  const running = stats.filter((s) => s.running);
  const sum = (f: (s: PbContainerStat) => number) =>
    running.reduce((a, s) => a + f(s), 0);
  const memUsed = sum((s) => s.memUsed);
  // The machine is the ceiling: the agent reports an uncapped container's limit as the whole host.
  const memLimit = Math.min(
    sum((s) => s.memLimit),
    host.memTotal > 0 ? host.memTotal : Number.POSITIVE_INFINITY,
  );
  const net = netContributors(running);
  const netSum = (f: (s: PbContainerStat) => number) =>
    net.reduce((a, s) => a + f(s), 0);
  return {
    id,
    online: true,
    unsupported: false,
    ts,
    cpu: sum((s) => s.cpuPct),
    memUsed,
    memLimit,
    memPct: memLimit > 0 ? (memUsed / memLimit) * 100 : 0,
    netRx: netSum((s) => s.netRx),
    netTx: netSum((s) => s.netTx),
    blockRead: sum((s) => s.blockRead),
    blockWrite: sum((s) => s.blockWrite),
    pids: sum((s) => s.pids),
    running: running.length,
    containers: stats.length,
    hostCores: host.cpuCores,
    instances: stats.map(toInstance),
  };
}

// toContainerSample - the fold the stream supervisor reuses, so the two paths cannot drift.
export function toContainerSample(m: ContainerMetrics): ContainerMetricsSample {
  return toSample(m);
}

function toSample(m: ContainerMetrics): ContainerMetricsSample {
  // Drops instances (live-only) and unsupported (never true for a recorded sample).
  const { unsupported, instances, ...sample } = m;
  void unsupported;
  void instances;
  return sample;
}

// getAppMetrics - live metrics for one app (team-scoped). Null for an unknown or cross-team app.
export async function getAppMetrics(
  appId: string,
): Promise<ContainerMetrics | null> {
  const teamId = await requireActiveTeamId();
  // A node grant REPLACES the team role inside the app (ADR-0016), in both directions.
  if (!(await hasAppCapability(appId, "view_metrics"))) return null;
  const app = await loadTeamApp(appId, teamId);
  if (!app) return null;
  return fromBuffer(app.id, app.serverId ?? null);
}

// An honest "no data", never a fabricated zero.
function fromBuffer(id: string, serverId: string | null): ContainerMetrics {
  const s = latestContainerSample(id);
  // Nothing buffered AND no stream: not "no data yet" but an agent too old to report.
  if (!s) {
    const stale = Boolean(serverId) && metricsStreamUnsupported(serverId!);
    return unavailable(id, Date.now(), stale);
  }
  return { ...s, unsupported: false, instances: latestContainerInstances(id) };
}

// getAppMetricsHistory - the buffered window for one app (team-scoped).
export async function getAppMetricsHistory(
  appId: string,
): Promise<ContainerMetricsSample[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasAppCapability(appId, "view_metrics"))) return [];
  const app = await loadTeamApp(appId, teamId);
  if (!app) return [];
  return getContainerHistory(app.id);
}

// getDatabaseMetrics - live metrics for one database (team-scoped), a buffer read like getAppMetrics.
export async function getDatabaseMetrics(
  databaseId: string,
): Promise<ContainerMetrics | null> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_metrics"))) return null;
  const db = await loadDatabaseForTeam(databaseId, teamId);
  if (!db) return null;
  return fromBuffer(db.id, db.serverId ?? null);
}

// getDatabaseMetricsHistory - the buffered window for one database (team-scoped).
export async function getDatabaseMetricsHistory(
  databaseId: string,
): Promise<ContainerMetricsSample[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_metrics"))) return [];
  const db = await loadDatabaseForTeam(databaseId, teamId);
  if (!db) return [];
  return getContainerHistory(db.id);
}
