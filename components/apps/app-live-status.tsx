"use client";

import * as React from "react";
import { gqlSubscribe } from "@/lib/graphql-client";
import type { AppStatus } from "@/lib/types/app";
import type { DeploymentStatus } from "@/lib/types/deployment";

// LiveApp - the live, client-tracked slice of an app's state.
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

// AppLiveStatusProvider - live app state for the layout subtree, seeded from the server snapshot.
export function AppLiveStatusProvider({
  initial,
  children,
}: {
  initial: LiveApp;
  children: React.ReactNode;
}) {
  // Keyed by slug in the layout, so it remounts and re-seeds from `initial`; no re-seed effect needed.
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
    <LiveAppContext.Provider value={live}>{children}</LiveAppContext.Provider>
  );
}

// useLiveApp - the live app state, or null outside a provider so callers fall back to their props.
export function useLiveApp(): LiveApp | null {
  return React.useContext(LiveAppContext);
}

// useLiveStatus - the app's live status, falling back to a server-rendered value.
export function useLiveStatus(fallback: AppStatus): AppStatus {
  return useLiveApp()?.status ?? fallback;
}

// useNeverDeployed - true when the app has no deployment row and was never started.
export function useNeverDeployed(): boolean {
  const live = useLiveApp();
  return !!live && live.latestDeploymentId === null && live.status === "idle";
}

// useLiveRunning - true when the app's container is running.
export function useLiveRunning(fallback: boolean): boolean {
  const live = useLiveApp();
  return live ? live.status === "active" : fallback;
}
