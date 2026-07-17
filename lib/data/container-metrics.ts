import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { loadTeamApp } from "./app-graph-load";
import { loadDatabaseForTeam } from "./databases";
import { requireFolderCapabilityForApp } from "./folder-access";
import { publishDatabaseChanged } from "../graphql/pubsub";
import {
  connectAgent,
  mapContainerStatsUnsupported,
  AgentContainerStatsUnsupportedError,
} from "../infra/agent-client";
import type { ContainerStat as PbContainerStat } from "../agent/gen/agent";
import {
  recordContainerSample,
  getContainerHistory,
  clearContainerHistory,
} from "../monitoring/container-history";

/**
 * Per-app / per-database live resource metrics — the data behind the Monitoring
 * TAB on an app or database page (the per-container sibling of
 * lib/data/monitoring.ts's host-level metrics). Every read resolves the owning
 * server + the `deplo.project=<id>` label from the team-scoped row, dials that
 * server's agent, and calls the ContainerStats RPC (ADR-0006: the control plane
 * never touches a Docker socket itself).
 *
 * A stack can be multi-container (a compose app + its sidecars); the tab charts
 * the APP TOTAL — the sum across the stack's running containers — and also
 * carries the per-container breakdown for the table. net_* / block_* are
 * CUMULATIVE byte counters (what `docker stats` reports); the client derives
 * bytes/sec from the delta between consecutive samples.
 */

/** One container's live usage in the breakdown table (live only; not charted). */
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
}

/**
 * The aggregate stored in the ring buffer + charted. `online` means the agent
 * answered with a real measurement (reachable AND new enough); an offline /
 * unsupported answer is never recorded (a gap, not a fake zero — see
 * container-history.ts).
 */
export interface ContainerMetricsSample {
  /** The app or database id — the history buffer key. */
  id: string;
  online: boolean;
  /** epoch ms (control-plane clock at measurement). */
  ts: number;
  cpu: number; // percent, summed across running containers
  memUsed: number; // bytes, summed
  memLimit: number; // bytes, summed
  memPct: number; // memUsed/memLimit*100 (0 when no limit)
  netRx: number; // cumulative bytes, summed
  netTx: number;
  blockRead: number; // cumulative bytes, summed
  blockWrite: number;
  pids: number; // summed
  /** How many of the stack's containers are running. */
  running: number;
  /** Total containers in the stack (running + stopped). */
  containers: number;
}

/** The live DTO: a sample plus the "update the agent" flag and the breakdown. */
export interface ContainerMetrics extends ContainerMetricsSample {
  /** True only when the agent is too old for ContainerStats — the tab shows an
   *  "update the agent on this server" state, distinct from offline. */
  unsupported: boolean;
  instances: ContainerInstanceMetrics[];
}

/** A "we couldn't measure" DTO — reachable? no. Never recorded to history. */
function unavailable(id: string, ts: number, unsupported: boolean): ContainerMetrics {
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
  };
}

/** Fold the agent's per-container stats into the app-total DTO. */
function aggregate(id: string, stats: PbContainerStat[], ts: number): ContainerMetrics {
  const running = stats.filter((s) => s.running);
  const sum = (f: (s: PbContainerStat) => number) =>
    running.reduce((a, s) => a + f(s), 0);
  const memUsed = sum((s) => s.memUsed);
  const memLimit = sum((s) => s.memLimit);
  return {
    id,
    online: true,
    unsupported: false,
    ts,
    cpu: sum((s) => s.cpuPct),
    memUsed,
    memLimit,
    memPct: memLimit > 0 ? (memUsed / memLimit) * 100 : 0,
    netRx: sum((s) => s.netRx),
    netTx: sum((s) => s.netTx),
    blockRead: sum((s) => s.blockRead),
    blockWrite: sum((s) => s.blockWrite),
    pids: sum((s) => s.pids),
    running: running.length,
    containers: stats.length,
    instances: stats.map(toInstance),
  };
}

/** Strip the live-only fields to the buffer sample. */
function toSample(m: ContainerMetrics): ContainerMetricsSample {
  // Deliberately drop `instances` (the breakdown is a live-only table) and
  // `unsupported` (never true for a recorded, online sample) to keep the RAM
  // window lean.
  const { unsupported: _u, instances: _i, ...sample } = m;
  return sample;
}

/**
 * Measure one stack's containers via its owning agent. SESSION-FREE (takes the
 * already-resolved id + serverId), so the background collector reuses it. Never
 * throws: an unreachable agent → online:false; an agent too old for the RPC →
 * online:false + unsupported:true (the tab's "update the agent" state).
 */
export async function measureContainerStack(
  id: string,
  serverId: string,
): Promise<ContainerMetrics> {
  const ts = Date.now();
  let conn;
  try {
    conn = await connectAgent(serverId);
  } catch {
    return unavailable(id, ts, false);
  }
  try {
    // Empty `containers` => the agent stats every container carrying
    // deplo.project=<id>, so the control plane needn't resolve names first.
    const stats = await conn.containerStats(id, []);
    return aggregate(id, stats, ts);
  } catch (e) {
    return unavailable(
      id,
      ts,
      mapContainerStatsUnsupported(e) instanceof AgentContainerStatsUnsupportedError,
    );
  } finally {
    conn.close();
  }
}

/* ------------------------------------------------------------------ */
/* App reads                                                           */
/* ------------------------------------------------------------------ */

/** Live metrics for one app (team-scoped). Records a history sample when the
 *  app opted in. Null for an unknown / cross-team app. */
export async function getAppMetrics(appId: string): Promise<ContainerMetrics | null> {
  const teamId = await requireActiveTeamId();
  const app = await loadTeamApp(appId, teamId);
  if (!app) return null;
  const m = await measureContainerStack(app.id, app.serverId);
  if (m.online && app.saveMetrics) recordContainerSample(toSample(m));
  return m;
}

/** The buffered window for one app (team-scoped). Empty when unknown/cross-team
 *  or saving is off. */
export async function getAppMetricsHistory(
  appId: string,
): Promise<ContainerMetricsSample[]> {
  const teamId = await requireActiveTeamId();
  const app = await loadTeamApp(appId, teamId);
  if (!app) return [];
  return getContainerHistory(app.id);
}

/* ------------------------------------------------------------------ */
/* Database reads                                                      */
/* ------------------------------------------------------------------ */

/** Live metrics for one database (team-scoped). */
export async function getDatabaseMetrics(
  databaseId: string,
): Promise<ContainerMetrics | null> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabaseForTeam(databaseId, teamId);
  if (!db) return null;
  const m = await measureContainerStack(db.id, db.serverId);
  if (m.online && db.saveMetrics) recordContainerSample(toSample(m));
  return m;
}

/** The buffered window for one database (team-scoped). */
export async function getDatabaseMetricsHistory(
  databaseId: string,
): Promise<ContainerMetricsSample[]> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabaseForTeam(databaseId, teamId);
  if (!db) return [];
  return getContainerHistory(db.id);
}

/* ------------------------------------------------------------------ */
/* Toggles (manage_infra, like the fleet monitoring switch)            */
/* ------------------------------------------------------------------ */

/**
 * Flip an app's "Save metrics" switch. `manage_infra` — the same gate as the
 * fleet-wide monitoring toggle and every database mutation (keeping metrics
 * persistence uniformly an infra decision); apps under a folder also clear the
 * per-folder gate. Turning it OFF drops the buffered window: "save" off must
 * mean nothing stays saved, not "stops growing".
 */
export async function setAppSaveMetrics(
  appId: string,
  enabled: boolean,
): Promise<{ saveMetrics: boolean }> {
  const { teamId } = await requireCapability("manage_infra");
  await requireFolderCapabilityForApp(appId, "manage_infra");
  const user = (await getCurrentUser())!;

  const updated = await getDb()
    .update(appsTable)
    .set({ saveMetrics: enabled, updatedAt: nowIso() })
    .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
    .returning({ id: appsTable.id });
  if (updated.length === 0) throw new Error("App not found");

  if (!enabled) clearContainerHistory(appId);
  await recordActivity(
    "app",
    enabled
      ? "Enabled saving metrics for this app"
      : "Disabled saving metrics for this app (buffered history dropped)",
    user.name,
    appId,
  );
  return { saveMetrics: enabled };
}

/** Flip a database's "Save metrics" switch. Mirrors {@link setAppSaveMetrics};
 *  databases already gate every mutation on `manage_infra`. */
export async function setDatabaseSaveMetrics(
  databaseId: string,
  enabled: boolean,
): Promise<{ saveMetrics: boolean }> {
  const { teamId } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;

  const updated = await getDb()
    .update(databasesTable)
    .set({ saveMetrics: enabled })
    .where(and(eq(databasesTable.id, databaseId), eq(databasesTable.teamId, teamId)))
    .returning({ id: databasesTable.id });
  if (updated.length === 0) throw new Error("Not found");

  if (!enabled) clearContainerHistory(databaseId);
  publishDatabaseChanged(databaseId);
  await recordActivity(
    "database",
    enabled
      ? "Enabled saving metrics for this database"
      : "Disabled saving metrics for this database (buffered history dropped)",
    user.name,
    null,
  );
  return { saveMetrics: enabled };
}

/* ------------------------------------------------------------------ */
/* Collector enumerations (session-free)                               */
/* ------------------------------------------------------------------ */

/** Measure one opted-in stack and record it, for the background collector.
 *  Session-free; never throws (an offline/unsupported answer is simply not
 *  recorded, leaving the honest gap). Keeps `toSample` internal to this module. */
export async function sampleContainerForCollector(
  id: string,
  serverId: string,
): Promise<void> {
  const m = await measureContainerStack(id, serverId);
  if (m.online) recordContainerSample(toSample(m));
}

/** id + owning server for every app/database whose Save-metrics switch is ON.
 *  Session-free (no request context) — the background collector's opt-in set,
 *  the same justification as `listAllServers`/`measureServerForCollector`. */
export async function listSaveMetricsTargetsForCollector(): Promise<
  { id: string; serverId: string }[]
> {
  const db = getDb();
  const [appRows, dbRows] = await Promise.all([
    db
      .select({ id: appsTable.id, serverId: appsTable.serverId })
      .from(appsTable)
      .where(eq(appsTable.saveMetrics, true)),
    db
      .select({ id: databasesTable.id, serverId: databasesTable.serverId })
      .from(databasesTable)
      .where(eq(databasesTable.saveMetrics, true)),
  ]);
  return [...appRows, ...dbRows];
}
