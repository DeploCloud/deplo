"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { Loader2 } from "lucide-react";
import { gql, gqlAction } from "@/lib/graphql-client";
import { EmptyState } from "@/components/shared/empty-state";
import { ConsoleEmpty, ConsolePane } from "@/components/console/console-pane";
import { NotRunningGraphic } from "@/components/apps/not-running-graphic";
import { useLiveRunning } from "@/components/apps/app-live-status";
import type { PaneTitle } from "@/components/shared/pane-title";
import type { ConsoleInstance } from "@/lib/data/console";

type ConsoleInfo = {
  containerName: string;
  instances: ConsoleInstance[];
};

const CONSOLE_INFO_QUERY = /* GraphQL */ `
  query ConsoleInfo($appId: String!) {
    consoleInfo(appId: $appId) {
      containerName
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
 * An App's console, following the app's live running state.
 */
export function LiveConsole({
  appId,
  title,
  initialInfo,
  initialRunning,
}: {
  appId: string;
  title: PaneTitle;
  initialInfo: ConsoleInfo | null;
  initialRunning: boolean;
}) {
  const running = useLiveRunning(initialRunning);
  // Console info for the *current* running session. Display is gated on `running`, so
  // we never null this on stop - it is simply ignored, which keeps all state writes
  // inside async callbacks (no synchronous effect churn).
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
            ? { containerName: ci.containerName, instances: ci.instances }
            : null,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [running, appId]);

  // Stable identity: the pane re-probes whenever this changes, so a new closure
  // per render would put it in a loop.
  const probeShell = React.useCallback(
    async (containerName: string) => {
      const res = await gqlAction(
        `query($input: ShellLabelInput!){ shellLabel(input: $input) }`,
        { input: { appId, containerName } },
        (d: { shellLabel: string | null }) => ({ shell: d.shellLabel }),
      );
      return res.ok ? (res.data?.shell ?? null) : null;
    },
    [appId],
  );

  if (running && info && info.instances.length > 0) {
    return (
      <ConsolePane
        id={appId}
        title={title}
        instances={info.instances}
        initialName={info.containerName}
        probeShell={probeShell}
      />
    );
  }

  return (
    <ConsoleEmpty title={title}>
      {loading ? (
        <EmptyState
          icon={Loader2}
          iconClassName="animate-spin"
          title="Connecting to the console"
          description="The app just started, attaching now."
        />
      ) : (
        <EmptyState
          graphic={<NotRunningGraphic />}
          title="App is not running"
          docs="console.overview"
          description="Deploy this app, then come back to open a console in it."
        />
      )}
    </ConsoleEmpty>
  );
}
