"use client";

import * as React from "react";

const ACK_KEY = "deplo:console-warning-ack";

const listeners = new Set<() => void>();

function readAck(): boolean {
  try {
    return window.localStorage.getItem(ACK_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === ACK_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

// useConsoleAck - whether the user has confirmed the console warning.
export function useConsoleAck(): boolean | null {
  return React.useSyncExternalStore(subscribe, readAck, () => null);
}

// acknowledgeConsole - persist the acknowledgement and notify every subscriber.
export function acknowledgeConsole(): void {
  try {
    window.localStorage.setItem(ACK_KEY, "1");
  } catch {}
  listeners.forEach((cb) => cb());
}
