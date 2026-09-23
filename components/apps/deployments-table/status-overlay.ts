// Records `id`'s live status and forgets ids no longer on screen, so a long session stays small.
export function withLiveStatus<S>(
  prev: ReadonlyMap<string, S>,
  id: string,
  status: S,
  onScreen: ReadonlySet<string>,
): ReadonlyMap<string, S> {
  if (prev.get(id) === status) return prev;
  const next = new Map<string, S>();
  for (const [k, v] of prev) if (onScreen.has(k)) next.set(k, v);
  next.set(id, status);
  return next;
}
