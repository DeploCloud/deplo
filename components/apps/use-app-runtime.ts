"use client";

import * as React from "react";
import { gql } from "@/lib/graphql-client";
import type { RuntimeSnapshot } from "@/lib/apps/display-status";
import { useLiveApp } from "@/components/apps/app-live-status";

const APP_RUNTIME_QUERY = /* GraphQL */ `
  query AppRuntime($appId: String!) {
    appRuntime(appId: $appId) {
      total
      running
      restarting
      unhealthy
      missing
      unreachable
      unreachableServers
      containers {
        name
        service
        state
        health
        restartCount
        startedAtUnix
        running
        exposed
        server
      }
    }
  }
`;

export interface RuntimeContainerView {
  name: string;
  service: string;
  state: string;
  health: string;
  restartCount: number;
  startedAtUnix?: number;
  running: boolean;
  exposed: boolean;
  server?: string | null;
}

export interface AppRuntimeView extends RuntimeSnapshot {
  containers: RuntimeContainerView[];
  unreachableServers?: string[];
}

type Response = { appRuntime: AppRuntimeView | null };

const POLL_MS = 5_000;
// Wide enough for a slow first load; a tab opened later than this asks again.
const SEED_MS = 15_000;

export function useAppRuntime(
  appId: string,
  { enabled = true }: { enabled?: boolean } = {},
): AppRuntimeView | null {
  const live = useLiveApp();
  const seed = live?.id === appId ? live.runtime : undefined;
  // The server's own read while it is fresh: never a stored status shown as live.
  const [runtime, setRuntime] = React.useState<AppRuntimeView | null>(() =>
    seed && Date.now() - seed.at < SEED_MS ? seed.value : null,
  );

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const data = await gql<Response>(APP_RUNTIME_QUERY, { appId });
          if (!cancelled) setRuntime(data.appRuntime);
        } catch {}
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [appId, enabled]);

  return enabled ? runtime : null;
}
