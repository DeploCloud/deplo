"use client";

import * as React from "react";
import { gqlSubscribe } from "@/lib/graphql-client";
import type { ProjectStatus, DeploymentStatus } from "@/lib/types";

/**
 * The live, client-tracked slice of a project's state. Seeded from the server
 * render and then kept current by a GraphQL subscription so the project header,
 * controls, tabs and gated pages (Console/Logs) react to start/stop/deploy
 * across every connected client without a reload.
 */
export type LiveProject = {
  id: string;
  slug: string;
  status: ProjectStatus;
  productionUrl: string | null;
  latestDeploymentStatus: DeploymentStatus | null;
};

const PROJECT_STATUS_SUBSCRIPTION = /* GraphQL */ `
  subscription ProjectStatus($slug: String!) {
    projectStatus(slug: $slug) {
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
  projectStatus: {
    id: string;
    slug: string;
    status: ProjectStatus;
    productionUrl: string | null;
    latestDeployment: { status: DeploymentStatus } | null;
  };
};

const LiveProjectContext = React.createContext<LiveProject | null>(null);

/**
 * Provides the live project state to the project layout subtree. `initial` is
 * the server-rendered snapshot (so the first paint is correct and SSR-stable);
 * the subscription then pushes every change.
 */
export function ProjectLiveStatusProvider({
  initial,
  children,
}: {
  initial: LiveProject;
  children: React.ReactNode;
}) {
  // The provider is keyed by slug in the layout, so it remounts (and re-seeds
  // from `initial`) on slug navigation — no re-seed effect needed.
  const [live, setLive] = React.useState<LiveProject>(initial);

  React.useEffect(() => {
    const unsubscribe = gqlSubscribe<SubResult>(
      PROJECT_STATUS_SUBSCRIPTION,
      { slug: initial.slug },
      (data) => {
        const p = data.projectStatus;
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
    <LiveProjectContext.Provider value={live}>
      {children}
    </LiveProjectContext.Provider>
  );
}

/**
 * Read the live project state. Returns null outside a provider, so callers can
 * fall back to their server-rendered props (e.g. a page rendered without the
 * provider in its tree).
 */
export function useLiveProject(): LiveProject | null {
  return React.useContext(LiveProjectContext);
}

/**
 * The project's live status, falling back to a server-rendered value when no
 * provider is mounted above the caller.
 */
export function useLiveStatus(fallback: ProjectStatus): ProjectStatus {
  return useLiveProject()?.status ?? fallback;
}

/** True when the project's container is running (status === "active"). */
export function useLiveRunning(fallback: boolean): boolean {
  const live = useLiveProject();
  return live ? live.status === "active" : fallback;
}
