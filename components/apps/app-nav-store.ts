"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

/**
 * The per-app facts the global sidebar can't work out on its own: the slug comes
 * from the URL, but whether the container is *running* (Console/Logs) and what
 * this viewer may do to THIS app are
 */
export type AppNavState = {
  slug: string;
  /** The app's own logo, so its Overview entry is marked with the app itself. */
  logo: string | null;
  running: boolean;
  /** The viewer's effective capabilities on this app. */
  capabilities: string[];
  /** The app deploys from GitHub - the only source that gets pull requests. */
  isGithubApp: boolean;
  /** Pull request previews are switched on. */
  previewsEnabled: boolean;
  /** Cron jobs are switched on. */
  cronsEnabled: boolean;
  /** The container console is switched on. */
  consoleEnabled: boolean;
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
// the sidebar renders its base entries only, no hydration mismatch.
const getServerSnapshot = (): AppNavState | null => null;

/**
 * The active app's nav facts, or null when not inside an app (or before
 * the app layout has published them on first paint).
 */
export function useAppNav(): AppNavState | null {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
