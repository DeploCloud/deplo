"use client";

import * as React from "react";

/**
 * The per-app facts the global sidebar can't work out on its own. The slug
 * comes from the URL and the capability-gated entries (Environment, Backups)
 * come from the sidebar's own capability list — but whether the container is
 * *running* (Console/Logs), whether the app is dev-eligible (Dev Mode) and
 * whether it has an on-disk files dir (Files) are known only to the app
 * layout. It publishes them here so the sidebar's app sub-menu can offer the
 * same entries the old horizontal tabs did.
 */
export type AppNavState = {
  slug: string;
  running: boolean;
  devEligible: boolean;
  showFiles: boolean;
};

// Client-only module state: each browser tab owns its own instance. It is never
// read during a server render (getServerSnapshot returns null), so the usual
// "module state leaks across requests" hazard doesn't apply here.
let current: AppNavState | null = null;
const listeners = new Set<() => void>();

/** Publish (or, with null, clear) the active app's nav facts. */
export function setAppNav(next: AppNavState | null): void {
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
// SSR (and the first, pre-effect client render) has no per-app facts yet, so
// the sidebar renders its base entries only — no hydration mismatch.
const getServerSnapshot = (): AppNavState | null => null;

/**
 * The active app's nav facts, or null when not inside an app (or before
 * the app layout has published them on first paint).
 */
export function useAppNav(): AppNavState | null {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
