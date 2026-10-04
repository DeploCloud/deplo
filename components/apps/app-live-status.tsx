"use client";

import * as React from "react";
import { gqlSubscribe } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import type { AppStatus } from "@/lib/types/app";
import type { DeploymentStatus } from "@/lib/types/deployment";

export type LiveApp = {
  id: string;
  slug: string;
  status: AppStatus;
  productionUrl: string | null;
  latestDeploymentId: string | null;
  latestDeploymentStatus: DeploymentStatus | null;
  restartLoopStoppedAt: string | null;
};

const PROJECT_STATUS_SUBSCRIPTION = /* GraphQL */ `
  subscription AppStatus($slug: String!) {
    appStatus(slug: $slug) {
      id
      slug
      status
      productionUrl
      restartLoopStoppedAt
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
    restartLoopStoppedAt: string | null;
    latestDeployment: { id: string; status: DeploymentStatus } | null;
  };
};

const LiveAppContext = React.createContext<LiveApp | null>(null);

export function AppLiveStatusProvider({
  initial,
  children,
}: {
  initial: LiveApp;
  children: React.ReactNode;
}) {
  // Keyed by slug in the layout, so it remounts and re-seeds from `initial`; no re-seed effect.
  const [live, setLive] = React.useState<LiveApp>(initial);
  const router = useRouter();
  // The pages under it are server-rendered: re-read them when the latest deploy moves on.
  const seenDeploy = React.useRef(
    `${initial.latestDeploymentId}:${initial.latestDeploymentStatus}`,
  );

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
          restartLoopStoppedAt: p.restartLoopStoppedAt,
          latestDeploymentId: p.latestDeployment?.id ?? null,
          latestDeploymentStatus: p.latestDeployment?.status ?? null,
        });
        const deploy = `${p.latestDeployment?.id ?? null}:${p.latestDeployment?.status ?? null}`;
        if (deploy !== seenDeploy.current) {
          seenDeploy.current = deploy;
          router.refresh();
        }
      },
    );
    return unsubscribe;
  }, [initial.slug, router]);

  return (
    <LiveAppContext.Provider value={live}>{children}</LiveAppContext.Provider>
  );
}

export function useLiveApp(): LiveApp | null {
  return React.useContext(LiveAppContext);
}

export function useLiveStatus(fallback: AppStatus): AppStatus {
  return useLiveApp()?.status ?? fallback;
}

export function useNeverDeployed(): boolean {
  const live = useLiveApp();
  return !!live && live.latestDeploymentId === null && live.status === "idle";
}

export function useLiveRunning(fallback: boolean): boolean {
  const live = useLiveApp();
  return live ? live.status === "active" : fallback;
}
