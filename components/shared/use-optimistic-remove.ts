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
 *
 * Both waits were real. On this instance a `deleteEnv` takes ~0.3–0.6s, and the
 * `router.refresh()` after it another ~0.5s — because that refresh re-runs the
 * whole page's server reads: every variable of the app, the shared ones, their
 * authors. The delete confirm used to hold the user in front of a spinner for
 * the first half, and then leave the deleted row sitting on screen for the
 * second, with a live delete button under the cursor they had just clicked. A
 * second click there fires a second mutation against a row the server no longer
 * has, so the reward for a successful delete was a red "Not found".
 *
 * So the row is hidden the moment the user confirms, and stays hidden until the
 * refresh actually lands (see `retainRemoved` for how a key is retired). If the
 * mutation is refused, `restore` puts the row back and the caller toasts the
 * server's message against a row the user can see again.
 *
 *     const { visible, remove, restore } = useOptimisticRemove(rows, rowKey);
 *     // …in the confirm dialog (ConfirmAction with `optimistic`, which closes
 *     // on the click so the row and the dialog leave in the same frame):
 *     const key = rowKey(row);
 *     remove(key);
 *     const res = await gqlAction(DELETE, { id: row.id });
 *     if (res.ok) router.refresh();
 *     else restore(key);
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
  const [removed, setRemoved] = React.useState<ReadonlySet<string>>(
    NOTHING_REMOVED,
  );

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
