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

export interface ContainerInstanceMetrics {
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
  state: string;
  health: string;
  restartCount: number;
  netNsId: number;
  netNsHost: boolean;
}

export interface ContainerMetricsSample {
  id: string;
  online: boolean;
  ts: number;
  cpu: number;
  memUsed: number;
  memLimit: number;
  memPct: number;
  netRx: number;
  netTx: number;
  blockRead: number;
  blockWrite: number;
  pids: number;
  running: number;
  containers: number;
  hostCores: number;
}

export interface ContainerMetrics extends ContainerMetricsSample {
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

export interface HostCapacity {
  memTotal: number;
  cpuCores: number;
}

export function aggregateContainerStats(
  id: string,
  stats: PbContainerStat[],
  ts: number,
  host: HostCapacity,
): ContainerMetrics {
  return aggregate(id, stats, ts, host);
}

function netContributors(running: PbContainerStat[]): PbContainerStat[] {
  const byNs = new Map<string, PbContainerStat>();
  for (const s of running) {
    if (s.netNsHost) continue;
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

export function toContainerSample(m: ContainerMetrics): ContainerMetricsSample {
  return toSample(m);
}

function toSample(m: ContainerMetrics): ContainerMetricsSample {
  const { unsupported, instances, ...sample } = m;
  void unsupported;
  void instances;
  return sample;
}

export async function getAppMetrics(
  appId: string,
): Promise<ContainerMetrics | null> {
  const teamId = await requireActiveTeamId();
  if (!(await hasAppCapability(appId, "view_metrics"))) return null;
  const app = await loadTeamApp(appId, teamId);
  if (!app) return null;
  return fromBuffer(app.id, app.serverId ?? null);
}

function fromBuffer(id: string, serverId: string | null): ContainerMetrics {
  const s = latestContainerSample(id);
  if (!s) {
    const stale = Boolean(serverId) && metricsStreamUnsupported(serverId!);
    return unavailable(id, Date.now(), stale);
  }
  return { ...s, unsupported: false, instances: latestContainerInstances(id) };
}

export async function getAppMetricsHistory(
  appId: string,
): Promise<ContainerMetricsSample[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasAppCapability(appId, "view_metrics"))) return [];
  const app = await loadTeamApp(appId, teamId);
  if (!app) return [];
  return getContainerHistory(app.id);
}

export async function getDatabaseMetrics(
  databaseId: string,
): Promise<ContainerMetrics | null> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_metrics"))) return null;
  const db = await loadDatabaseForTeam(databaseId, teamId);
  if (!db) return null;
  return fromBuffer(db.id, db.serverId ?? null);
}

export async function getDatabaseMetricsHistory(
  databaseId: string,
): Promise<ContainerMetricsSample[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_metrics"))) return [];
  const db = await loadDatabaseForTeam(databaseId, teamId);
  if (!db) return [];
  return getContainerHistory(db.id);
}
