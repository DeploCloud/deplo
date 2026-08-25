/**
 * The bookkeeping behind an optimistically removed row: which keys are still worth
 * hiding, and what a list looks like without them.
 */

/** "Nothing is hidden" - one shared reference, so it compares equal to itself. */
export const NOTHING_REMOVED: ReadonlySet<string> = new Set<string>();

/**
 * Narrow the hidden keys to those the server is STILL serving. Returns the SAME
 * set when nothing retires: the caller stores this in React state during render,
 * and a fresh-but-equal set there would re-render forever.
 */
export function retainRemoved(
  removed: ReadonlySet<string>,
  presentKeys: Iterable<string>,
): ReadonlySet<string> {
  if (removed.size === 0) return removed;
  const present =
    presentKeys instanceof Set ? presentKeys : new Set(presentKeys);
  const kept = [...removed].filter((key) => present.has(key));
  if (kept.length === removed.size) return removed;
  return kept.length === 0 ? NOTHING_REMOVED : new Set(kept);
}

/**
 * The key of an element as `React.Children.toArray` hands it back. Reading the
 * part after the last `$` covers both, and any deeper nesting the same way.
 */
export function childKey(child: { key?: string | null }): string {
  const key = child.key;
  if (key == null) return "";
  const marker = key.lastIndexOf("$");
  return marker < 0 ? key : key.slice(marker + 1);
}

/**
 * The list without the hidden keys, and the list ITSELF when nothing is hidden,
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
