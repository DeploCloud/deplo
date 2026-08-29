"use client";

import * as React from "react";

/**
 * Who opens the command palette. A module store rather than a provider: it is
 * one boolean that two buttons write and one component reads, so `openPalette`
 * can be a plain import and no prop has to be threaded through the shell.
 */

let open = false;
/**
 * Bumped on every opening. The palette keys its body on it, because a second
 * open that lands before the closing animation has finished never unmounts
 * anything - and that is exactly when the state has to start clean.
 */
let generation = 0;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (next === open) return;
  if (next) generation++;
  open = next;
  for (const listener of listeners) listener();
}

export const openPalette = () => set(true);
export const closePalette = () => set(false);
export const togglePalette = () => set(!open);

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function usePaletteOpen(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}

export function usePaletteGeneration(): number {
  return React.useSyncExternalStore(
    subscribe,
    () => generation,
    () => 0,
  );
}
