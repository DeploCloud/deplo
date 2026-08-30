"use client";

import * as React from "react";
import { childKey } from "@/lib/optimistic-remove";
import { useOptimisticRemove } from "./use-optimistic-remove";

/**
 * Optimistic removal for a list an RSC page maps itself.
 */
type OptimisticListApi = {
  hide: (key: string) => void;
  restore: (key: string) => void;
};

const OptimisticListContext = React.createContext<OptimisticListApi | null>(
  null,
);

export function OptimisticList({ children }: { children: React.ReactNode }) {
  // toArray drops null/undefined children and namespaces the keys - `childKey`
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
  /** Put it back - the mutation behind the removal was refused. */
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
