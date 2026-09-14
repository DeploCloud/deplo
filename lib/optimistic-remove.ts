// NOTHING_REMOVED - one shared reference for "nothing is hidden", so it compares equal to itself.
export const NOTHING_REMOVED: ReadonlySet<string> = new Set<string>();

// retainRemoved returns the SAME set when nothing retires - a fresh-but-equal set in React state re-renders forever.
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

// childKey is an element's key as React.Children.toArray hands it back (after the last "$").
export function childKey(child: { key?: string | null }): string {
  const key = child.key;
  if (key == null) return "";
  const marker = key.lastIndexOf("$");
  return marker < 0 ? key : key.slice(marker + 1);
}

// withoutRemoved is the list without the hidden keys, and the list ITSELF when nothing is hidden.
export function withoutRemoved<T>(
  items: T[],
  removed: ReadonlySet<string>,
  keyOf: (item: T) => string,
): T[] {
  if (removed.size === 0) return items;
  return items.filter((item) => !removed.has(keyOf(item)));
}
