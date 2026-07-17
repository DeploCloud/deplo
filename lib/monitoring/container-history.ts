import "server-only";

import type { ContainerMetricsSample } from "../data/container-metrics";

/**
 * Per-CONTAINER (per-app / per-database) metrics HISTORY — the sibling of
 * {@link import("./history")} for the Monitoring TAB on an app or database page.
 * Same shape and reasoning as the server history: a rolling in-memory ring
 * buffer of samples, keyed here by the app/database id, so the tab's charts
 * survive a reload instead of starting empty.
 *
 * Deliberately RAM, not Postgres — a per-second time series over a minutes-long
 * window is ring-buffer data, not relational state (see the `history.ts` header
 * and migration 0036). The trade: a control-plane restart starts the buffer over.
 *
 * The crucial difference from the server buffer is that this one only fills for
 * apps/databases whose `save_metrics` flag is ON (default OFF): the two writers
 * — every live tab poll (lib/data/container-metrics.ts) and the background
 * collector (lib/monitoring/collector.ts) — record a sample only when that id
 * opted in. So RAM here is bounded by the NUMBER of opted-in resources, not the
 * whole fleet; turning the switch off drops that id's buffer.
 *
 * Singleton on `globalThis` via `Symbol.for(...)`, like the server history, so
 * the GraphQL route and the RSC pages share one buffer across Next's module
 * graphs.
 */

/** Keep samples this far back — the largest chart window (15m) plus slack. */
export const CONTAINER_HISTORY_WINDOW_MS = 16 * 60_000;

/**
 * Ignore a sample landing within this of the previous one. The live poll runs
 * per VIEWER, so two open tabs on the same app would otherwise double the
 * buffer's density for no chart benefit.
 */
const MIN_GAP_MS = 700;

/** Backstop against unbounded growth if both the window + gap guards misbehave. */
const HARD_CAP = 1500;

const STATE_KEY = Symbol.for("deplo.monitoring.container-history");
const g = globalThis as unknown as {
  [STATE_KEY]?: Map<string, ContainerMetricsSample[]>;
};
const buffers: Map<string, ContainerMetricsSample[]> = (g[STATE_KEY] ??= new Map());

/** Drop samples older than the window from the FRONT of one buffer, in place. */
function evict(buf: ContainerMetricsSample[], now: number): void {
  const cutoff = now - CONTAINER_HISTORY_WINDOW_MS;
  let drop = 0;
  while (drop < buf.length && buf[drop].ts < cutoff) drop++;
  if (buf.length - drop > HARD_CAP) drop = buf.length - HARD_CAP;
  if (drop > 0) buf.splice(0, drop);
}

/**
 * Append one MEASUREMENT to its resource's buffer. Offline snapshots are refused
 * here (not at each call site), for the same reason the server buffer refuses
 * them and the client never charts them: they are placeholders, not
 * measurements — recording their zeros would draw fake dips where the honest
 * rendering is a gap.
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

/** The buffered window for one app/database, oldest first (a copy). */
export function getContainerHistory(id: string): ContainerMetricsSample[] {
  const buf = buffers.get(id);
  if (!buf || buf.length === 0) return [];
  evict(buf, Date.now());
  return [...buf];
}

/** Epoch ms of the newest buffered sample, or 0 — the collector's "is a viewer
 *  already feeding this id?" probe. */
export function latestContainerSampleTs(id: string): number {
  const buf = buffers.get(id);
  return buf && buf.length > 0 ? buf[buf.length - 1].ts : 0;
}

/**
 * Drop one resource's buffer (or all). Called when the operator turns that
 * resource's "Save metrics" switch OFF — off must mean nothing stays saved, not
 * "stops growing" — when the app/database is deleted, and by tests.
 */
export function clearContainerHistory(id?: string): void {
  if (id) buffers.delete(id);
  else buffers.clear();
}

/**
 * Drop buffers for ids that are no longer opted in (the collector calls this
 * each tick with the live opted-in set), so a resource whose switch was flipped
 * off elsewhere — or that was deleted — doesn't linger until the next restart.
 */
export function pruneContainerHistoryTo(ids: ReadonlySet<string>): void {
  for (const id of buffers.keys()) {
    if (!ids.has(id)) buffers.delete(id);
  }
}
