"use client";

import * as React from "react";
import {
  NOTHING_REMOVED,
  retainRemoved,
  withoutRemoved,
} from "@/lib/optimistic-remove";

/**
 * Optimistic removal: a deleted row leaves the list on the CLICK, not when the
 * server answers and certainly not when the RSC refresh behind it lands.
 */
export function useOptimisticRemove<T>(
  items: T[],
  keyOf: (item: T) => string,
): {
  /** `items`, minus the removals whose refresh hasn't landed yet. */
  visible: T[];
  /** Hide a key from `visible` until the server stops serving it. */
  remove: (key: string) => void;
  /** Put a key back — the mutation behind the removal was refused. */
  restore: (key: string) => void;
} {
  const [removed, setRemoved] =
    React.useState<ReadonlySet<string>>(NOTHING_REMOVED);

  // Retire the keys the server has stopped serving. Adjusting state during
  // render is React's own derive-from-props escape hatch; an effect would run
  // after the commit, which is one painted frame of a stale hide.
  const pending =
    removed.size === 0 ? removed : retainRemoved(removed, items.map(keyOf));
  if (pending !== removed) setRemoved(pending);

  const remove = React.useCallback((key: string) => {
    setRemoved((prev) => new Set(prev).add(key));
  }, []);

  const restore = React.useCallback((key: string) => {
    setRemoved((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next.size > 0 ? next : NOTHING_REMOVED;
    });
  }, []);

  return { visible: withoutRemoved(items, pending, keyOf), remove, restore };
}
