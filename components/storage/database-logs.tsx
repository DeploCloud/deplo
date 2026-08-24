"use client";

import * as React from "react";
import { ContainerLogs } from "@/components/apps/container-logs";
import { useDatabaseRuntime } from "@/components/storage/use-database-runtime";
import { useLiveDatabaseStatus } from "@/components/storage/database-live-status";
import { runtimeNotice } from "@/components/apps/live-logs";
import type { LogTitle } from "@/components/logs/log-title";
import type { ConsoleInstance } from "@/lib/data/console";
import type { DatabaseStatus } from "@/lib/types";

/**
 * Live runtime logs for a database — a thin wrapper over the app ContainerLogs
 * pointed at the database logs route. Feeds it the runtime poll so a crash-
 * looping engine is followed across its restarts, exactly like an app's logs.
 */
export function DatabaseLogs({
  id,
  title,
  status: serverStatus,
  instances,
  streamable,
  supportsTimeline,
  logMaxDays,
}: {
  id: string;
  /** The database's name and the way back to its Overview: the toolbar is the
   *  only heading this route has. */
  title: LogTitle;
  status: DatabaseStatus;
  instances: ConsoleInstance[];
  streamable: boolean;
  /** The owning host's agent honours a log time window (`logs.timerange`). */
  supportsTimeline: boolean;
  /** The instance ceiling on that window, in days. */
  logMaxDays: number;
}) {
  const status = useLiveDatabaseStatus(serverStatus);
  const runtime = useDatabaseRuntime(id, { enabled: status === "running" });

  if (!streamable && !instances.length) {
    // Centred in the full-bleed frame: an explanation pinned to the top of a
    // viewport-tall empty pane reads as a page that half-loaded.
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <p className="max-w-100 text-center text-sm text-muted-foreground">
          No container on the host to stream logs from. Redeploy the database to
          recreate it.
        </p>
      </div>
    );
  }

  return (
    <ContainerLogs
      appId={id}
      instances={instances}
      runtime={runtime}
      notice={runtimeNotice(runtime)}
      title={title}
      supportsTimeline={supportsTimeline}
      logMaxDays={logMaxDays}
      apiBase={`/api/databases/${encodeURIComponent(id)}/logs`}
    />
  );
}
