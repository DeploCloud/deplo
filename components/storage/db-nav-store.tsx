"use client";

import * as React from "react";

import type { DatabaseType } from "@/lib/types/database";

// DbNavState holds the per-database facts the global sidebar cannot work out on its own.
export type DbNavState = {
  id: string;
  cronsEnabled: boolean;
  logo: string | null;
  type: DatabaseType;
};

// Client-only module state: never read during a server render (getServerSnapshot returns null).
let current: DbNavState | null = null;
const listeners = new Set<() => void>();

// setDbNav publishes (or, with null, clears) the active database's nav facts.
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

// useDbNav returns the active database's nav facts, or null when not inside one.
export function useDbNav(): DbNavState | null {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// DbNavSync publishes them from the database layout and renders nothing.
// It clears only on unmount, so moving between a database's pages never blinks the sub-menu empty.
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
