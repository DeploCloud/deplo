"use client";

import * as React from "react";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
let started = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// The browser offers installing once, early: keep that offer for the More panel.
export function startPwa(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  if ("serviceWorker" in navigator && window.isSecureContext)
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
}

export function isInstalled(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export type InstallState = "installed" | "prompt" | "ios" | "unavailable";

export function useInstallState(): InstallState {
  const subscribe = React.useCallback((cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, []);
  return React.useSyncExternalStore(
    subscribe,
    () =>
      isInstalled()
        ? "installed"
        : deferred
          ? "prompt"
          : isIos()
            ? "ios"
            : "unavailable",
    () => "unavailable",
  );
}

export async function promptInstall(): Promise<void> {
  const e = deferred;
  if (!e) return;
  await e.prompt();
  await e.userChoice;
  deferred = null;
  emit();
}

export function pushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    window.isSecureContext
  );
}
