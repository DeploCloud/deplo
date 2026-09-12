"use client";

import * as React from "react";
import { gql } from "@/lib/graphql-client";
import type { AppSummary } from "@/lib/data/apps";
import type {
  OverviewAppStateView,
  OverviewRuntimeView,
} from "./overview-state";

const OVERVIEW_APP_STATES_QUERY = /* GraphQL */ `
  query OverviewAppStates($appIds: [ID!]!) {
    overviewAppStates(appIds: $appIds) {
      appId
      status
      neverDeployed
      runtime {
        total
        running
        restarting
        unhealthy
        maxRestartCount
        unhealthyContainers
        unreachable
      }
    }
  }
`;

type OverviewAppStatesResponse = {
  overviewAppStates: Array<
    Omit<OverviewAppStateView, "runtime"> & {
      runtime: Omit<OverviewRuntimeView, "missing"> | null;
    }
  >;
};

const POLL_MS = 5_000;

export function useOverviewAppStates(
  services: AppSummary[],
): ReadonlyMap<string, OverviewAppStateView> {
  const idKey = services.map((app) => app.id).join("\0");
  const ids = React.useMemo(() => (idKey ? idKey.split("\0") : []), [idKey]);
  const [states, setStates] = React.useState<Map<string, OverviewAppStateView>>(
    () => new Map(),
  );

  React.useEffect(() => {
    let cancelled = false;
    const visible = new Set(ids);
    const pruneTimer = setTimeout(() => {
      if (cancelled) return;
      setStates((previous) => {
        const next = new Map([...previous].filter(([id]) => visible.has(id)));
        return next.size === previous.size &&
          [...next.keys()].every((id) => previous.has(id))
          ? previous
          : next;
      });
    }, 0);
    if (ids.length === 0)
      return () => {
        cancelled = true;
        clearTimeout(pruneTimer);
      };

    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;

    const tick = async () => {
      if (cancelled || document.visibilityState !== "visible" || inFlight)
        return;
      inFlight = true;
      request = new AbortController();
      try {
        const data = await gql<OverviewAppStatesResponse>(
          OVERVIEW_APP_STATES_QUERY,
          { appIds: ids },
          request.signal,
        );
        if (!cancelled) {
          setStates(
            new Map(
              data.overviewAppStates.map((state) => [
                state.appId,
                {
                  ...state,
                  runtime: state.runtime
                    ? { ...state.runtime, missing: [] }
                    : null,
                },
              ]),
            ),
          );
        }
      } catch {
        // Keep the last valid answer during a temporary GraphQL failure.
      } finally {
        inFlight = false;
        request = undefined;
        if (!cancelled) timer = setTimeout(tick, POLL_MS);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        void tick();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void tick();
    return () => {
      cancelled = true;
      request?.abort();
      clearTimeout(pruneTimer);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [idKey, ids]);

  return states;
}
