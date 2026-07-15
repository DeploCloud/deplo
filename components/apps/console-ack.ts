"use client";

import * as React from "react";

/** Persisted once the user confirms the console warning; unlocks the console
 *  sidebar chip and skips the warning on every later visit, across tabs. */
const ACK_KEY = "deplo:console-warning-ack";

const listeners = new Set<() => void>();

function readAck(): boolean {
  try {
    return window.localStorage.getItem(ACK_KEY) === "1";
  } catch {
    return false; // storage blocked (private mode) → warn again
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Reflect an acknowledgement made in ANOTHER tab too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === ACK_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Whether the user has confirmed the console warning. `null` on the server and
 * during hydration (undecided) — so an acknowledged user never flashes the
 * warning, and the sidebar chip never renders on the server then vanishes — then
 * a real boolean once the client has read localStorage.
 */
export function useConsoleAck(): boolean | null {
  return React.useSyncExternalStore(subscribe, readAck, () => null);
}

/** Persist the acknowledgement and notify every subscriber (the warning gate and
 *  the sidebar), so the console unlocks the instant "I understand" is clicked. */
export function acknowledgeConsole(): void {
  try {
    window.localStorage.setItem(ACK_KEY, "1");
  } catch {
    /* storage blocked → proceed this once, just can't remember it */
  }
  listeners.forEach((cb) => cb());
}
