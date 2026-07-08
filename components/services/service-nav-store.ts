"use client";

import * as React from "react";

/**
 * The per-service facts the global sidebar can't work out on its own. The slug
 * comes from the URL and the capability-gated entries (Environment, Backups)
 * come from the sidebar's own capability list — but whether the container is
 * *running* (Console/Logs), whether the service is dev-eligible (Dev Mode) and
 * whether it has an on-disk files dir (Files) are known only to the service
 * layout. It publishes them here so the sidebar's service sub-menu can offer the
 * same entries the old horizontal tabs did.
 */
export type ServiceNavState = {
  slug: string;
  running: boolean;
  devEligible: boolean;
  showFiles: boolean;
};

// Client-only module state: each browser tab owns its own instance. It is never
// read during a server render (getServerSnapshot returns null), so the usual
// "module state leaks across requests" hazard doesn't apply here.
let current: ServiceNavState | null = null;
const listeners = new Set<() => void>();

/** Publish (or, with null, clear) the active service's nav facts. */
export function setServiceNav(next: ServiceNavState | null): void {
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
// SSR (and the first, pre-effect client render) has no per-service facts yet, so
// the sidebar renders its base entries only — no hydration mismatch.
const getServerSnapshot = (): ServiceNavState | null => null;

/**
 * The active service's nav facts, or null when not inside a service (or before
 * the service layout has published them on first paint).
 */
export function useServiceNav(): ServiceNavState | null {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
