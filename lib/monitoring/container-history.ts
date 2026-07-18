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
 * The crucial difference from the server buffer is WHICH ids fill. Two writers
 * feed it — every live tab poll (lib/data/container-metrics.ts) and the
 * background collector (lib/monitoring/collector.ts) — across two opt-ins:
 * `save_metrics` being ON (keep sampling with nobody watching) and the resource
 * having been looked at inside {@link WATCH_TTL_MS} (keep the window continuous
 * for whoever is coming back to it). So RAM here is bounded by what is opted in
 * plus what is being watched, not by the whole fleet; turning the switch off
 * drops that id's buffer, and an expired watch lets the collector prune it.
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

/**
 * How long a resource keeps being sampled after someone last looked at it.
 *
 * `save_metrics` defaults OFF, so without this the ONLY writer for almost every
 * app is the viewer's own poll: open the Monitoring tab and history starts from
 * empty, navigate away and it stops dead, come back and the stretch you were
 * away for is a hole. Widening to "Last 15m" then showed mostly "No data" on a
 * stack that was running perfectly — the platform had simply never looked.
 *
 * So a resource someone actually opened stays sampled by the background
 * collector for one full history window afterwards, and the tab reads
 * continuous when they return. Cost is proportional to what is being LOOKED at
 * (a handful of resources), not to the fleet — which is why this is not just
 * "default save_metrics to ON": that would put every app on a permanent 5s agent
 * RPC nobody asked for. The explicit switch keeps its own meaning: sample this
 * resource even when nobody is watching.
 *
 * Matched to the buffer window: once the TTL lapses the window has aged out
 * anyway, so a longer watch would sample into a buffer that is already empty.
 */
const WATCH_TTL_MS = CONTAINER_HISTORY_WINDOW_MS;

const STATE_KEY = Symbol.for("deplo.monitoring.container-history");
const WATCH_KEY = Symbol.for("deplo.monitoring.container-watch");
const g = globalThis as unknown as {
  [STATE_KEY]?: Map<string, ContainerMetricsSample[]>;
  [WATCH_KEY]?: Map<string, { serverId: string; at: number }>;
};
const buffers: Map<string, ContainerMetricsSample[]> = (g[STATE_KEY] ??= new Map());
/** id -> owning server + when a viewer last polled it. See {@link WATCH_TTL_MS}. */
const watched: Map<string, { serverId: string; at: number }> = (g[WATCH_KEY] ??=
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

/* ------------------------------------------------------------------ */
/* Recently-watched set (see WATCH_TTL_MS)                             */
/* ------------------------------------------------------------------ */

/** Note that a viewer just polled this resource, so the collector keeps its
 *  history continuous for {@link WATCH_TTL_MS} after they navigate away. */
export function markContainerWatched(id: string, serverId: string, now = Date.now()): void {
  watched.set(id, { serverId, at: now });
}

/** The resources still inside their watch TTL, with the server to dial. Expired
 *  entries are dropped here (the collector calls this every tick). */
export function watchedContainerTargets(
  now = Date.now(),
): { id: string; serverId: string }[] {
  const live: { id: string; serverId: string }[] = [];
  for (const [id, w] of watched) {
    if (now - w.at > WATCH_TTL_MS) watched.delete(id);
    else live.push({ id, serverId: w.serverId });
  }
  return live;
}

/** Test-only: forget every watch mark (or one id's). */
export function clearContainerWatches(id?: string): void {
  if (id) watched.delete(id);
  else watched.clear();
}
