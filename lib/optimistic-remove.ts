/**
 * The bookkeeping behind an optimistically removed row: which keys are still
 * worth hiding, and what a list looks like without them.
 *
 * Pure and free of React on purpose — this is the part with the rules (when a
 * hidden key is retired, when the list keeps its identity), so it is the part
 * worth testing without a renderer. The hook that owns the state is
 * `components/shared/use-optimistic-remove.ts`.
 */

/** "Nothing is hidden" — one shared reference, so it compares equal to itself. */
export const NOTHING_REMOVED: ReadonlySet<string> = new Set<string>();

/**
 * Narrow the hidden keys to those the server is STILL serving.
 *
 * A key is hidden between "the delete succeeded" and "the refresh carrying that
 * fact arrived". Its disappearance from `presentKeys` is exactly that arrival,
 * so that is when it is retired — per key, so two deletes in flight settle
 * independently, and a row that legitimately comes back later (the shared
 * variable an app re-links to) is not hidden by a stale entry.
 *
 * Returns the SAME set when nothing retires: the caller stores this in React
 * state during render, and a fresh-but-equal set there would re-render forever.
 */
export function retainRemoved(
  removed: ReadonlySet<string>,
  presentKeys: Iterable<string>,
): ReadonlySet<string> {
  if (removed.size === 0) return removed;
  const present = presentKeys instanceof Set ? presentKeys : new Set(presentKeys);
  const kept = [...removed].filter((key) => present.has(key));
  if (kept.length === removed.size) return removed;
  return kept.length === 0 ? NOTHING_REMOVED : new Set(kept);
}

/**
 * The list without the hidden keys — and the list ITSELF when nothing is hidden,
 * so the steady state never hands the memos downstream (facets, filter counts) a
 * freshly allocated copy of an unchanged list.
 */
export function withoutRemoved<T>(
  items: T[],
  removed: ReadonlySet<string>,
  keyOf: (item: T) => string,
): T[] {
  if (removed.size === 0) return items;
  return items.filter((item) => !removed.has(keyOf(item)));
}
