"use client";

import * as React from "react";

// AppNavState - the per-app facts the sidebar cannot work out from the URL alone.
export type AppNavState = {
  slug: string;
  logo: string | null;
  running: boolean;
  capabilities: string[];
  isGithubApp: boolean;
  previewsEnabled: boolean;
  cronsEnabled: boolean;
  consoleEnabled: boolean;
};

// Client-only module state: never read during a server render (getServerSnapshot returns null).
let current: AppNavState | null = null;
const listeners = new Set<() => void>();

// setAppNav - publish (or, with null, clear) the active app's nav facts.
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
const getServerSnapshot = (): AppNavState | null => null;

// useAppNav - the active app's nav facts, or null outside an app.
export function useAppNav(): AppNavState | null {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
