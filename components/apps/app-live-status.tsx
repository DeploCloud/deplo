"use client";

import * as React from "react";
import { gqlSubscribe } from "@/lib/graphql-client";
import type { AppStatus, DeploymentStatus } from "@/lib/types";

/**
 * The live, client-tracked slice of an app's state. Seeded from the server
 * render and then kept current by a GraphQL subscription so the app header,
 * controls, tabs and gated pages (Console/Logs) react to start/stop/deploy
 * across every connected client without a reload.
 */
export type LiveApp = {
  id: string;
  slug: string;
  status: AppStatus;
  productionUrl: string | null;
  latestDeploymentId: string | null;
  latestDeploymentStatus: DeploymentStatus | null;
};

const PROJECT_STATUS_SUBSCRIPTION = /* GraphQL */ `
  subscription AppStatus($slug: String!) {
    appStatus(slug: $slug) {
      id
      slug
      status
      productionUrl
      latestDeployment {
        id
        status
      }
    }
  }
`;

type SubResult = {
  appStatus: {
    id: string;
    slug: string;
    status: AppStatus;
    productionUrl: string | null;
    latestDeployment: { id: string; status: DeploymentStatus } | null;
  };
};

const LiveAppContext = React.createContext<LiveApp | null>(null);

/**
 * Provides the live project state to the app layout subtree. `initial` is
 * the server-rendered snapshot (so the first paint is correct and SSR-stable);
 * the subscription then pushes every change.
 */
export function AppLiveStatusProvider({
  initial,
  children,
}: {
  initial: LiveApp;
  children: React.ReactNode;
}) {
  // The provider is keyed by slug in the layout, so it remounts (and re-seeds
  // from `initial`) on slug navigation — no re-seed effect needed.
  const [live, setLive] = React.useState<LiveApp>(initial);

  React.useEffect(() => {
    const unsubscribe = gqlSubscribe<SubResult>(
      PROJECT_STATUS_SUBSCRIPTION,
      { slug: initial.slug },
      (data) => {
        const p = data.appStatus;
        if (!p) return;
        setLive({
          id: p.id,
          slug: p.slug,
          status: p.status,
          productionUrl: p.productionUrl,
          latestDeploymentId: p.latestDeployment?.id ?? null,
          latestDeploymentStatus: p.latestDeployment?.status ?? null,
        });
      },
    );
    return unsubscribe;
  }, [initial.slug]);

  return (
    <LiveAppContext.Provider value={live}>
      {children}
    </LiveAppContext.Provider>
  );
}

/**
 * Read the live project state. Returns null outside a provider, so callers can
 * fall back to their server-rendered props (e.g. a page rendered without the
 * provider in its tree).
 */
export function useLiveApp(): LiveApp | null {
  return React.useContext(LiveAppContext);
}

/**
 * The app's live status, falling back to a server-rendered value when no
 * provider is mounted above the caller.
 */
export function useLiveStatus(fallback: AppStatus): AppStatus {
  return useLiveApp()?.status ?? fallback;
}

/** True when the app's container is running (status === "active"). */
export function useLiveRunning(fallback: boolean): boolean {
  const live = useLiveApp();
  return live ? live.status === "active" : fallback;
}
