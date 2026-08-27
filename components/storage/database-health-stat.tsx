"use client";

import * as React from "react";
import { Activity, TriangleAlert } from "lucide-react";
import { StatusDot } from "@/components/shared/status-badge";
import { StatCard } from "@/components/storage/database-stats";
import { useDatabaseRuntime } from "@/components/storage/use-database-runtime";
import { useLiveDatabaseStatus } from "@/components/storage/database-live-status";
import { databaseDisplayStatus } from "@/lib/databases/display-status";
import type { DatabaseStatus } from "@/lib/types";

/**
 * A database the row calls running but the agent can see no container for was
 * provisioned before the deplo.* labels existed. Redeploy stamps them.
 */
export function DatabaseRelabelNotice({
  id,
  status,
}: {
  id: string;
  status: DatabaseStatus;
}) {
  const live = useLiveDatabaseStatus(status);
  const runtime = useDatabaseRuntime(id, { enabled: live === "running" });
  if (!runtime || runtime.unreachable || runtime.total > 0) return null;

  return (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
      <div>
        <p className="font-medium">Redeploy to enable live tools</p>
        <p className="mt-1 text-muted-foreground">
          This database was created before live status, logs and the terminal
          were available. Click{" "}
          <strong className="font-medium text-foreground">Redeploy</strong>{" "}
          above to enable them - the data volume is preserved.
        </p>
      </div>
    </div>
  );
}

/**
 * The header badge answers "is it up". This answers what it cannot: does the
 * engine's own healthcheck pass, and has the container been dying.
 */
export function DatabaseHealthStat({
  id,
  status,
}: {
  id: string;
  status: DatabaseStatus;
}) {
  const live = useLiveDatabaseStatus(status);
  const runtime = useDatabaseRuntime(id, { enabled: live === "running" });
  const shown = databaseDisplayStatus(live, runtime);
  const container = runtime?.containers?.[0];

  const health = container?.health;
  const value =
    live !== "running" || runtime?.unreachable
      ? "-"
      : health === "healthy"
        ? "Healthy"
        : health === "unhealthy"
          ? "Unhealthy"
          : health === "starting"
            ? "Starting"
            : "No healthcheck";

  const restarts = container?.restartCount ?? 0;

  return (
    <StatCard
      icon={Activity}
      label="Health"
      value={
        <span className="flex items-center gap-1.5">
          <StatusDot status={shown} />
          {value}
        </span>
      }
      sub={restarts === 0 ? "No restarts" : `Restarted ${restarts} times`}
    />
  );
}
