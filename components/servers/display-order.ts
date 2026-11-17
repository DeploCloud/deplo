const UNPLACED = Number.MAX_SAFE_INTEGER;

/** Placed ones by position, the rest after them as they came; `first` leads until someone places it. */
export function inDisplayOrder<T extends { id: string }>(
  items: T[],
  positions: Map<string, number>,
  first?: (item: T) => boolean,
): T[] {
  const key = (t: T) => positions.get(t.id) ?? (first?.(t) ? -1 : UNPLACED);
  return [...items].sort((a, b) => key(a) - key(b));
}

/** `items` in `order`, with any not in it (just added) at the end as they came. */
export function byOrder<T extends { id: string }>(
  items: T[],
  order: string[],
): T[] {
  const at = new Map(order.map((id, i) => [id, i]));
  return inDisplayOrder(items, at);
}
