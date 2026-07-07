"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Info, RotateCw, WifiOff } from "lucide-react";
import { DeploLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
  checkServerConnection,
  getServerConnectionSnapshot,
  subscribeServerConnection,
} from "@/lib/server-connection";

const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Full-screen guard mounted once in the root layout. Heartbeats the web
 * server hosting the panel and, when it becomes unreachable, locks the entire
 * UI behind a blocking overlay: nothing can be done until the server is back.
 * There is intentionally NO automatic reconnection — the overlay only offers
 * a manual "Reload page" button.
 */
export function ServerConnectionGuard() {
  const state = React.useSyncExternalStore(
    subscribeServerConnection,
    getServerConnectionSnapshot,
    () => "connected" as const,
  );
  const disconnected = state === "disconnected";

  React.useEffect(() => {
    if (disconnected) return;
    const interval = window.setInterval(() => {
      void checkServerConnection();
    }, HEARTBEAT_INTERVAL_MS);
    // The browser knows instantly when the machine drops off the network, and
    // a tab waking from the background may have missed ticks (timers are
    // throttled while hidden) — check right away in both cases.
    const onOffline = () => void checkServerConnection();
    const onVisibilityChange = () => {
      if (!document.hidden) void checkServerConnection();
    };
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [disconnected]);

  if (!disconnected) return null;
  return <DisconnectedOverlay />;
}

// Keys allowed to reach the app while locked — exactly what's needed to focus
// and press the one Reload button, plus lone modifiers. Everything else (the
// app's window-level hotkeys: '[' sidebar toggle, Ctrl/Cmd+A select-all, and
// crucially Delete/Backspace which opens a bulk-delete dialog) is stopped.
const OPERABLE_KEYS = new Set([
  "Tab",
  "Enter",
  " ",
  "Shift",
  "Control",
  "Alt",
  "Meta",
]);

/**
 * The lock screen itself. Portaled to <body> so it is a direct body child:
 * that lets the effect below mark every OTHER body child `inert`, which blocks
 * pointer input and focus into the app — open Radix dialogs' focus traps
 * included. But `inert` does NOT silence window-level key listeners (a keydown
 * still bubbles from the focused Reload button to window, where the app's
 * hotkeys live) and does NOT cover body children portaled in AFTER the sweep
 * (a dialog a surviving hotkey could open). So the effect also (a) swallows
 * every non-operable key at capture phase and (b) inerts late-added body
 * children via a MutationObserver. The huge z-index is the visual half:
 * sonner's toaster hardcodes z-index 999999999, so anything lower would leave
 * toasts floating above the blocker (max int32 wins over it).
 */
function DisconnectedOverlay() {
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const reloadRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    const overlay = overlayRef.current;
    const reloadBtn = reloadRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const inerted: HTMLElement[] = [];
    const inert = (el: Element): void => {
      if (el === overlay) return;
      if (el instanceof HTMLElement && !el.inert) {
        el.inert = true;
        inerted.push(el);
      }
    };
    for (const child of Array.from(document.body.children)) inert(child);

    // Focus AFTER inerting the rest of the page: an open Radix dialog's focus
    // trap can no longer steal it back once its subtree is inert.
    reloadBtn?.focus();
    const reclaimFocus = (): void => {
      if (overlay && !overlay.contains(document.activeElement)) reloadBtn?.focus();
    };

    // A body child added after the sweep (e.g. a Radix dialog portaled from a
    // still-pending callback) would otherwise be live and focus-stealing —
    // inert it the instant it appears and take focus back.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) inert(node as Element);
      }
      reclaimFocus();
    });
    observer.observe(document.body, { childList: true });

    // stopImmediatePropagation (NOT preventDefault) kills the app's hotkey
    // listeners while leaving native browser shortcuts — F5/Ctrl+R reload,
    // devtools — untouched, so the user's own reload keys still work.
    const guardKey = (e: KeyboardEvent): void => {
      if (OPERABLE_KEYS.has(e.key)) return;
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", guardKey, true);
    window.addEventListener("keyup", guardKey, true);
    window.addEventListener("keypress", guardKey, true);

    // In practice this never runs (the latch only clears via a full reload),
    // but restore cleanly anyway — e.g. for HMR in dev.
    return () => {
      document.body.style.overflow = previousOverflow;
      observer.disconnect();
      window.removeEventListener("keydown", guardKey, true);
      window.removeEventListener("keyup", guardKey, true);
      window.removeEventListener("keypress", guardKey, true);
      for (const el of inerted) el.inert = false;
    };
  }, []);

  return createPortal(
    <div
      ref={overlayRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="server-connection-lost-title"
      aria-describedby="server-connection-lost-description"
      className="pointer-events-auto fixed inset-0 z-[2147483647] flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-md animate-in fade-in-0 duration-200"
    >
      {/* Radial vignette: darkens the corners so attention falls on the card. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(115% 85% at 50% 42%, transparent 38%, rgba(0,0,0,0.6) 100%)",
        }}
      />

      <div className="relative isolate w-full max-w-md animate-in fade-in-0 zoom-in-95 duration-300">
        {/* Soft destructive glow bleeding out from behind the card top. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-x-8 -top-10 -z-10 h-40 opacity-70 blur-3xl"
          style={{
            background:
              "radial-gradient(50% 60% at 50% 0%, color-mix(in srgb, var(--destructive) 24%, transparent), transparent 72%)",
          }}
        />

        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          {/* Header: brand on the left, live status on the right. */}
          <div className="flex items-center justify-between border-b border-border/70 px-5 py-3.5">
            <DeploLogo className="h-4 text-foreground/75" />
            <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">
              <span className="size-1.5 rounded-full bg-destructive" />
              Offline
            </span>
          </div>

          <div className="flex flex-col items-center px-6 pb-6 pt-8 text-center">
            {/* Concentric badge — a "signal" motif, deliberately static (the
                panel does not poll while locked, so nothing here may imply it). */}
            <div className="relative mb-5 flex size-16 items-center justify-center">
              <span
                aria-hidden
                className="absolute inset-0 rounded-full bg-destructive/[0.07]"
              />
              <span
                aria-hidden
                className="absolute inset-[7px] rounded-full bg-destructive/10"
              />
              <span className="relative flex size-11 items-center justify-center rounded-full border border-destructive/30 bg-destructive/15 text-destructive shadow-sm">
                <WifiOff className="size-5" />
              </span>
            </div>

            <h2
              id="server-connection-lost-title"
              className="text-lg font-semibold tracking-tight text-foreground"
            >
              Connection to the server lost
            </h2>
            <p
              id="server-connection-lost-description"
              className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground"
            >
              The web server hosting this Deplo panel is unreachable. Everything
              is paused until it&apos;s back online — no changes can be made
              right now.
            </p>

            <div className="mt-5 flex w-full items-start gap-2.5 rounded-lg border border-border bg-secondary/50 px-3.5 py-2.5 text-left">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                This page won&apos;t reconnect on its own. Once the server is
                back online, reload to continue.
              </p>
            </div>

            <Button
              ref={reloadRef}
              size="lg"
              className="mt-6 w-full"
              onClick={() => window.location.reload()}
            >
              <RotateCw />
              Reload page
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
