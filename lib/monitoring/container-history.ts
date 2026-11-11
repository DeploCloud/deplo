import "server-only";

import type {
  ContainerInstanceMetrics,
  ContainerMetricsSample,
  MemberShare,
} from "../data/container-metrics";

export const CONTAINER_HISTORY_WINDOW_MS = 16 * 60_000;

const MIN_GAP_MS = 250;

const HARD_CAP = 1200;

const STATE_KEY = Symbol.for("deplo.monitoring.container-history");
const g = globalThis as unknown as {
  [STATE_KEY]?: Map<string, ContainerMetricsSample[]>;
};
const buffers: Map<string, ContainerMetricsSample[]> = (g[STATE_KEY] ??=
  new Map());

function evict(buf: ContainerMetricsSample[], now: number): void {
  const cutoff = now - CONTAINER_HISTORY_WINDOW_MS;
  let drop = 0;
  while (drop < buf.length && buf[drop].ts < cutoff) drop++;
  if (buf.length - drop > HARD_CAP) drop = buf.length - HARD_CAP;
  if (drop > 0) buf.splice(0, drop);
}

// The highest memory reading per workload and hour, for the last day: what placement counts when no limit is set.
// ponytail: in this process like the history, so a restart falls back to the floor until readings return.
const PEAKS_KEY = Symbol.for("deplo.monitoring.container-peaks");
const gp = globalThis as unknown as {
  [PEAKS_KEY]?: Map<string, Map<number, number>>;
};
const peaks: Map<string, Map<number, number>> = (gp[PEAKS_KEY] ??= new Map());
const HOUR_MS = 3_600_000;
const PEAK_HOURS = 24;

function notePeak(id: string, ts: number, memUsed: number): void {
  const hours = peaks.get(id) ?? new Map<number, number>();
  const hour = Math.floor(ts / HOUR_MS);
  hours.set(hour, Math.max(hours.get(hour) ?? 0, memUsed));
  for (const h of hours.keys()) if (h < hour - PEAK_HOURS) hours.delete(h);
  peaks.set(id, hours);
}

/** The workload's 24-hour memory peak in MB, per replica; 0 when nothing was measured. */
export function peakMemoryMb(
  id: string,
  replicas = 1,
  now = Date.now(),
): number {
  const from = Math.floor(now / HOUR_MS) - PEAK_HOURS;
  let peak = 0;
  for (const [hour, used] of peaks.get(id) ?? [])
    if (hour >= from && used > peak) peak = used;
  return Math.ceil(peak / Math.max(replicas, 1) / (1024 * 1024));
}

export function recordContainerSample(sample: ContainerMetricsSample): void {
  if (!sample.online) return;
  notePeak(sample.id, sample.ts, sample.memUsed);
  const buf = buffers.get(sample.id) ?? [];
  const last = buf[buf.length - 1];
  if (last && sample.ts - last.ts < MIN_GAP_MS) return;
  buf.push(sample);
  evict(buf, sample.ts);
  buffers.set(sample.id, buf);
}

export function latestContainerSample(
  id: string,
): ContainerMetricsSample | null {
  const buf = buffers.get(id);
  return buf && buf.length > 0 ? buf[buf.length - 1] : null;
}

const INSTANCES_KEY = Symbol.for("deplo.monitoring.container-instances");
const gi = globalThis as unknown as {
  [INSTANCES_KEY]?: Map<string, ContainerInstanceMetrics[]>;
};
const instances: Map<string, ContainerInstanceMetrics[]> = (gi[
  INSTANCES_KEY
] ??= new Map());

export function recordContainerInstances(
  id: string,
  rows: ContainerInstanceMetrics[],
): void {
  instances.set(id, rows);
}

export function latestContainerInstances(
  id: string,
): ContainerInstanceMetrics[] {
  return instances.get(id) ?? [];
}

export function getContainerHistory(id: string): ContainerMetricsSample[] {
  const buf = buffers.get(id);
  if (!buf || buf.length === 0) return [];
  evict(buf, Date.now());
  return [...buf];
}

export function latestContainerSampleTs(id: string): number {
  const buf = buffers.get(id);
  return buf && buf.length > 0 ? buf[buf.length - 1].ts : 0;
}

export function clearContainerHistory(id?: string): void {
  if (id) {
    buffers.delete(id);
    instances.delete(id);
    spreads.delete(id);
    peaks.delete(id);
  } else {
    buffers.clear();
    instances.clear();
    spreads.clear();
    peaks.clear();
  }
}

// Only deletion forgets a resource: a container merely absent from a frame must not be pruned.
export function pruneContainerHistoryTo(ids: ReadonlySet<string>): void {
  for (const id of buffers.keys()) {
    if (!ids.has(id)) buffers.delete(id);
  }
  for (const id of instances.keys()) {
    if (!ids.has(id)) instances.delete(id);
  }
  for (const id of spreads.keys()) {
    if (!ids.has(id)) spreads.delete(id);
  }
  for (const id of peaks.keys()) {
    if (!ids.has(id)) peaks.delete(id);
  }
}

// Two and a half stream intervals: a server silent for longer is out of the total.
export const MEMBER_FRESH_MS = 12_500;

interface MemberCell {
  sample: ContainerMetricsSample;
  rows: ContainerInstanceMetrics[];
  // The reading of this server the last total counted, so its counters add only what came since.
  counted: ContainerMetricsSample | null;
}

interface Spread {
  members: Map<string, MemberCell>;
  // Sticky once two servers reported together: from then on the counters are summed deltas, never one server's own.
  summed: boolean;
}

const SPREADS_KEY = Symbol.for("deplo.monitoring.container-members");
const gs = globalThis as unknown as { [SPREADS_KEY]?: Map<string, Spread> };
const spreads: Map<string, Spread> = (gs[SPREADS_KEY] ??= new Map());

const COUNTERS = ["netRx", "netTx", "blockRead", "blockWrite"] as const;

const shareOf = (serverId: string, s: ContainerMetricsSample): MemberShare => ({
  serverId,
  cpu: s.cpu,
  memUsed: s.memUsed,
  running: s.running,
});

/**
 * One server's reading of a workload. Alone it is the workload's sample, as it always was; with others, the
 * first server's tick writes the total, so every server's counters advance once between two points.
 */
export function recordMemberSample(
  serverId: string,
  sample: ContainerMetricsSample,
  rows: ContainerInstanceMetrics[],
): void {
  if (!sample.online) return;
  const spread: Spread = spreads.get(sample.id) ?? {
    members: new Map(),
    summed: false,
  };
  spreads.set(sample.id, spread);
  const cell: MemberCell = {
    sample,
    rows,
    counted: spread.members.get(serverId)?.counted ?? null,
  };
  spread.members.set(serverId, cell);
  for (const [id, m] of spread.members)
    if (sample.ts - m.sample.ts > MEMBER_FRESH_MS) spread.members.delete(id);

  if (spread.members.size === 1 && !spread.summed) {
    cell.counted = sample;
    recordContainerInstances(sample.id, rows);
    recordContainerSample({ ...sample, members: [shareOf(serverId, sample)] });
    return;
  }
  spread.summed = true;
  const ids = [...spread.members.keys()].sort();
  if (ids[0] !== serverId) return;
  const last = latestContainerSample(sample.id);
  if (last && sample.ts - last.ts < MIN_GAP_MS) return;

  const cells = ids.map((id) => spread.members.get(id)!);
  const sum = (f: (s: ContainerMetricsSample) => number) =>
    cells.reduce((a, m) => a + f(m.sample), 0);
  const total: ContainerMetricsSample = {
    ...sample,
    cpu: sum((s) => s.cpu),
    memUsed: sum((s) => s.memUsed),
    memLimit: sum((s) => s.memLimit),
    pids: sum((s) => s.pids),
    running: sum((s) => s.running),
    containers: sum((s) => s.containers),
    hostCores: sum((s) => s.hostCores),
    members: ids.map((id, i) => shareOf(id, cells[i].sample)),
  };
  total.memPct =
    total.memLimit > 0 ? (total.memUsed / total.memLimit) * 100 : 0;
  for (const k of COUNTERS)
    total[k] =
      (last?.[k] ?? 0) +
      cells.reduce(
        (a, m) => a + (m.counted ? Math.max(0, m.sample[k] - m.counted[k]) : 0),
        0,
      );
  for (const m of cells) m.counted = m.sample;
  recordContainerInstances(
    sample.id,
    ids.flatMap((id, i) => cells[i].rows.map((r) => ({ ...r, serverId: id }))),
  );
  recordContainerSample(total);
}

/** A server's frame arrived without these workloads: it no longer runs them, so it leaves their totals now. */
export function dropMemberSamples(
  serverId: string,
  seen: { has(id: string): boolean },
): void {
  for (const [id, spread] of spreads)
    if (!seen.has(id)) spread.members.delete(serverId);
}

/** The servers whose readings of a workload are recent enough to be in its total. */
export function freshMemberIds(id: string, now = Date.now()): string[] {
  const out: string[] = [];
  for (const [serverId, m] of spreads.get(id)?.members ?? [])
    if (now - m.sample.ts <= MEMBER_FRESH_MS) out.push(serverId);
  return out.sort();
}
