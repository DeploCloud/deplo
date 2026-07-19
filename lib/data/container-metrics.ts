import "server-only";

import { requireActiveTeamId } from "../membership";
import { loadTeamApp } from "./app-graph-load";
import { loadDatabaseForTeam } from "./databases";
import type { ContainerStat as PbContainerStat } from "../agent/gen/agent";
import {
  getContainerHistory,
  latestContainerSample,
  latestContainerInstances,
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
export function aggregateContainerStats(
  id: string,
  stats: PbContainerStat[],
  ts: number,
): ContainerMetrics {
  return aggregate(id, stats, ts);
}

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
/** The two pure folds the telemetry-stream supervisor reuses to demux a
 *  host-wide frame. Exported (rather than moved) so the poll path and the stream
 *  path cannot drift into aggregating the same containers two different ways. */
export function toContainerSample(m: ContainerMetrics): ContainerMetricsSample {
  return toSample(m);
}

function toSample(m: ContainerMetrics): ContainerMetricsSample {
  // Deliberately drop `instances` (the breakdown is a live-only table) and
  // `unsupported` (never true for a recorded, online sample) to keep the RAM
  // window lean — rest-sibling omit, like databases.ts toDTO.
  const { unsupported, instances, ...sample } = m;
  void unsupported;
  void instances;
  return sample;
}

/* `measureContainerStack` lived here: one ContainerStats dial per resource, the
 * shape the whole telemetry stream exists to replace. It was the last per-resource
 * agent dial in the control plane and it has no callers left, so it is gone rather
 * than left lying around — a dead path that still dials an agent reads like the
 * architecture endorses dialling per resource, and someone will eventually revive
 * it. The unary ContainerStats RPC itself stays on the agent, serving control
 * planes older than this change.
 */

/* ------------------------------------------------------------------ */
/* App reads                                                           */
/* ------------------------------------------------------------------ */

/**
 * Live metrics for one app (team-scoped). Null for an unknown / cross-team app.
 *
 * A BUFFER READ, not a measurement. The telemetry-stream supervisor is already
 * writing this app's samples every cadence from the host-wide frame, so dialling
 * the agent here would re-measure what we measured moments ago — and it is what
 * made the old cost model scale with the number of people looking.
 *
 * The team-scope gate is unchanged and remains the ONLY thing preventing a
 * cross-team metrics read: `loadTeamApp` returning null is the boundary, and it
 * matters more now than it did, because the buffer itself is not team-scoped.
 */
export async function getAppMetrics(appId: string): Promise<ContainerMetrics | null> {
  const teamId = await requireActiveTeamId();
  const app = await loadTeamApp(appId, teamId);
  if (!app) return null;
  return fromBuffer(app.id);
}

/**
 * Rebuild the live DTO from what the supervisor buffered. `toSample` deliberately
 * strips `instances` (a live table, not a series) and `unsupported` (never true
 * for a recorded sample), so they are re-attached here from their own cells
 * rather than being carried in every point of the window.
 *
 * No buffered sample means the stream has not delivered a frame for this resource
 * yet — the host may be unreachable, or its agent too old to stream. That is an
 * honest "no data", never a fabricated zero.
 */
function fromBuffer(id: string): ContainerMetrics {
  const s = latestContainerSample(id);
  if (!s) return unavailable(id, Date.now(), false);
  return { ...s, unsupported: false, instances: latestContainerInstances(id) };
}

/** The buffered window for one app (team-scoped). Empty for an unknown /
 *  cross-team app, or before anything has been sampled. */
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

/** Live metrics for one database (team-scoped). A buffer read, exactly like
 *  {@link getAppMetrics}. */
export async function getDatabaseMetrics(
  databaseId: string,
): Promise<ContainerMetrics | null> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabaseForTeam(databaseId, teamId);
  if (!db) return null;
  return fromBuffer(db.id);
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
/* Removed with the polling collector                                  */
/* ------------------------------------------------------------------ */

/* This file used to end with two more sections, both deleted.
 *
 * The COLLECTOR ENUMERATIONS went first. `sampleContainerForCollector` measured
 * one stack per tick; the telemetry stream carries every container on a host in
 * one frame, so per-resource sampling has no caller left.
 * `listSaveMetricsTargetsForCollector` answered "which resources should we pay to
 * sample?" — a question that only existed because sampling cost an RPC each.
 *
 * The per-resource TOGGLES (`setAppSaveMetrics` / `setDatabaseSaveMetrics`, and
 * the `apps.save_metrics` / `databases.save_metrics` columns behind them) went
 * with them. They rationed that same RPC cost. Buffering one more resource now
 * costs RAM the frame already delivered, so the answer is "all of them" — a
 * switch whose only remaining effect is declining a few KB, while its tooltip
 * promises it is saving work, is worse than no switch at all. The instance-wide
 * `monitoring_settings.saveMetrics` singleton remains the master switch, applied
 * on the RECORD side. See lib/monitoring/supervisor.ts.
 */

