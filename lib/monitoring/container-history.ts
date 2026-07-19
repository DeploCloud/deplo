import "server-only";

import type {
  ContainerInstanceMetrics,
  ContainerMetricsSample,
} from "../data/container-metrics";

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
 * WHICH ids fill used to be the hard part here, and it no longer is. Under the
 * telemetry stream (lib/monitoring/supervisor.ts) there is ONE writer per host,
 * and its frames already carry every Deplo-managed container on that host —
 * so the marginal cost of buffering one more resource is RAM, not an agent RPC.
 * We therefore buffer everything the stream reports, and the two opt-ins that
 * existed purely to ration RPCs (a per-resource `save_metrics` column and a
 * recently-watched TTL) are gone. What remains is the instance-wide
 * `monitoring_settings.saveMetrics` master switch, applied on the RECORD side.
 *
 * Singleton on `globalThis` via `Symbol.for(...)`, like the server history, so
 * the GraphQL route and the RSC pages share one buffer across Next's module
 * graphs.
 */

/** Keep samples this far back — the largest chart window (15m) plus slack. */
export const CONTAINER_HISTORY_WINDOW_MS = 16 * 60_000;

/**
 * Ignore a sample landing within this of the previous one. A RATE CEILING, not a
 * de-dupe — see the identical constant in history.ts for why the distinction
 * matters and why it sits below the agent's 1000ms cadence clamp floor.
 */
const MIN_GAP_MS = 250;

/** Backstop against unbounded growth if both the window + gap guards misbehave.
 *  Sized for the fastest cadence the agent will serve (1s), not the default 5s —
 *  see history.ts. */
const HARD_CAP = 1200;

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

/** The newest buffered sample for one app/database, or null. This is what a LIVE
 *  read returns now: under the telemetry stream the supervisor is already writing
 *  this buffer every cadence, so dialling the agent again inside a read would be
 *  a second, redundant measurement of something we just measured. */
export function latestContainerSample(id: string): ContainerMetricsSample | null {
  const buf = buffers.get(id);
  return buf && buf.length > 0 ? buf[buf.length - 1] : null;
}

/**
 * The per-container BREAKDOWN behind the Monitoring tab's instances table.
 *
 * Kept as a single latest-value cell per resource, NOT in the ring buffer, and
 * the distinction is the whole point: the breakdown is a live table, not a
 * series. Nobody charts it, so it needs no history — and putting it in the window
 * would multiply every sample by the container count, which is what `toSample`
 * strips it out to avoid. One snapshot per resource is flat in the window length.
 */
const INSTANCES_KEY = Symbol.for("deplo.monitoring.container-instances");
const gi = globalThis as unknown as {
  [INSTANCES_KEY]?: Map<string, ContainerInstanceMetrics[]>;
};
const instances: Map<string, ContainerInstanceMetrics[]> = (gi[INSTANCES_KEY] ??=
  new Map());

/** Replace one resource's live breakdown (the supervisor calls this per frame). */
export function recordContainerInstances(
  id: string,
  rows: ContainerInstanceMetrics[],
): void {
  instances.set(id, rows);
}

/** The last known breakdown for one resource — empty before the first frame. */
export function latestContainerInstances(id: string): ContainerInstanceMetrics[] {
  return instances.get(id) ?? [];
}

/** The buffered window for one app/database, oldest first (a copy). */
export function getContainerHistory(id: string): ContainerMetricsSample[] {
  const buf = buffers.get(id);
  if (!buf || buf.length === 0) return [];
  evict(buf, Date.now());
  return [...buf];
}

/** Epoch ms of the newest buffered sample, or 0. Repurposed from the collector's
 *  "is a viewer already feeding this id?" freshness probe into the supervisor's
 *  stream-liveness watchdog: a connection that claims to be up but has produced
 *  no frame in well over a cadence is wedged, and forcing a reconnect recovers it
 *  faster than waiting for a transport error that may never arrive. */
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
 * Drop buffers for ids that no longer EXIST — deleted apps/databases. Callers
 * pass the live set of resource ids.
 *
 * A container merely ABSENT from a frame must NOT be pruned here, and that is a
 * behavioural change from the poll era. A container that stopped is precisely
 * when its trailing window is worth the most: the operator wants to see the CPU
 * spike or the memory climb that preceded it. Pruning on absence would erase the
 * evidence at the exact moment it became interesting. So absence is a GAP in the
 * series (the chart already renders that honestly), never a reason to forget.
 */
export function pruneContainerHistoryTo(ids: ReadonlySet<string>): void {
  for (const id of buffers.keys()) {
    if (!ids.has(id)) buffers.delete(id);
  }
}
