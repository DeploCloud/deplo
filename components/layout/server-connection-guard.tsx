"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Loader2, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { DeploLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
  checkServerConnection,
  getServerConnectionSnapshot,
  probeServerReachable,
  subscribeServerConnection,
} from "@/lib/server-connection";

const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Full-screen guard mounted once in the root layout. Heartbeats the web
 * server hosting the panel and, when it becomes unreachable, locks the entire
 * UI behind a blocking overlay: nothing can be done until the server is back.
 * While locked, the overlay auto-reconnects — it probes for the server on a
 * backoff and reloads the page the instant it answers — and offers a single
 * "Retry now" button to probe on demand instead of waiting out the timer.
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
// and press the one action button, plus lone modifiers. Everything else (the
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

// Auto-reconnect cadence. The first probe fires quickly (outages are often a
// blip), then backs off geometrically up to a ceiling so a long outage doesn't
// hammer a dead server — while still checking often enough to feel responsive.
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_BACKOFF = 1.7;
// Once a probe succeeds, hold the "back online" state briefly so the recovery
// registers visually before the page reloads itself.
const RESTORED_RELOAD_DELAY_MS = 900;

type ReconnectPhase = "reconnecting" | "restored";

/**
 * Drives the auto-reconnect loop that runs the whole time the overlay is up.
 *
 * It probes `/api/health` on a backoff and, the instant a probe answers, flips
 * to "restored" and reloads the page. The reload — not an in-place un-latch —
 * is deliberate: it re-reads server data and resubscribes the SSE streams that
 * `gqlSubscribe` tore down when the connection dropped. The browser's `online`
 * event and a tab regaining focus both trigger an immediate probe, so recovery
 * usually beats the timer. All loop state lives in closure-local `let`s so each
 * effect run is self-contained — StrictMode's mount/unmount/mount cycle tears
 * the first run's timers down and re-arms the second cleanly.
 *
 * The UI shows the wait as a progress bar rather than a number: each scheduled
 * wait is one "cycle", and `cycle.key` bumps on every new one so the bar can
 * remount and restart its fill animation over `cycle.ms`. `checking` marks a
 * probe in flight (the bar yields to a spinner).
 */
function useAutoReconnect(): {
  phase: ReconnectPhase;
  checking: boolean;
  cycleKey: number;
  cycleMs: number;
  retryNow: () => void;
} {
  const [phase, setPhase] = React.useState<ReconnectPhase>("reconnecting");
  const [checking, setChecking] = React.useState(false);
  const [cycle, setCycle] = React.useState({
    key: 0,
    ms: RECONNECT_BASE_DELAY_MS,
  });

  const retryNowRef = React.useRef<() => void>(() => {});
  const retryNow = React.useCallback(() => retryNowRef.current(), []);

  React.useEffect(() => {
    let delay = RECONNECT_BASE_DELAY_MS;
    let attemptTimer: number | null = null;
    let reloadTimer: number | null = null;
    let checkingNow = false;
    let stopped = false;

    const scheduleNext = (ms: number) => {
      if (attemptTimer !== null) window.clearTimeout(attemptTimer);
      if (stopped) return;
      // Bump the key so the progress bar restarts its fill over the new `ms`.
      setCycle((c) => ({ key: c.key + 1, ms }));
      attemptTimer = window.setTimeout(() => void attempt(), ms);
    };

    const attempt = async () => {
      if (stopped || checkingNow) return;
      checkingNow = true;
      if (attemptTimer !== null) window.clearTimeout(attemptTimer);
      attemptTimer = null;
      setChecking(true);
      const reachable = await probeServerReachable();
      checkingNow = false;
      if (stopped) return;
      setChecking(false);
      if (reachable) {
        stopped = true;
        setPhase("restored");
        reloadTimer = window.setTimeout(
          () => window.location.reload(),
          RESTORED_RELOAD_DELAY_MS,
        );
        return;
      }
      delay = Math.min(Math.round(delay * RECONNECT_BACKOFF), RECONNECT_MAX_DELAY_MS);
      scheduleNext(delay);
    };

    retryNowRef.current = () => {
      if (!stopped && !checkingNow) {
        delay = RECONNECT_BASE_DELAY_MS;
        void attempt();
      }
    };

    // The browser knows the moment the machine rejoins the network, and a tab
    // waking from the background may have idled through the wait — probe right
    // away in both cases rather than letting the bar run out.
    const onOnline = () => retryNowRef.current();
    const onVisible = () => {
      if (!document.hidden) retryNowRef.current();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);

    scheduleNext(delay);

    return () => {
      stopped = true;
      if (attemptTimer !== null) window.clearTimeout(attemptTimer);
      if (reloadTimer !== null) window.clearTimeout(reloadTimer);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { phase, checking, cycleKey: cycle.key, cycleMs: cycle.ms, retryNow };
}

/**
 * The lock screen itself. Portaled to <body> so it is a direct body child:
 * that lets the effect below mark every OTHER body child `inert`, which blocks
 * pointer input and focus into the app — open Radix dialogs' focus traps
 * included. But `inert` does NOT silence window-level key listeners (a keydown
 * still bubbles from the focused action button to window, where the app's
 * hotkeys live) and does NOT cover body children portaled in AFTER the sweep
 * (a dialog a surviving hotkey could open). So the effect also (a) swallows
 * every non-operable key at capture phase and (b) inerts late-added body
 * children via a MutationObserver. The huge z-index is the visual half:
 * sonner's toaster hardcodes z-index 999999999, so anything lower would leave
 * toasts floating above the blocker (max int32 wins over it).
 */
function DisconnectedOverlay() {
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const actionRef = React.useRef<HTMLButtonElement>(null);
  const { phase, checking, cycleKey, cycleMs, retryNow } = useAutoReconnect();
  const restored = phase === "restored";

  React.useEffect(() => {
    const overlay = overlayRef.current;
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
    // trap can no longer steal it back once its subtree is inert. Prefer the
    // action button, but read it LIVE (it can briefly swap contents across
    // phases) and fall back to the focusable overlay itself, so focus can never
    // slip out to <body> — where a stray app hotkey could catch it.
    const focusTarget = (): HTMLElement | null => actionRef.current ?? overlay;
    focusTarget()?.focus();
    const reclaimFocus = (): void => {
      if (overlay && !overlay.contains(document.activeElement)) focusTarget()?.focus();
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

  // Accent tracks the phase: destructive while the server is gone, emerald the
  // moment a probe brings it back. These must be complete literal class strings
  // — Tailwind can't see interpolated (`bg-${x}`) ones, so it never emits them.
  const tone = restored
    ? {
        halo: "bg-emerald-500/[0.07]",
        ring: "bg-emerald-500/10",
        core: "border-emerald-500/30 bg-emerald-500/15 text-emerald-500",
        glow: "#10b981",
      }
    : {
        halo: "bg-destructive/[0.07]",
        ring: "bg-destructive/10",
        core: "border-destructive/30 bg-destructive/15 text-destructive",
        glow: "var(--destructive)",
      };

  return createPortal(
    <div
      ref={overlayRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="server-connection-lost-title"
      aria-describedby="server-connection-lost-description"
      tabIndex={-1}
      className="pointer-events-auto fixed inset-0 z-[2147483647] flex items-center justify-center overflow-y-auto bg-black/80 p-4 outline-none backdrop-blur-md animate-in fade-in-0 duration-200"
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
        {/* Soft glow bleeding out from behind the card top — tracks the accent. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-x-8 -top-10 -z-10 h-40 opacity-70 blur-3xl transition-colors duration-500"
          style={{
            background: `radial-gradient(50% 60% at 50% 0%, color-mix(in srgb, ${tone.glow} 24%, transparent), transparent 72%)`,
          }}
        />

        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          {/* Header: just the brand. */}
          <div className="flex items-center border-b border-border/70 px-5 py-3.5">
            <DeploLogo className="h-4 text-foreground/75" />
          </div>

          <div className="flex flex-col items-center px-6 pb-6 pt-8 text-center">
            {/* Concentric "signal" badge. It now animates — the panel really is
                probing while locked, so the motion is honest. The expanding
                ring is suppressed under prefers-reduced-motion. */}
            <div className="relative mb-5 flex size-16 items-center justify-center">
              <span
                aria-hidden
                className={`absolute inset-0 rounded-full ${tone.halo}`}
              />
              <span
                aria-hidden
                className={`absolute inset-[7px] rounded-full ${tone.ring}`}
              />
              {!restored && (
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-full border border-destructive/30 animate-ping [animation-duration:2.4s] motion-reduce:hidden"
                />
              )}
              <span
                className={`relative flex size-11 items-center justify-center rounded-full border shadow-sm transition-colors duration-500 ${tone.core}`}
              >
                {restored ? (
                  <Wifi className="size-5 animate-in zoom-in-50 duration-300" />
                ) : (
                  <WifiOff className="size-5" />
                )}
              </span>
            </div>

            <h2
              id="server-connection-lost-title"
              className="text-lg font-semibold tracking-tight text-foreground"
            >
              {restored ? "Back online" : "Connection lost"}
            </h2>
            <p
              id="server-connection-lost-description"
              aria-live="polite"
              className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground"
            >
              {restored ? (
                <>
                  The server is responding again. Reloading the panel to pick up
                  right where you left off…
                </>
              ) : (
                <>
                  The web server hosting this Deplo panel is unreachable.
                  Everything is paused until the connection is restored — no
                  changes can be made right now.
                </>
              )}
            </p>

            {/* One button, and only one. Its own fill IS the timer: a bar
                sweeps left-to-right over the current wait, and when it reaches
                the end a probe fires on its own. Press it to probe immediately
                instead of waiting; it stays mounted (and clickable) in every
                phase so a declined auto-reload still has an escape hatch and
                focus never slips out of the dialog. */}
            <Button
              ref={actionRef}
              size="lg"
              className="relative mt-6 w-full overflow-hidden"
              onClick={() => (restored ? window.location.reload() : retryNow())}
            >
              {!restored && !checking && (
                <span
                  key={cycleKey}
                  aria-hidden
                  className="absolute inset-0 origin-left bg-primary-foreground/20 motion-reduce:hidden"
                  style={{ animation: `reconnect-progress ${cycleMs}ms linear forwards` }}
                />
              )}
              <span className="relative z-10 inline-flex items-center gap-2">
                {restored ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Reloading…
                  </>
                ) : checking ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Checking…
                  </>
                ) : (
                  <>
                    <RefreshCw />
                    Retry now
                  </>
                )}
              </span>
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
