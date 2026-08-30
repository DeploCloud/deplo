"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import type { DatabaseType } from "@/lib/types";

/**
 * The per-database facts the global sidebar cannot work out on its own.
 */
export type DbNavState = {
  id: string;
  /** Cron jobs are switched on for this database. */
  cronsEnabled: boolean;
  /** Its own logo, and the engine behind it - the mark on the Overview entry,
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
