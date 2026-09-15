"use client";

import * as React from "react";
import { childKey } from "@/lib/optimistic-remove";
import { useOptimisticRemove } from "./use-optimistic-remove";

type OptimisticListApi = {
  hide: (key: string) => void;
  restore: (key: string) => void;
};

const OptimisticListContext = React.createContext<OptimisticListApi | null>(
  null,
);

export function OptimisticList({ children }: { children: React.ReactNode }) {
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
  hide: () => void;
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
