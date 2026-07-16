"use client";

import * as React from "react";
import { gql } from "@/lib/graphql-client";
import type { RuntimeSnapshot } from "@/lib/apps/display-status";
import type { RuntimeContainerView } from "@/components/apps/use-app-runtime";

/**
 * Poll what a database's container is ACTUALLY doing on the host — the DB twin
 * of {@link import("@/components/apps/use-app-runtime").useAppRuntime}. The
 * databaseStatus subscription only fires when the control plane changes
 * something; nothing pushes when the engine crash-loops on its own, so the
 * truth is pulled from the agent-backed databaseRuntime query (3s server-cache).
 */

const DATABASE_RUNTIME_QUERY = /* GraphQL */ `
  query DatabaseRuntime($databaseId: String!) {
    databaseRuntime(databaseId: $databaseId) {
      total
      running
      restarting
      unhealthy
      missing
      unreachable
      containers {
        name
        service
        state
        health
        restartCount
        running
        exposed
      }
    }
  }
`;

export interface DatabaseRuntimeView extends RuntimeSnapshot {
  containers: RuntimeContainerView[];
}

type Response = { databaseRuntime: DatabaseRuntimeView | null };

const DEFAULT_POLL_MS = 5_000;

export function useDatabaseRuntime(
  databaseId: string,
  { enabled = true, pollMs = DEFAULT_POLL_MS }: { enabled?: boolean; pollMs?: number } = {},
): DatabaseRuntimeView | null {
  const [runtime, setRuntime] = React.useState<DatabaseRuntimeView | null>(null);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      // Skip the round trip while the tab is backgrounded, but keep the timer
      // so it resumes on its own when the tab returns.
      if (document.visibilityState === "visible") {
        try {
          const data = await gql<Response>(DATABASE_RUNTIME_QUERY, { databaseId });
          if (!cancelled) setRuntime(data.databaseRuntime);
        } catch {
          // A failed poll is not evidence about the container — keep the last
          // answer rather than flipping the badge on a blip.
        }
      }
      if (!cancelled) timer = setTimeout(tick, pollMs);
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [databaseId, enabled, pollMs]);

  return enabled ? runtime : null;
}
