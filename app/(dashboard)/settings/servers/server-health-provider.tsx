"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { toast } from "sonner";

import { gqlAction } from "@/lib/graphql-client";
import type { ServerStatus } from "@/lib/types";

/**
 * The live health of every server card on this page. The stored status is now a
 * timestamped OBSERVATION, so the page can't just render it - it has to say how
 * old it is, and refuse to paint it once it's stale.
 */

/**
 * How long an observation stays paintable before {@link ServerHealthChip} ages it out to
 * "Unknown". Lives here, next to the sweep that has to outrun it, so the two can't drift
 * apart: the chip imports it rather than keeping its own copy.
 */
export const STATUS_STALE_MS = 60_000;

/**
 * The ambient re-sweep, while this page is open and visible.
 */
const SWEEP_INTERVAL_MS = 20_000;

export interface ServerHealthState {
  status: ServerStatus;
  /** ISO instant of the last probe, or null if this server has never been probed. */
  checkedAt: string | null;
  /** Why it isn't online (instance-admin-scoped in GraphQL). Null when online. */
  message: string | null;
  /**
   * Whether a Traefik proxy was running on the host, as of the same observation.
   */
  traefikEnabled: boolean;
  /**
   * ISO instant the agent last actually ANSWERED, or null if it never has. Dating
   * a last-known value with `checkedAt` would reintroduce the exact lie this state
   * exists to prevent, one layer down in the tooltip.
   */
  lastReachedAt: string | null;
}

/**
 * Whether an observation is recent enough to paint.
 */
export function isObservationFresh(
  checkedAt: string | null,
  now: number | null,
): boolean {
  // "Never observed" is deterministic, it does not depend on the clock, so it is
  // decided the same way on the server and the client, no hydration risk.
  if (!checkedAt) return false;
  // Pre-mount (now null): a server with a checkedAt paints its seed. Branching on the
  // actual time is deferred to the client, where the provider's tick supplies `now`.
  if (now === null) return true;
  const at = Date.parse(checkedAt);
  return Number.isFinite(at) && now - at < STATUS_STALE_MS;
}

interface HealthContext {
  health: (serverId: string) => ServerHealthState | undefined;
  /** True while a probe for this server (or the whole fleet) is in flight. */
  isChecking: (serverId: string) => boolean;
  checkOne: (serverId: string) => void;
  checkAll: () => void;
  /** True during the automatic sweep this provider runs on mount. */
  sweeping: boolean;
  /**
   * The current time for freshness checks, or `null` until mounted.
   */
  now: number | null;
}

const Ctx = React.createContext<HealthContext | null>(null);

/** The GraphQL shape both mutations return; `statusMessage` is admin-only server-side. */
interface ServerHealthRow {
  id: string;
  status: ServerStatus;
  statusCheckedAt: string | null;
  statusMessage: string | null;
  traefikEnabled: boolean;
  lastSeenAt: string | null;
}

const HEALTH_FIELDS = `
  id
  status
  statusCheckedAt
  statusMessage
  traefikEnabled
  lastSeenAt
`;

const CHECK_ALL = /* GraphQL */ `
  mutation CheckAllServerHealth($force: Boolean) {
    checkAllServerHealth(force: $force) {
      ${HEALTH_FIELDS}
    }
  }
`;

const CHECK_ONE = /* GraphQL */ `
  mutation CheckServerHealth($id: String!, $force: Boolean) {
    checkServerHealth(id: $id, force: $force) {
      ${HEALTH_FIELDS}
    }
  }
`;

function toState(row: ServerHealthRow): ServerHealthState {
  return {
    status: row.status,
    checkedAt: row.statusCheckedAt,
    message: row.statusMessage,
    traefikEnabled: row.traefikEnabled,
    lastReachedAt: row.lastSeenAt,
  };
}

export function ServerHealthProvider({
  seed,
  children,
}: {
  /** The stored observation for each server, straight from the RSC read. */
  seed: Record<string, ServerHealthState>;
  children: React.ReactNode;
}) {
  const [health, setHealth] = React.useState(seed);
  const [checking, setChecking] = React.useState<Record<string, boolean>>({});
  const [sweeping, setSweeping] = React.useState(true);
  // Starts null (SSR-safe), becomes a ticking clock after mount - see `now` above.
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    const raf = requestAnimationFrame(() => setNow(Date.now()));
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(t);
    };
  }, []);

  /**
   * Apply rows, WATERMARKED on the observation time.
   */
  const merge = React.useCallback((rows: ServerHealthRow[]) => {
    setHealth((prev) => {
      const next = { ...prev };
      for (const row of rows) {
        const held = prev[row.id]?.checkedAt;
        const incoming = row.statusCheckedAt;
        if (held && incoming && Date.parse(incoming) < Date.parse(held))
          continue;
        next[row.id] = toState(row);
      }
      return next;
    });
  }, []);

  /** Guards against a slow sweep stacking on top of the next tick's sweep. */
  const sweepInFlight = React.useRef(false);

  // The on-load sweep, and then the SAME sweep on a timer for as long as the page is
  // open. Both are un-forced, so the data layer's throttle collapses a burst of
  // tabs/reloads/ticks into a single dial per server.
  React.useEffect(() => {
    let live = true;

    /** `quiet` = the ambient re-sweep: no spinner on the chips, no toast. */
    const sweep = async (quiet: boolean) => {
      // A hidden tab is nobody watching. Don't dial every agent in the fleet on its
      // behalf - the visibility listener below re-verifies the instant it comes back.
      if (quiet && document.hidden) return;
      if (sweepInFlight.current) return;
      sweepInFlight.current = true;
      if (!quiet) setSweeping(true);
      try {
        const res = await gqlAction<{
          checkAllServerHealth: ServerHealthRow[];
        }>(CHECK_ALL, {
          force: false,
        });
        if (!live) return;
        if (!quiet) setSweeping(false);
        if (!res.ok) {
          // The cards fall back to the last observation, which the chip already ages out to
          // "Unknown" on its own, so a failed sweep degrades to "we don't know", never to a
          // confident stale value.
          if (quiet)
            console.error(
              "[deplo] ambient server-health sweep failed:",
              res.error,
            );
          else toast.error(res.error);
          return;
        }
        if (res.data) merge(res.data.checkAllServerHealth);
      } finally {
        sweepInFlight.current = false;
      }
    };

    void sweep(false);
    const timer = setInterval(() => void sweep(true), SWEEP_INTERVAL_MS);
    // Coming back to a backgrounded tab is exactly the moment a stale chip must not be on
    // screen - re-verify immediately rather than waiting out the rest of the interval.
    const onVisibility = () => {
      if (!document.hidden) void sweep(true);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [merge]);

  const checkOne = React.useCallback(
    (serverId: string) => {
      // The timestamp we had going in - to tell a real re-check apart from a throttled
      // no-op. Toasting "online" off that would be reporting a result we never observed.
      const before = health[serverId]?.checkedAt ?? null;
      setChecking((c) => ({ ...c, [serverId]: true }));
      (async () => {
        const res = await gqlAction<{ checkServerHealth: ServerHealthRow }>(
          CHECK_ONE,
          {
            id: serverId,
            force: true,
          },
        );
        setChecking((c) => ({ ...c, [serverId]: false }));
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        if (!res.data) return;
        const row = res.data.checkServerHealth;
        merge([row]);
        if (row.statusCheckedAt && row.statusCheckedAt === before) {
          toast.info("Checked a moment ago - status is up to date");
          return;
        }
        // Say what we found, not "done" - the whole point of the button is the answer.
        if (row.status === "online") toast.success("Server is online");
        else if (row.status === "provisioning")
          toast.info("Server is still provisioning");
        else toast.warning(row.statusMessage ?? `Server is ${row.status}`);
      })();
    },
    [health, merge],
  );

  const checkAll = React.useCallback(() => {
    setSweeping(true);
    (async () => {
      const res = await gqlAction<{ checkAllServerHealth: ServerHealthRow[] }>(
        CHECK_ALL,
        {
          force: true,
        },
      );
      setSweeping(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (!res.data) return;
      const rows = res.data.checkAllServerHealth;
      merge(rows);
      const bad = rows.filter(
        (r) => r.status !== "online" && r.status !== "provisioning",
      );
      toast.success(
        bad.length === 0
          ? "All servers are online"
          : `${bad.length} of ${rows.length} servers need attention`,
      );
    })();
  }, [merge]);

  const value = React.useMemo<HealthContext>(
    () => ({
      health: (id) => health[id],
      isChecking: (id) => Boolean(checking[id]) || sweeping,
      checkOne,
      checkAll,
      sweeping,
      now,
    }),
    [health, checking, sweeping, now, checkOne, checkAll],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useServerHealth(): HealthContext {
  const ctx = React.useContext(Ctx);
  if (!ctx)
    throw new Error(
      "useServerHealth must be used inside a <ServerHealthProvider>",
    );
  return ctx;
}
