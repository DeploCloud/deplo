"use client";

import * as React from "react";
import { gqlSubscribe } from "@/lib/graphql-client";
import type { ServiceStatus, DeploymentStatus } from "@/lib/types";

/**
 * The live, client-tracked slice of a service's state. Seeded from the server
 * render and then kept current by a GraphQL subscription so the service header,
 * controls, tabs and gated pages (Console/Logs) react to start/stop/deploy
 * across every connected client without a reload.
 */
export type LiveService = {
  id: string;
  slug: string;
  status: ServiceStatus;
  productionUrl: string | null;
  latestDeploymentStatus: DeploymentStatus | null;
};

const PROJECT_STATUS_SUBSCRIPTION = /* GraphQL */ `
  subscription ServiceStatus($slug: String!) {
    serviceStatus(slug: $slug) {
      id
      slug
      status
      productionUrl
      latestDeployment {
        status
      }
    }
  }
`;

type SubResult = {
  serviceStatus: {
    id: string;
    slug: string;
    status: ServiceStatus;
    productionUrl: string | null;
    latestDeployment: { status: DeploymentStatus } | null;
  };
};

const LiveServiceContext = React.createContext<LiveService | null>(null);

/**
 * Provides the live project state to the service layout subtree. `initial` is
 * the server-rendered snapshot (so the first paint is correct and SSR-stable);
 * the subscription then pushes every change.
 */
export function ServiceLiveStatusProvider({
  initial,
  children,
}: {
  initial: LiveService;
  children: React.ReactNode;
}) {
  // The provider is keyed by slug in the layout, so it remounts (and re-seeds
  // from `initial`) on slug navigation — no re-seed effect needed.
  const [live, setLive] = React.useState<LiveService>(initial);

  React.useEffect(() => {
    const unsubscribe = gqlSubscribe<SubResult>(
      PROJECT_STATUS_SUBSCRIPTION,
      { slug: initial.slug },
      (data) => {
        const p = data.serviceStatus;
        if (!p) return;
        setLive({
          id: p.id,
          slug: p.slug,
          status: p.status,
          productionUrl: p.productionUrl,
          latestDeploymentStatus: p.latestDeployment?.status ?? null,
        });
      },
    );
    return unsubscribe;
  }, [initial.slug]);

  return (
    <LiveServiceContext.Provider value={live}>
      {children}
    </LiveServiceContext.Provider>
  );
}

/**
 * Read the live project state. Returns null outside a provider, so callers can
 * fall back to their server-rendered props (e.g. a page rendered without the
 * provider in its tree).
 */
export function useLiveService(): LiveService | null {
  return React.useContext(LiveServiceContext);
}

/**
 * The service's live status, falling back to a server-rendered value when no
 * provider is mounted above the caller.
 */
export function useLiveStatus(fallback: ServiceStatus): ServiceStatus {
  return useLiveService()?.status ?? fallback;
}

/** True when the service's container is running (status === "active"). */
export function useLiveRunning(fallback: boolean): boolean {
  const live = useLiveService();
  return live ? live.status === "active" : fallback;
}
