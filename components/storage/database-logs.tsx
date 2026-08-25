"use client";

import * as React from "react";
import { ScrollText } from "lucide-react";
import { ContainerLogs } from "@/components/apps/container-logs";
import { useDatabaseRuntime } from "@/components/storage/use-database-runtime";
import { useLiveDatabaseStatus } from "@/components/storage/database-live-status";
import { runtimeNotice } from "@/components/apps/live-logs";
import { PaneTitleLink, type PaneTitle } from "@/components/shared/pane-title";
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
  toolbar,
}: {
  id: string;
  /** The database's name and the way back to its Overview: the toolbar is the
   *  only heading this route has. Omitted on the general Logs page, where the
   *  target picker shows the name itself. */
  title?: PaneTitle;
  status: DatabaseStatus;
  instances: ConsoleInstance[];
  streamable: boolean;
  /** The owning host's agent honours a log time window (`logs.timerange`). */
  supportsTimeline: boolean;
  /** The instance ceiling on that window, in days. */
  logMaxDays: number;
  /** Extra toolbar controls, forwarded untouched: the general Logs page passes
   *  its target picker. A database has no build to switch to, so unlike an App
   *  there is no Runtime/Build control to compose in beside it. */
  toolbar?: React.ReactNode;
}) {
  const status = useLiveDatabaseStatus(serverStatus);
  const runtime = useDatabaseRuntime(id, { enabled: status === "running" });

  if (!streamable && !instances.length) {
    // The toolbar ROW stays even with nothing to stream: on the general Logs
    // page it holds the target picker, and answering "nothing here" by taking
    // away the only way to look elsewhere is a dead end.
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
          <ScrollText className="size-4 shrink-0 text-muted-foreground" />
          <PaneTitleLink title={title} />
          {toolbar}
        </div>
        {/* Centred in what is left of the frame: an explanation pinned to the
            top of a viewport-tall empty pane reads as a page that half-loaded. */}
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
