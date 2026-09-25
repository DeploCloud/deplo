export interface OomSample {
  name: string;
  containerId: string;
  oomKills: number;
}

const KEY = Symbol.for("deplo.monitoring.oom");
const baselines = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map<
  string,
  OomSample
>()) as Map<string, OomSample>;

/**
 * Containers the kernel killed for memory since the last sample. The first sighting only
 * records a baseline: after a Deplo restart the agent's running count is not news.
 * `samples` is the WHOLE host's set, which is also what prunes containers that are gone.
 */
export function newOomKills(
  serverId: string,
  samples: readonly OomSample[],
): OomSample[] {
  const seen = new Set<string>();
  const hits: OomSample[] = [];
  for (const s of samples) {
    const key = `${serverId}:${s.name}`;
    seen.add(key);
    const prev = baselines.get(key);
    baselines.set(key, s);
    if (prev?.containerId === s.containerId && s.oomKills > prev.oomKills)
      hits.push(s);
  }
  for (const key of baselines.keys())
    if (key.startsWith(`${serverId}:`) && !seen.has(key)) baselines.delete(key);
  return hits;
}
