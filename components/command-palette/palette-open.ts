"use client";

import * as React from "react";

/**
 * Who opens the command palette. A module store rather than a provider: it is
 * one boolean that two buttons write and one component reads, so `openPalette`
 * can be a plain import and no prop has to be threaded through the shell.
 */

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (next === open) return;
  open = next;
  for (const listener of listeners) listener();
}

export const openPalette = () => set(true);
export const closePalette = () => set(false);
export const togglePalette = () => set(!open);

export function usePaletteOpen(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    () => open,
    () => false,
  );
}
