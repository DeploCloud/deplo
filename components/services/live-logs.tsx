"use client";

import * as React from "react";
import { ScrollText } from "lucide-react";
import { gql } from "@/lib/graphql-client";
import { EmptyState } from "@/components/shared/empty-state";
import { ContainerLogs } from "@/components/services/container-logs";
import { useLiveRunning } from "@/components/services/service-live-status";
import type { ConsoleInstance } from "@/lib/data/console";

const LOGS_INFO_QUERY = /* GraphQL */ `
  query LogsInfo($serviceId: String!) {
    logsInfo(serviceId: $serviceId) {
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
 * Logs page body that follows the service's live running state: the runtime
 * log stream appears/disappears as the container starts/stops, no reload. On a
 * live start it fetches the instance list (a stopped project has none
 * server-rendered) so the log viewer can attach.
 */
export function LiveLogs({
  serviceId,
  initialInstances,
  initialRunning,
}: {
  serviceId: string;
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
    gql<LogsInfoResponse>(LOGS_INFO_QUERY, { serviceId })
      .then((data) => {
        if (cancelled) return;
        const li = data.logsInfo;
        setInstances(li?.running ? li.instances : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [running, serviceId]);

  if (running && instances) {
    return <ContainerLogs serviceId={serviceId} instances={instances} />;
  }

  return (
    <EmptyState
      icon={ScrollText}
      title="Container is not running"
      description="Runtime logs stream from a running container. Deploy or redeploy this service to start streaming its output."
    />
  );
}
