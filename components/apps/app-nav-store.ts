"use client";

import * as React from "react";

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

let current: AppNavState | null = null;
const listeners = new Set<() => void>();

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

export function useAppNav(): AppNavState | null {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
