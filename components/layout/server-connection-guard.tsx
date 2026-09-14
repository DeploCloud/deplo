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

// ServerConnectionGuard - connection watchdog mounted once in the root layout.
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

const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_BACKOFF = 1.7;
const RESTORED_RELOAD_DELAY_MS = 900;

type ReconnectPhase = "reconnecting" | "restored";

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
      delay = Math.min(
        Math.round(delay * RECONNECT_BACKOFF),
        RECONNECT_MAX_DELAY_MS,
      );
      scheduleNext(delay);
    };

    retryNowRef.current = () => {
      if (!stopped && !checkingNow) {
        delay = RECONNECT_BASE_DELAY_MS;
        void attempt();
      }
    };

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

const NAV_BLOCK_TOAST_ID = "deplo-nav-paused";

function useBlockNavigationWhileDisconnected(active: boolean): void {
  React.useEffect(() => {
    if (!active) return;

    const notePaused = () =>
      toast(
        "Navigation and actions are paused while the server is unreachable.",
        {
          id: NAV_BLOCK_TOAST_ID,
          description:
            "You can stay on this page - it reloads itself once the server is back.",
        },
      );

    const isInternalNavClick = (e: MouseEvent): boolean => {
      if ((e.button !== 0 && e.button !== 1) || e.defaultPrevented)
        return false;
      const target = e.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return false;
      if (anchor.hasAttribute("download")) return false;

      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#") || /^(mailto:|tel:|blob:|data:)/i.test(href))
        return false;

      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return false;
      }
      if (url.origin !== window.location.origin) return false;
      if (url.href === window.location.href) return false;
      return true;
    };

    const onClickCapture = (e: MouseEvent) => {
      if (!isInternalNavClick(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      notePaused();
    };

    const pin = () => {
      try {
        window.history.pushState(null, "", window.location.href);
      } catch {
        /* pushState can throw in rare sandboxed contexts - degrade gracefully */
      }
    };
    const onPopState = () => {
      pin();
      notePaused();
    };

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

function DisconnectedNotification() {
  const { phase, checking, cycleKey, cycleMs, retryNow } = useAutoReconnect();
  const restored = phase === "restored";

  useBlockNavigationWhileDisconnected(!restored);

  // Literal class strings only - Tailwind never emits an interpolated one.
  const tone = restored
    ? {
        core: "border-emerald-500/30 bg-emerald-500/15 text-emerald-500",
        glow: "#10b981",
      }
    : {
        core: "border-destructive/30 bg-destructive-wash-strong text-destructive",
        glow: "var(--destructive)",
      };

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[2147483647] flex justify-center p-4">
      <div
        role="status"
        aria-live="polite"
        aria-labelledby="server-connection-lost-title"
        aria-describedby="server-connection-lost-description"
        className="pointer-events-auto relative isolate w-full max-w-sm animate-in duration-300 fade-in-0 slide-in-from-bottom-4"
      >
        {/* Red glow behind the card. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-10 -z-10 opacity-80 blur-3xl transition-colors duration-500"
          style={{
            background: `radial-gradient(60% 60% at 50% 50%, color-mix(in srgb, ${tone.glow} 40%, transparent), transparent 72%)`,
          }}
        />

        <div className="overflow-hidden rounded-xl border border-border bg-card p-3.5 shadow-2xl">
          {/* Icon rides inline with the title, so it owns no tall column. */}
          <div className="flex items-center gap-2.5">
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-lg border shadow-sm transition-colors duration-500 ${tone.core}`}
            >
              {restored ? (
                <Wifi className="size-4 animate-in duration-300 zoom-in-50" />
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
              ? "Reconnected - reloading to pick up right where you left off."
              : "Can’t reach the server. You can keep reading this page - navigation and actions are paused until it’s back."}
          </p>

          {/* The button's own fill is the timer for the next probe. */}
          <Button
            size="sm"
            className="relative mt-3 w-full overflow-hidden"
            onClick={() => (restored ? window.location.reload() : retryNow())}
          >
            {!restored && !checking && (
              <span
                key={cycleKey}
                aria-hidden
                className="absolute inset-0 origin-left bg-[color-mix(in_srgb,var(--primary-foreground)_20%,var(--primary))] motion-reduce:hidden"
                style={{
                  animation: `reconnect-progress ${cycleMs}ms linear forwards`,
                }}
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-2">
              {restored ? (
                <>
                  <Loader2 className="animate-spin" />
                  Reloading
                </>
              ) : checking ? (
                <>
                  <Loader2 className="animate-spin" />
                  Checking
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
