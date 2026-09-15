"use client";

import * as React from "react";

import type { DatabaseType } from "@/lib/types/database";

export type DbNavState = {
  id: string;
  cronsEnabled: boolean;
  logo: string | null;
  type: DatabaseType;
};

let current: DbNavState | null = null;
const listeners = new Set<() => void>();

export function setDbNav(next: DbNavState | null): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

const getSnapshot = () => current;
const getServerSnapshot = (): DbNavState | null => null;

export function useDbNav(): DbNavState | null {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function DbNavSync({
  id,
  cronsEnabled,
  logo,
  type,
}: {
  id: string;
  cronsEnabled: boolean;
  logo: string | null;
  type: DatabaseType;
}) {
  React.useEffect(() => {
    setDbNav({ id, cronsEnabled, logo, type });
  }, [id, cronsEnabled, logo, type]);

  React.useEffect(() => () => setDbNav(null), []);

  return null;
}
