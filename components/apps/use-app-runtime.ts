"use client";

import * as React from "react";
import { gql } from "@/lib/graphql-client";
import type { RuntimeSnapshot } from "@/lib/apps/display-status";

/**
 * Poll what an app's containers are ACTUALLY doing on the host.
 *
 * The `appStatus` subscription only fires when the control plane itself changes
 * something (deploy / start / stop) — nothing pushes when a container dies on
 * its own, which is exactly when the stored status starts lying. So the truth
 * has to be pulled: a short poll of the agent-backed `appRuntime` query, held
 * for 3s server-side so several watchers of the same app cost one round trip.
 */

const APP_RUNTIME_QUERY = /* GraphQL */ `
  query AppRuntime($appId: String!) {
    appRuntime(appId: $appId) {
      total
      running
      restarting
      missing
      unreachable
      containers {
        name
        service
        state
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
      // Skip the round trip while the tab is in the background — a forgotten tab
      // watching a crash loop must not poll an agent for hours — but keep the
      // timer alive so it resumes on its own when the tab comes back.
      if (document.visibilityState === "visible") {
        try {
          const data = await gql<Response>(APP_RUNTIME_QUERY, { appId });
          if (!cancelled) setRuntime(data.appRuntime);
        } catch {
          // A failed poll is not evidence about the container — keep the last
          // answer rather than flipping the badge on a blip.
        }
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [appId, enabled]);

  // Disabled means "we are not claiming the app is up, so there is nothing to
  // check" — report no probe rather than a stale one from before it stopped.
  return enabled ? runtime : null;
}
