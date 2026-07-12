"use client";

import * as React from "react";
import { TerminalSquare } from "lucide-react";
import { gql } from "@/lib/graphql-client";
import { EmptyState } from "@/components/shared/empty-state";
import { ContainerConsole } from "@/components/apps/container-console";
import { useLiveRunning } from "@/components/apps/app-live-status";
import type { ConsoleInstance } from "@/lib/data/console";

type ConsoleInfo = {
  containerName: string;
  image: string;
  instances: ConsoleInstance[];
};

const CONSOLE_INFO_QUERY = /* GraphQL */ `
  query ConsoleInfo($appId: String!) {
    consoleInfo(appId: $appId) {
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
 * Console page body that follows the app's live running state. When the
 * container is running it shows the terminal; when it stops (live, no reload)
 * it swaps to the "not running" empty state, and back again when it restarts —
 * fetching fresh console info on the transition since a stopped project has
 * none server-rendered.
 */
export function LiveConsole({
  appId,
  initialInfo,
  initialRunning,
}: {
  appId: string;
  initialInfo: ConsoleInfo | null;
  initialRunning: boolean;
}) {
  const running = useLiveRunning(initialRunning);
  // Console info for the *current* running session. Seeded from SSR; re-fetched
  // whenever the app transitions into the running state (a stopped project
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
    gql<ConsoleInfoResponse>(CONSOLE_INFO_QUERY, { appId })
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
  }, [running, appId]);

  if (running && info) {
    return (
      <ContainerConsole
        appId={appId}
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
          : "The console is available once the app has a running deployment. Deploy or redeploy this app, then attach."
      }
    />
  );
}
