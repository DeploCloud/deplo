"use client";

import * as React from "react";

let open = false;
// The palette keys its body on this: a reopen before the close animation ends unmounts nothing, so its state would stay stale.
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
