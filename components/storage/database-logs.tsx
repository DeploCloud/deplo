"use client";

import * as React from "react";
import { ContainerLogs } from "@/components/apps/container-logs";
import { useDatabaseRuntime } from "@/components/storage/use-database-runtime";
import { useLiveDatabaseStatus } from "@/components/storage/database-live-status";
import type { ConsoleInstance } from "@/lib/data/console";
import type { DatabaseStatus } from "@/lib/types";

/**
 * Live runtime logs for a database — a thin wrapper over the app ContainerLogs
 * pointed at the database logs route. Feeds it the runtime poll so a crash-
 * looping engine is followed across its restarts, exactly like an app's logs.
 */
export function DatabaseLogs({
  id,
  status: serverStatus,
  instances,
  streamable,
}: {
  id: string;
  status: DatabaseStatus;
  instances: ConsoleInstance[];
  streamable: boolean;
}) {
  const status = useLiveDatabaseStatus(serverStatus);
  const runtime = useDatabaseRuntime(id, { enabled: status === "running" });

  if (!streamable && !instances.length) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No container on the host to stream logs from. Redeploy the database to
        recreate it.
      </div>
    );
  }

  return (
    <ContainerLogs
      appId={id}
      instances={instances}
      runtime={runtime}
      apiBase={`/api/databases/${encodeURIComponent(id)}/logs`}
    />
  );
}
