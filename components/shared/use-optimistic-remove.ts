"use client";

import * as React from "react";
import {
  NOTHING_REMOVED,
  retainRemoved,
  withoutRemoved,
} from "@/lib/optimistic-remove";

export function useOptimisticRemove<T>(
  items: T[],
  keyOf: (item: T) => string,
): {
  visible: T[];
  remove: (key: string) => void;
  restore: (key: string) => void;
} {
  const [removed, setRemoved] =
    React.useState<ReadonlySet<string>>(NOTHING_REMOVED);

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
