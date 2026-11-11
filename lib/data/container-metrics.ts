import "server-only";

import { hasCapability, requireActiveTeamId } from "../membership";
import { hasAppCapability } from "./node-access";
import { loadTeamApp } from "./app-graph-load";
import { loadDatabaseForTeam } from "./databases/rows";
import type { ContainerStat as PbContainerStat } from "../agent/gen/agent";
import {
  freshMemberIds,
  getContainerHistory,
  latestContainerSample,
  latestContainerInstances,
} from "../monitoring/container-history";
import {
  replicaIndexOf,
  replicaLabels,
  replicaTag,
} from "../deploy/replica-names";
import { listAppMembers } from "./clusters/placement";
import { getServerById } from "./servers/roster";
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
  // `web-2` when this is one of several copies of its service, else null.
  replica?: string | null;
  // Set only while several servers run the workload: the one this container is on.
  serverId?: string;
  server?: string | null;
}

/** One server's part of a sample that totals several. `server` is its name, set where a person reads it. */
export interface MemberShare {
  serverId: string;
  server?: string;
  cpu: number;
  memUsed: number;
  running: number;
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
  members?: MemberShare[];
}

export interface ContainerMetrics extends ContainerMetricsSample {
  unsupported: boolean;
  instances: ContainerInstanceMetrics[];
  // Only for a workload on several servers: the ones whose readings are missing from this total, by name.
  unavailable?: string[];
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

// Names the copies of a service in a breakdown (`web-1`, `web-2`); the totals already count every one.
export function tagReplicaMetrics(
  instances: ContainerInstanceMetrics[],
  slug: string,
): ContainerInstanceMetrics[] {
  const labels = replicaLabels(
    instances.map((i) => i.name),
    slug,
  );
  const tagged = instances.map((i) => ({
    ...i,
    replica: labels.get(i.name)?.label ?? null,
  }));
  if (labels.size === 0) return tagged;
  const key = (i: ContainerInstanceMetrics) =>
    labels.get(i.name)?.service ?? "";
  return tagged.sort(
    (a, b) =>
      key(a).localeCompare(key(b)) ||
      (replicaIndexOf(a.name) ?? 0) - (replicaIndexOf(b.name) ?? 0),
  );
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
  const live = fromBuffer(app.id, app.serverId ?? null, app.slug);
  if (!live.online) return live;
  const expected = await listAppMembers(app);
  return acrossServers(live, expected.length > 1 ? expected : [], app);
}

function fromBuffer(
  id: string,
  serverId: string | null,
  slug?: string,
): ContainerMetrics {
  const s = latestContainerSample(id);
  if (!s) {
    const stale = Boolean(serverId) && metricsStreamUnsupported(serverId!);
    return unavailable(id, Date.now(), stale);
  }
  const instances = latestContainerInstances(id);
  const { members, ...sample } = s;
  void members;
  return {
    ...sample,
    unsupported: false,
    instances: slug ? tagReplicaMetrics(instances, slug) : instances,
  };
}

const REMOVED_SERVER = "a removed server";

async function serverNames(
  ids: Iterable<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(ids))
    out.set(id, (await getServerById(id))?.name ?? REMOVED_SERVER);
  return out;
}

// A workload read on several servers names each container with its server, and the servers that sent nothing.
// These are servers that reported its containers, or that its placement names: never another workload's.
async function acrossServers(
  live: ContainerMetrics,
  expected: string[],
  app?: { slug: string; replicas: number },
): Promise<ContainerMetrics> {
  const fresh = freshMemberIds(live.id);
  const sole = fresh.length === 1 ? fresh[0] : undefined;
  const on = (i: ContainerInstanceMetrics) => i.serverId ?? sole;
  const servers = new Set([
    ...expected,
    ...live.instances.flatMap((i) => on(i) ?? []),
  ]);
  if (servers.size < 2) return live;
  const names = await serverNames(servers);
  const labels = replicaLabels(
    [...new Set(live.instances.map((i) => i.name))],
    app?.slug ?? "",
  );
  // Each server numbers its own copies, so one can look alone: an App set to several replicas still names it.
  const lone = (name: string) =>
    app && app.replicas > 1 && replicaIndexOf(name) !== null
      ? replicaTag(name, app.slug)
      : null;
  return {
    ...live,
    unavailable: expected
      .filter((id) => !fresh.includes(id))
      .map((id) => names.get(id)!),
    instances: live.instances.map((i) => {
      const server = names.get(on(i) ?? "");
      // A reading too old to say which server sent it keeps its plain name.
      if (!server) return i;
      const copy = labels.get(i.name)?.label ?? lone(i.name) ?? i.name;
      return { ...i, server, replica: `${copy} · ${server}` };
    }),
  };
}

// History that only ever saw one server reads as it always did; otherwise each sample names its servers' shares.
async function withShares(
  history: ContainerMetricsSample[],
): Promise<ContainerMetricsSample[]> {
  const ids = new Set(
    history.flatMap((s) => (s.members ?? []).map((m) => m.serverId)),
  );
  if (ids.size < 2)
    return history.map((s) => {
      const { members, ...plain } = s;
      void members;
      return plain;
    });
  const names = await serverNames(ids);
  return history.map((s) => ({
    ...s,
    members: (s.members ?? []).map((m) => ({
      ...m,
      server: names.get(m.serverId)!,
    })),
  }));
}

export async function getAppMetricsHistory(
  appId: string,
): Promise<ContainerMetricsSample[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasAppCapability(appId, "view_metrics"))) return [];
  const app = await loadTeamApp(appId, teamId);
  if (!app) return [];
  return withShares(getContainerHistory(app.id));
}

export async function getDatabaseMetrics(
  databaseId: string,
): Promise<ContainerMetrics | null> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_metrics"))) return null;
  const db = await loadDatabaseForTeam(databaseId, teamId);
  if (!db) return null;
  // A standby copy on another server is measured too, and named.
  return acrossServers(fromBuffer(db.id, db.serverId ?? null), []);
}

export async function getDatabaseMetricsHistory(
  databaseId: string,
): Promise<ContainerMetricsSample[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_metrics"))) return [];
  const db = await loadDatabaseForTeam(databaseId, teamId);
  if (!db) return [];
  return withShares(getContainerHistory(db.id));
}
