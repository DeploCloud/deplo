"use client";

import * as React from "react";

import type { DatabaseType } from "@/lib/types";

/**
 * The per-database facts the global sidebar cannot work out on its own.
 *
 * `databaseNav` was deliberately flag-less until cron jobs: Logs works while the
 * database is stopped and Backups guards itself, so nothing there depended on
 * live state. Cron jobs does - its tab appears only once the feature is switched
 * on for that database, exactly as an app's does - and the sidebar lives OUTSIDE
 * the database layout, so a React context cannot reach it. Hence the same
 * module-state + `useSyncExternalStore` bridge the app nav uses.
 *
 * Kept to the one flag it needs. If a second ever appears, this is the file that
 * grows, not `databaseNav`'s signature.
 */
export type DbNavState = {
  id: string;
  /** Cron jobs are switched on for this database. */
  cronsEnabled: boolean;
  /** Its own logo, and the engine behind it — the mark on the Overview entry,
   *  the same picture Storage lists the database under. */
  logo: string | null;
  type: DatabaseType;
};

// Client-only module state: each browser tab owns its own instance, and it is
// never read during a server render (getServerSnapshot returns null).
let current: DbNavState | null = null;
const listeners = new Set<() => void>();

/** Publish (or, with null, clear) the active database's nav facts. */
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

/** The active database's nav facts, or null when not inside one. */
export function useDbNav(): DbNavState | null {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Publishes them from the database layout. Renders nothing; clears only on
 * unmount, so navigating between a database's own pages never blinks the
 * sub-menu through an empty state.
 */
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
