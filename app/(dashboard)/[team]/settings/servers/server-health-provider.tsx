"use client";

import * as React from "react";
import { toast } from "sonner";

import { gqlAction } from "@/lib/graphql-client";
import type { ServerStatus } from "@/lib/types/server";

export const STATUS_STALE_MS = 60_000;

const SWEEP_INTERVAL_MS = 20_000;

export interface ServerHealthState {
  status: ServerStatus;
  checkedAt: string | null;
  message: string | null;
  traefikEnabled: boolean;
  lastReachedAt: string | null;
}

export function isObservationFresh(
  checkedAt: string | null,
  now: number | null,
): boolean {
  if (!checkedAt) return false;
  if (now === null) return true;
  const at = Date.parse(checkedAt);
  return Number.isFinite(at) && now - at < STATUS_STALE_MS;
}

interface HealthContext {
  health: (serverId: string) => ServerHealthState | undefined;
  isChecking: (serverId: string) => boolean;
  checkOne: (serverId: string) => void;
  checkAll: () => void;
  sweeping: boolean;
  now: number | null;
}

const Ctx = React.createContext<HealthContext | null>(null);

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
  seed: Record<string, ServerHealthState>;
  children: React.ReactNode;
}) {
  const [health, setHealth] = React.useState(seed);
  const [checking, setChecking] = React.useState<Record<string, boolean>>({});
  const [sweeping, setSweeping] = React.useState(true);
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    const raf = requestAnimationFrame(() => setNow(Date.now()));
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(t);
    };
  }, []);

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

  const sweepInFlight = React.useRef(false);

  React.useEffect(() => {
    let live = true;

    const sweep = async (quiet: boolean) => {
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
