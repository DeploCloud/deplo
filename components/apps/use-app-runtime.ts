"use client";

import * as React from "react";
import { gql } from "@/lib/graphql-client";
import type { RuntimeSnapshot } from "@/lib/apps/display-status";

const APP_RUNTIME_QUERY = /* GraphQL */ `
  query AppRuntime($appId: String!) {
    appRuntime(appId: $appId) {
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

export interface RuntimeContainerView {
  name: string;
  service: string;
  state: string;
  health: string;
  restartCount: number;
  startedAtUnix?: number;
  running: boolean;
  exposed: boolean;
}

export interface AppRuntimeView extends RuntimeSnapshot {
  containers: RuntimeContainerView[];
}

type Response = { appRuntime: AppRuntimeView | null };

const POLL_MS = 5_000;

export function useAppRuntime(
  appId: string,
  { enabled = true }: { enabled?: boolean } = {},
): AppRuntimeView | null {
  const [runtime, setRuntime] = React.useState<AppRuntimeView | null>(null);

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
