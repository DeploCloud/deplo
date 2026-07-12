"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Loader2, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  checkServerConnection,
  getServerConnectionSnapshot,
  probeServerReachable,
  subscribeServerConnection,
} from "@/lib/server-connection";

const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Connection watchdog mounted once in the root layout. Heartbeats the web
 * server hosting the panel and, when it becomes unreachable, raises a persistent
 * corner NOTIFICATION (not a full-screen lock): the page you're on stays fully
 * usable, but navigating to any OTHER page is paused — a broken connection can't
 * load a new route, so we block the attempt and say so instead of letting it
 * fail. The notification auto-reconnects — it probes for the server on a backoff
 * and reloads the page the instant it answers — and offers a single "Retry now"
 * button to probe on demand instead of waiting out the timer.
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
  return <DisconnectedNotification />;
}

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
 * Drives the auto-reconnect loop that runs the whole time the notification is up.
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

// How long to swallow repeat "navigation is paused" toasts, so mashing a nav
// link updates one toast instead of stacking a tower of them.
const NAV_BLOCK_TOAST_ID = "deplo-nav-paused";

/**
 * Pauses navigation to any OTHER page while the notification is up, WITHOUT
 * locking the current page. Two vectors are covered:
 *
 *  - **Link / anchor clicks** — capture-phase `click` + `auxclick` listeners on
 *    `document` fire before React dispatches, so they beat both Next's `<Link>`
 *    handler and the app's own onClicks. For an in-app anchor it calls
 *    `preventDefault()` (App Router's Link bails on `defaultPrevented`; the
 *    browser's native anchor nav is cancelled too) AND `stopImmediatePropagation()`
 *    (so the sidebar's "back" links can't fire their `history.go()` jump). Both
 *    the primary and middle mouse buttons are paused — a middle-click would
 *    otherwise open the dead route in a background tab. External links, downloads,
 *    `mailto:`/`tel:`, in-page `#` anchors and right-clicks (the context menu)
 *    fall through untouched.
 *  - **Back / forward** — an extra history entry is pinned on mount and re-pinned
 *    on every `popstate`, so the browser's back/forward buttons can't walk off
 *    the current route. Best-effort: a rapid/held back gesture that coalesces
 *    several traversals before the handler runs can still slip past the pin.
 *
 * Programmatic `router.push` from a button isn't intercepted here: those almost
 * always sit behind a server round-trip that fails while disconnected, so they
 * never reach the navigation. The listeners live only while this hook is
 * mounted (i.e. only while disconnected) and unwind cleanly on the reload.
 */
function useBlockNavigationWhileDisconnected(active: boolean): void {
  React.useEffect(() => {
    if (!active) return;

    const notePaused = () =>
      toast("Navigation is paused until the connection is restored.", {
        id: NAV_BLOCK_TOAST_ID,
        description: "You can stay on this page — it'll reload itself once the server is back.",
      });

    // Is this click headed for an in-app route change we should hold back?
    const isInternalNavClick = (e: MouseEvent): boolean => {
      // Primary (0) and middle (1) buttons navigate — a middle-click opens a new
      // tab on the dead route. Right-click (2, context menu) and already-handled
      // clicks are left alone.
      if ((e.button !== 0 && e.button !== 1) || e.defaultPrevented) return false;
      const target = e.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return false;
      if (anchor.hasAttribute("download")) return false;

      const href = anchor.getAttribute("href") ?? "";
      // In-page anchors and non-http schemes aren't route changes.
      if (href.startsWith("#") || /^(mailto:|tel:|blob:|data:)/i.test(href)) return false;

      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return false;
      }
      // Different origin → leaving the app entirely; let it go.
      if (url.origin !== window.location.origin) return false;
      // Same URL (pure hash change to the current page) → not a route change.
      if (url.href === window.location.href) return false;
      return true;
    };

    const onClickCapture = (e: MouseEvent) => {
      if (!isInternalNavClick(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      notePaused();
    };

    // Pin an extra entry so the FIRST back press pops back onto the current URL
    // instead of leaving; re-pin on every popstate so forward/back stay trapped.
    const pin = () => {
      try {
        window.history.pushState(null, "", window.location.href);
      } catch {
        /* pushState can throw in rare sandboxed contexts — degrade gracefully */
      }
    };
    const onPopState = () => {
      pin();
      notePaused();
    };

    // 'click' fires for the primary button; the middle button comes through as
    // 'auxclick' (and would otherwise open the dead route in a background tab).
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("auxclick", onClickCapture, true);
    window.addEventListener("popstate", onPopState);
    pin();

    return () => {
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("auxclick", onClickCapture, true);
      window.removeEventListener("popstate", onPopState);
    };
  }, [active]);
}

/**
 * The persistent connection notification. Portaled to <body> and pinned to the
 * bottom-center of the viewport as a compact card — it deliberately does NOT
 * cover or inert the page, so the current view stays fully interactive; only
 * cross-page navigation is paused (see `useBlockNavigationWhileDisconnected`).
 * The huge z-index keeps it above sonner's toaster (hardcoded z-index 999999999,
 * where the "navigation paused" toasts land): max int32 wins over it.
 */
function DisconnectedNotification() {
  const { phase, checking, cycleKey, cycleMs, retryNow } = useAutoReconnect();
  const restored = phase === "restored";

  useBlockNavigationWhileDisconnected(!restored);

  // Accent tracks the phase: destructive while the server is gone, emerald the
  // moment a probe brings it back. These must be complete literal class strings
  // — Tailwind can't see interpolated (`bg-${x}`) ones, so it never emits them.
  const tone = restored
    ? {
        core: "border-emerald-500/30 bg-emerald-500/15 text-emerald-500",
        glow: "#10b981",
      }
    : {
        core: "border-destructive/30 bg-destructive/15 text-destructive",
        glow: "var(--destructive)",
      };

  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[2147483647] flex justify-center p-4"
    >
      <div
        role="status"
        aria-live="polite"
        aria-labelledby="server-connection-lost-title"
        aria-describedby="server-connection-lost-description"
        className="pointer-events-auto relative isolate w-full max-w-sm animate-in fade-in-0 slide-in-from-bottom-4 duration-300"
      >
        {/* Red glow radiating from the centre outward behind the card. Its core
            sits behind the opaque card, so what shows is a soft halo bleeding out
            past every edge — a glow "behind the modal". Tracks the accent, so it
            is red while disconnected and turns emerald the moment it recovers. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-10 -z-10 opacity-80 blur-3xl transition-colors duration-500"
          style={{
            background: `radial-gradient(60% 60% at 50% 50%, color-mix(in srgb, ${tone.glow} 40%, transparent), transparent 72%)`,
          }}
        />

        <div className="overflow-hidden rounded-xl border border-border bg-card p-3.5 shadow-2xl">
          {/* Icon rides INLINE with the title on one row, so it owns no tall
              empty column — a compact chip whose accent tracks the phase
              (destructive → emerald on recovery). */}
          <div className="flex items-center gap-2.5">
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-lg border shadow-sm transition-colors duration-500 ${tone.core}`}
            >
              {restored ? (
                <Wifi className="size-4 animate-in zoom-in-50 duration-300" />
              ) : (
                <WifiOff className="size-4" />
              )}
            </span>
            <h2
              id="server-connection-lost-title"
              className="text-sm font-semibold tracking-tight text-foreground"
            >
              {restored ? "Back online" : "Connection lost"}
            </h2>
          </div>

          <p
            id="server-connection-lost-description"
            className="mt-2 text-xs leading-relaxed text-muted-foreground"
          >
            {restored
              ? "Reconnected — reloading to pick up right where you left off…"
              : "Can’t reach the server. This page stays usable — navigation is paused until it’s back."}
          </p>

          {/* One button. Its own fill IS the timer: a bar sweeps left-to-right
              over the current wait, and when it reaches the end a probe fires
              on its own. Press it to probe immediately instead of waiting. */}
          <Button
            size="sm"
            className="relative mt-3 w-full overflow-hidden"
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
    </div>,
    document.body,
  );
}
