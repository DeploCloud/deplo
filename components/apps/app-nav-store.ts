"use client";

import * as React from "react";

/**
 * The per-app facts the global sidebar can't work out on its own: the slug comes
 * from the URL, but whether the container is *running* (Console/Logs), whether
 * it has an on-disk files dir (Files) and what this viewer may do to THIS app
 * are known only to the app layout, which publishes them here so the sidebar's
 * app sub-menu can offer the same entries the old horizontal tabs did.
 *
 * The capabilities matter because the sidebar's own list is the team-wide union
 * (see the dashboard layout): a member who holds `manage_env` in one folder
 * would otherwise be offered an Environment tab on every app in the team, most
 * of which would then refuse them.
 */
export type AppNavState = {
  slug: string;
  running: boolean;
  showFiles: boolean;
  /** The viewer's effective capabilities on this app. */
  capabilities: string[];
  /** The app deploys from GitHub — the only source that gets pull requests. */
  isGithubApp: boolean;
  /** Pull request previews are switched on. */
  previewsEnabled: boolean;
  /** Cron jobs are switched on. */
  cronsEnabled: boolean;
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
