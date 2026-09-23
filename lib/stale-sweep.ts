// A per-id memo outlives the id it names; once it passes `above` entries, drop the ones
// older than `maxAgeMs` so deleted apps, tokens and databases stop costing memory.
export function sweepStale<K, V>(
  map: Map<K, V>,
  at: (v: V) => number,
  maxAgeMs: number,
  now = Date.now(),
  above = 256,
): void {
  if (map.size <= above) return;
  for (const [k, v] of map) if (now - at(v) > maxAgeMs) map.delete(k);
}
