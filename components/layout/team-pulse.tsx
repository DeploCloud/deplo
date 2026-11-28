"use client";

import * as React from "react";
import { lastLocalRefresh, useRouter } from "@/lib/nav";

/** What changed in the active team: someone's action or a finished deploy, a backup run, a cron run. */
export type PulseKind = "activity" | "backup" | "cron";
type Listener = (kind: PulseKind) => void;

// One refresh per burst, never more than one every 5 s, so a busy team cannot flood the server.
const SETTLE_MS = 2_000;
const MIN_GAP_MS = 5_000;
// The tab that made the change already refreshed after its own mutation.
const OWN_CHANGE_MS = 5_000;

export const BACKGROUND_REFRESH_EVENT = "deplo:background-refresh";

const PulseContext = React.createContext<{
  receive: (kind: PulseKind, actor: string | null) => void;
  listen: (fn: Listener) => () => void;
  request: () => void;
} | null>(null);

/** Keeps the pages a tab has cached fresh when the team changes, without polling. */
export function TeamPulseProvider({
  userId,
  children,
}: {
  userId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastRun = React.useRef(0);
  const dirty = React.useRef(false);
  const listeners = React.useRef(new Set<Listener>());

  const request = React.useCallback(() => {
    // A tab nobody is looking at asks the server nothing; it catches up when it is shown.
    if (document.hidden) {
      dirty.current = true;
      return;
    }
    if (timer.current) return;
    const wait = Math.max(SETTLE_MS, lastRun.current + MIN_GAP_MS - Date.now());
    timer.current = setTimeout(() => {
      timer.current = undefined;
      lastRun.current = Date.now();
      startTransition(() => router.refresh());
    }, wait);
  }, [router]);

  React.useEffect(() => {
    const onShow = () => {
      if (document.hidden || !dirty.current) return;
      dirty.current = false;
      request();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [request]);

  React.useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(BACKGROUND_REFRESH_EVENT, { detail: pending }),
    );
  }, [pending]);

  const value = React.useMemo(
    () => ({
      request,
      listen: (fn: Listener) => {
        listeners.current.add(fn);
        return () => void listeners.current.delete(fn);
      },
      receive: (kind: PulseKind, actor: string | null) => {
        for (const fn of listeners.current) fn(kind);
        if (kind !== "activity") return;
        if (actor === userId && Date.now() - lastLocalRefresh() < OWN_CHANGE_MS)
          return;
        request();
      },
    }),
    [request, userId],
  );

  return (
    <PulseContext.Provider value={value}>{children}</PulseContext.Provider>
  );
}

export function useTeamPulse() {
  return React.useContext(PulseContext);
}

/** A list that changes without an Activity entry (a backup or cron run starting) refreshes on its own kind. */
export function LivePulse({ kind }: { kind: Exclude<PulseKind, "activity"> }) {
  const pulse = useTeamPulse();
  React.useEffect(() => {
    if (!pulse) return;
    return pulse.listen((k) => {
      if (k === kind) pulse.request();
    });
  }, [pulse, kind]);
  return null;
}
