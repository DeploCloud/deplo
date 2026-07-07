"use client";

import * as React from "react";
import { TerminalSquare } from "lucide-react";
import { gql } from "@/lib/graphql-client";
import { EmptyState } from "@/components/shared/empty-state";
import { ContainerConsole } from "@/components/services/container-console";
import { useLiveRunning } from "@/components/services/service-live-status";
import type { ConsoleInstance } from "@/lib/data/console";

type ConsoleInfo = {
  containerName: string;
  image: string;
  instances: ConsoleInstance[];
};

const CONSOLE_INFO_QUERY = /* GraphQL */ `
  query ConsoleInfo($serviceId: String!) {
    consoleInfo(serviceId: $serviceId) {
      containerName
      image
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

type ConsoleInfoResponse = {
  consoleInfo: (ConsoleInfo & { running: boolean }) | null;
};

/**
 * Console page body that follows the project's live running state. When the
 * container is running it shows the terminal; when it stops (live, no reload)
 * it swaps to the "not running" empty state, and back again when it restarts —
 * fetching fresh console info on the transition since a stopped project has
 * none server-rendered.
 */
export function LiveConsole({
  serviceId,
  initialInfo,
  initialRunning,
}: {
  serviceId: string;
  initialInfo: ConsoleInfo | null;
  initialRunning: boolean;
}) {
  const running = useLiveRunning(initialRunning);
  // Console info for the *current* running session. Seeded from SSR; re-fetched
  // whenever the project transitions into the running state (a stopped project
  // has no info, and a restart may target a fresh container). Display is gated
  // on `running`, so we never null this on stop — it's simply ignored, which
  // keeps all state writes inside async callbacks (no synchronous effect churn).
  const [info, setInfo] = React.useState<ConsoleInfo | null>(
    initialRunning ? initialInfo : null,
  );
  // Running but no console info yet means we're fetching it post-start.
  const loading = running && !info;

  React.useEffect(() => {
    if (!running) return;
    let cancelled = false;
    gql<ConsoleInfoResponse>(CONSOLE_INFO_QUERY, { serviceId })
      .then((data) => {
        if (cancelled) return;
        const ci = data.consoleInfo;
        setInfo(
          ci?.running
            ? {
                containerName: ci.containerName,
                image: ci.image,
                instances: ci.instances,
              }
            : null,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [running, serviceId]);

  if (running && info) {
    return (
      <ContainerConsole
        serviceId={serviceId}
        containerName={info.containerName}
        image={info.image}
        instances={info.instances}
      />
    );
  }

  return (
    <EmptyState
      icon={TerminalSquare}
      title={
        loading ? "Connecting to container…" : "Container is not running"
      }
      description={
        loading
          ? "The project just started — attaching to the console."
          : "The console is available once the project has a running deployment. Deploy or redeploy this project, then attach."
      }
    />
  );
}
