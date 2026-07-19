import "server-only";

import type { ServerMetrics } from "../data/monitoring";

/**
 * The server-side metrics HISTORY — a rolling in-memory ring buffer of
 * {@link ServerMetrics} samples per server, so the Monitoring page's charts
 * survive a page reload instead of starting empty (before this, history lived
 * only in the open tab's React state and died with it).
 *
 * Deliberately RAM, not Postgres: a per-second time series over a minutes-long
 * window is ring-buffer data, not relational state — persisting it would write
 * ~17k rows/day/server to answer a question whose horizon is 15 minutes. The
 * trade is explicit: a control-plane restart starts the buffer over, exactly
 * like a reloaded tab did before. Two writers feed it — every live dashboard
 * poll (lib/data/monitoring.ts) and the background collector
 * (lib/monitoring/collector.ts), which only samples servers nobody is watching.
 *
 * Singleton on `globalThis` via `Symbol.for(...)`, like the cleanup scheduler:
 * Next compiles separate module graphs, and a module-level Map would give the
 * GraphQL route and the RSC pages two different "histories".
 */

/** Keep samples this far back — the largest chart window (15m) plus slack. */
export const HISTORY_WINDOW_MS = 16 * 60_000;

/**
 * Ignore a sample landing within this of the previous one.
 *
 * ITS MEANING CHANGED with the telemetry stream. It used to be a DE-DUPE: the
 * live poll ran per VIEWER, so two open tabs would each write the same server's
 * buffer and double its density for no chart benefit. Under the stream there is
 * exactly one writer per host (the supervisor), so nothing is duplicated and
 * this is now a RATE CEILING — the fastest sample rate the buffer will accept.
 *
 * That makes it a silent-truncation hazard rather than a de-dupe: at 700ms it
 * would have quietly discarded every other frame the moment anyone lowered the
 * agent's `interval_ms` below ~1.4Hz, with no error anywhere and a chart that
 * merely looked sparse. 250ms sits below the agent's own clamp floor (1000ms),
 * so at any cadence the agent will actually serve, this guard never fires.
 */
const MIN_GAP_MS = 250;

/**
 * Backstop against the window check ever admitting unbounded growth. This is NOT
 * the operative limit — the 16-minute window is, and at the default 5s cadence it
 * retains ~192 samples.
 *
 * Sized for the FASTEST CADENCE THE AGENT WILL SERVE, not the default one: the
 * agent clamps `interval_ms` to a 1000ms floor, and a full window at 1s is ~960
 * samples. A cap below that would stop being a backstop and start silently
 * shortening the visible history the moment someone lowered the cadence — the
 * same class of invisible degradation MIN_GAP_MS above was carrying. 1200 leaves
 * the window in charge at every legal cadence while still bounding RAM.
 */
const HARD_CAP = 1200;

const STATE_KEY = Symbol.for("deplo.monitoring.history");
const g = globalThis as unknown as {
  [STATE_KEY]?: Map<string, ServerMetrics[]>;
};
const buffers: Map<string, ServerMetrics[]> = (g[STATE_KEY] ??= new Map());

/** Drop samples older than the window from the FRONT of one buffer, in place. */
function evict(buf: ServerMetrics[], now: number): void {
  const cutoff = now - HISTORY_WINDOW_MS;
  let drop = 0;
  while (drop < buf.length && buf[drop].ts < cutoff) drop++;
  if (buf.length - drop > HARD_CAP) drop = buf.length - HARD_CAP;
  if (drop > 0) buf.splice(0, drop);
}

/**
 * Append one MEASUREMENT to its server's buffer. Offline snapshots are refused
 * here (not at each call site) for the same reason the client never charts
 * them: they are placeholders, not measurements — recording their zeros would
 * draw fake dips where the honest rendering is a gap.
 */
export function recordMetricsSample(sample: ServerMetrics): void {
  if (!sample.online) return;
  const buf = buffers.get(sample.serverId) ?? [];
  const last = buf[buf.length - 1];
  if (last && sample.ts - last.ts < MIN_GAP_MS) return;
  buf.push(sample);
  evict(buf, sample.ts);
  buffers.set(sample.serverId, buf);
}

/** The buffered window for one server, oldest first (a copy — callers may not mutate). */
export function getMetricsHistory(serverId: string): ServerMetrics[] {
  const buf = buffers.get(serverId);
  if (!buf || buf.length === 0) return [];
  evict(buf, Date.now());
  return [...buf];
}

/** Epoch ms of the newest buffered sample, or 0 — the collector's "is anyone
 *  already feeding this server?" probe. */
export function latestSampleTs(serverId: string): number {
  const buf = buffers.get(serverId);
  return buf && buf.length > 0 ? buf[buf.length - 1].ts : 0;
}

/**
 * Drop every buffer (or one server's). Called when the operator turns saving
 * OFF — "save metrics on server: off" must mean nothing stays saved, not
 * "stops growing" — and by tests.
 */
export function clearMetricsHistory(serverId?: string): void {
  if (serverId) buffers.delete(serverId);
  else buffers.clear();
}

/** Drop buffers for servers that no longer exist (the collector calls this each
 *  tick with the live fleet), so a removed server's window doesn't linger until
 *  the next restart. */
export function pruneMetricsHistoryTo(serverIds: ReadonlySet<string>): void {
  for (const id of buffers.keys()) {
    if (!serverIds.has(id)) buffers.delete(id);
  }
}
