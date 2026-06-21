"use client";

import * as React from "react";
import { ScrollText } from "lucide-react";
import { gql } from "@/lib/graphql-client";
import { EmptyState } from "@/components/shared/empty-state";
import { ContainerLogs } from "@/components/projects/container-logs";
import { useLiveRunning } from "@/components/projects/project-live-status";
import type { ConsoleInstance } from "@/lib/data/console";

const LOGS_INFO_QUERY = /* GraphQL */ `
  query LogsInfo($projectId: String!) {
    logsInfo(projectId: $projectId) {
      running
      instances {
        name
        service
        image
        running
        exposed
        user
        workdir
        openStdin
        tty
      }
    }
  }
`;

type LogsInfoResponse = {
  logsInfo: { running: boolean; instances: ConsoleInstance[] } | null;
};

/**
 * Logs page body that follows the project's live running state: the runtime
 * log stream appears/disappears as the container starts/stops, no reload. On a
 * live start it fetches the instance list (a stopped project has none
 * server-rendered) so the log viewer can attach.
 */
export function LiveLogs({
  projectId,
  initialInstances,
  initialRunning,
}: {
  projectId: string;
  initialInstances: ConsoleInstance[] | null;
  initialRunning: boolean;
}) {
  const running = useLiveRunning(initialRunning);
  // Instance list for the current running session. Seeded from SSR, re-fetched
  // on each transition into running. Display is gated on `running`, so it is
  // never nulled on stop (just ignored) — all writes stay in async callbacks.
  const [instances, setInstances] = React.useState<ConsoleInstance[] | null>(
    initialRunning ? initialInstances : null,
  );

  React.useEffect(() => {
    if (!running) return;
    let cancelled = false;
    gql<LogsInfoResponse>(LOGS_INFO_QUERY, { projectId })
      .then((data) => {
        if (cancelled) return;
        const li = data.logsInfo;
        setInstances(li?.running ? li.instances : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [running, projectId]);

  if (running && instances) {
    return <ContainerLogs projectId={projectId} instances={instances} />;
  }

  return (
    <EmptyState
      icon={ScrollText}
      title="Container is not running"
      description="Runtime logs stream from a running container. Deploy or redeploy this project to start streaming its output."
    />
  );
}
