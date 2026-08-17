"use client";

import * as React from "react";
import { childKey } from "@/lib/optimistic-remove";
import { useOptimisticRemove } from "./use-optimistic-remove";

/**
 * Optimistic removal for a list an RSC page maps itself.
 *
 * `useOptimisticRemove` needs the ARRAY, which a client component has and a
 * server-rendered page does not: the page maps its rows and the rows own their
 * delete. Rather than lifting three such lists (domains, backup destinations,
 * backup schedules) into client components that would have to re-declare every
 * prop, this wraps the rows the page already rendered and hides them by key —
 * the same bookkeeping, one component up.
 *
 *     <OptimisticList>
 *       {domains.map((d) => <DomainRow key={d.id} domain={d} … />)}
 *       <PendingRows columns={3} />        // no key of its own: never hidden
 *     </OptimisticList>
 *
 * and inside the row:
 *
 *     const { hide, restore } = useOptimisticRow(domain.id);
 *
 * A row used outside a list (there are a few) gets a no-op pair rather than a
 * crash: it simply waits for the refresh, which is exactly what it does today.
 */
type OptimisticListApi = {
  hide: (key: string) => void;
  restore: (key: string) => void;
};

const OptimisticListContext = React.createContext<OptimisticListApi | null>(
  null,
);

export function OptimisticList({ children }: { children: React.ReactNode }) {
  // toArray drops null/undefined children and namespaces the keys — `childKey`
  // is the other half of that contract.
  const items = React.Children.toArray(children);
  const { visible, remove, restore } = useOptimisticRemove(items, (child) =>
    childKey(child as { key?: string | null }),
  );
  const api = React.useMemo(
    () => ({ hide: remove, restore }),
    [remove, restore],
  );
  return (
    <OptimisticListContext.Provider value={api}>
      {visible}
    </OptimisticListContext.Provider>
  );
}

export function useOptimisticRow(key: string): {
  /** Take this row off the list until the server stops serving it. */
  hide: () => void;
  /** Put it back — the mutation behind the removal was refused. */
  restore: () => void;
} {
  const ctx = React.useContext(OptimisticListContext);
  return React.useMemo(
    () => ({
      hide: () => ctx?.hide(key),
      restore: () => ctx?.restore(key),
    }),
    [ctx, key],
  );
}
