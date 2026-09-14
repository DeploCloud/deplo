import "server-only";

import type { ServerMetrics } from "../data/monitoring";

// Keep samples this far back - the largest chart window (15m) plus slack.
export const HISTORY_WINDOW_MS = 16 * 60_000;

// Ignore a sample landing within this of the previous one: a rate ceiling, not a de-dupe.
const MIN_GAP_MS = 250;

// Backstop against the window check ever admitting unbounded growth.
const HARD_CAP = 1200;

const STATE_KEY = Symbol.for("deplo.monitoring.history");
const g = globalThis as unknown as {
  [STATE_KEY]?: Map<string, ServerMetrics[]>;
};
const buffers: Map<string, ServerMetrics[]> = (g[STATE_KEY] ??= new Map());

function evict(buf: ServerMetrics[], now: number): void {
  const cutoff = now - HISTORY_WINDOW_MS;
  let drop = 0;
  while (drop < buf.length && buf[drop].ts < cutoff) drop++;
  if (buf.length - drop > HARD_CAP) drop = buf.length - HARD_CAP;
  if (drop > 0) buf.splice(0, drop);
}

export function recordMetricsSample(sample: ServerMetrics): void {
  if (!sample.online) return;
  const buf = buffers.get(sample.serverId) ?? [];
  const last = buf[buf.length - 1];
  if (last && sample.ts - last.ts < MIN_GAP_MS) return;
  buf.push(sample);
  evict(buf, sample.ts);
  buffers.set(sample.serverId, buf);
}

// The buffered window for one server, oldest first (a copy - callers may not mutate).
export function getMetricsHistory(serverId: string): ServerMetrics[] {
  const buf = buffers.get(serverId);
  if (!buf || buf.length === 0) return [];
  evict(buf, Date.now());
  return [...buf];
}

// Epoch ms of the newest buffered sample, or 0 - the collector's "is anyone already feeding this?" probe.
export function latestSampleTs(serverId: string): number {
  const buf = buffers.get(serverId);
  return buf && buf.length > 0 ? buf[buf.length - 1].ts : 0;
}

// Drop every buffer (or one server's): saving turned OFF must mean nothing stays saved, not "stops growing".
export function clearMetricsHistory(serverId?: string): void {
  if (serverId) buffers.delete(serverId);
  else buffers.clear();
}

// Drop buffers for servers that no longer exist, so a removed server's window doesn't linger until restart.
export function pruneMetricsHistoryTo(serverIds: ReadonlySet<string>): void {
  for (const id of buffers.keys()) {
    if (!serverIds.has(id)) buffers.delete(id);
  }
}
