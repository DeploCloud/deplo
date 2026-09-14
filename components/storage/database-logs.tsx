"use client";

import * as React from "react";
import { ScrollText } from "lucide-react";
import { ContainerLogs } from "@/components/apps/container-logs";
import { useDatabaseRuntime } from "@/components/storage/use-database-runtime";
import { useLiveDatabaseStatus } from "@/components/storage/database-live-status";
import { runtimeNotice } from "@/components/apps/live-logs";
import { PaneTitleLink, type PaneTitle } from "@/components/shared/pane-title";
import type { ConsoleInstance } from "@/lib/data/console";
import type { DatabaseStatus } from "@/lib/types/database";

// DatabaseLogs streams a database's runtime logs, following the engine across restarts.
export function DatabaseLogs({
  id,
  title,
  status: serverStatus,
  instances,
  streamable,
  supportsTimeline,
  logMaxDays,
  toolbar,
}: {
  id: string;
  title?: PaneTitle;
  status: DatabaseStatus;
  instances: ConsoleInstance[];
  streamable: boolean;
  // The owning host's agent honours a log time window (`logs.timerange`).
  supportsTimeline: boolean;
  logMaxDays: number;
  toolbar?: React.ReactNode;
}) {
  const status = useLiveDatabaseStatus(serverStatus);
  const runtime = useDatabaseRuntime(id, { enabled: status === "running" });

  if (!streamable && !instances.length) {
    // The toolbar row stays even with nothing to stream: on the general Logs page it holds the target picker.
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <ScrollText className="size-4 shrink-0 text-muted-foreground" />
          <PaneTitleLink title={title} />
          {toolbar}
        </div>
        {/* Centred in what is left of the frame: pinned to the top it reads as a half-loaded page. */}
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <p className="max-w-100 text-center text-sm text-muted-foreground">
            No container on the host to stream logs from. Redeploy the database
            to recreate it.
          </p>
        </div>
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
      toolbar={toolbar}
      supportsTimeline={supportsTimeline}
      logMaxDays={logMaxDays}
      apiBase={`/api/databases/${encodeURIComponent(id)}/logs`}
    />
  );
}
