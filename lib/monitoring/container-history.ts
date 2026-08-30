// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import type {
  ContainerInstanceMetrics,
  ContainerMetricsSample,
} from "../data/container-metrics";

/**
 * Per-CONTAINER (per-app / per-database) metrics HISTORY - the sibling of {@link
 * import("./history")} for the Monitoring TAB on an app or database page.
 */

/** Keep samples this far back - the largest chart window (15m) plus slack. */
export const CONTAINER_HISTORY_WINDOW_MS = 16 * 60_000;

/**
 * Ignore a sample landing within this of the previous one. A RATE CEILING, not a
 * de-dupe - see the identical constant in history.ts for why the distinction
 * matters and why it sits below the agent's 1000ms cadence clamp floor.
 */
const MIN_GAP_MS = 250;

/** Backstop against unbounded growth if both the window + gap guards misbehave.
 *  Sized for the fastest cadence the agent will serve (1s), not the default 5s -
 *  see history.ts. */
const HARD_CAP = 1200;

const STATE_KEY = Symbol.for("deplo.monitoring.container-history");
const g = globalThis as unknown as {
  [STATE_KEY]?: Map<string, ContainerMetricsSample[]>;
};
const buffers: Map<string, ContainerMetricsSample[]> = (g[STATE_KEY] ??=
  new Map());

/** Drop samples older than the window from the FRONT of one buffer, in place. */
function evict(buf: ContainerMetricsSample[], now: number): void {
  const cutoff = now - CONTAINER_HISTORY_WINDOW_MS;
  let drop = 0;
  while (drop < buf.length && buf[drop].ts < cutoff) drop++;
  if (buf.length - drop > HARD_CAP) drop = buf.length - HARD_CAP;
  if (drop > 0) buf.splice(0, drop);
}

/**
 * Append one MEASUREMENT to its resource's buffer.
 */
export function recordContainerSample(sample: ContainerMetricsSample): void {
  if (!sample.online) return;
  const buf = buffers.get(sample.id) ?? [];
  const last = buf[buf.length - 1];
  if (last && sample.ts - last.ts < MIN_GAP_MS) return;
  buf.push(sample);
  evict(buf, sample.ts);
  buffers.set(sample.id, buf);
}

/**
 * The newest buffered sample for one app/database, or null.
 */
export function latestContainerSample(
  id: string,
): ContainerMetricsSample | null {
  const buf = buffers.get(id);
  return buf && buf.length > 0 ? buf[buf.length - 1] : null;
}

/**
 * The per-container BREAKDOWN behind the Monitoring tab's instances table.
 */
const INSTANCES_KEY = Symbol.for("deplo.monitoring.container-instances");
const gi = globalThis as unknown as {
  [INSTANCES_KEY]?: Map<string, ContainerInstanceMetrics[]>;
};
const instances: Map<string, ContainerInstanceMetrics[]> = (gi[
  INSTANCES_KEY
] ??= new Map());

/** Replace one resource's live breakdown (the supervisor calls this per frame). */
export function recordContainerInstances(
  id: string,
  rows: ContainerInstanceMetrics[],
): void {
  instances.set(id, rows);
}

/** The last known breakdown for one resource - empty before the first frame. */
export function latestContainerInstances(
  id: string,
): ContainerInstanceMetrics[] {
  return instances.get(id) ?? [];
}

/** The buffered window for one app/database, oldest first (a copy). */
export function getContainerHistory(id: string): ContainerMetricsSample[] {
  const buf = buffers.get(id);
  if (!buf || buf.length === 0) return [];
  evict(buf, Date.now());
  return [...buf];
}

/**
 * Epoch ms of the newest buffered sample, or 0.
 */
export function latestContainerSampleTs(id: string): number {
  const buf = buffers.get(id);
  return buf && buf.length > 0 ? buf[buf.length - 1].ts : 0;
}

/**
 * Drop one resource's buffer (or all). Called when the app/database is deleted,
 * when the instance-wide "Save metrics" master switch goes OFF (off must mean
 * nothing stays saved, not "stops growing"), and by tests.
 */
export function clearContainerHistory(id?: string): void {
  if (id) {
    buffers.delete(id);
    instances.delete(id);
  } else {
    buffers.clear();
    instances.clear();
  }
}

/**
 * Drop buffers for ids that no longer EXIST - deleted apps/databases. A container
 * merely ABSENT from a frame must NOT be pruned here, and that is a behavioural
 * change from the poll era.
 */
export function pruneContainerHistoryTo(ids: ReadonlySet<string>): void {
  for (const id of buffers.keys()) {
    if (!ids.has(id)) buffers.delete(id);
  }
  // The breakdown CELL rides the same lifecycle: a deleted resource must not
  // keep last week's containers renderable beside a forgotten chart.
  for (const id of instances.keys()) {
    if (!ids.has(id)) instances.delete(id);
  }
}
