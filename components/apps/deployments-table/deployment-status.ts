"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { gqlSubscribe } from "@/lib/graphql-client";
import type { DeploymentStatus } from "@/lib/types/deployment";

// IN_PROGRESS deployments are still owned by the queue and the build job, so they
// can only be CANCELED, never selected for deletion.
export const IN_PROGRESS = new Set<DeploymentStatus>(["queued", "building"]);

// STATUS_ORDER is the fixed lifecycle order the Status filter reads in.
export const STATUS_ORDER: DeploymentStatus[] = [
  "queued",
  "building",
  "ready",
  "error",
  "canceled",
];

// STATUS_LABELS is the one spelling of each deployment status in the UI.
export const STATUS_LABELS: Record<DeploymentStatus, string> = {
  queued: "Queued",
  building: "Building",
  ready: "Ready",
  error: "Error",
  canceled: "Canceled",
};

// Reuses the app-keyed `appStatus` stream: its `latestDeployment` carries the
// in-flight build's current status.
const DEPLOYMENT_STATUS_SUB = /* GraphQL */ `
  subscription DeploymentRowStatus($slug: String!) {
    appStatus(slug: $slug) {
      id
      latestDeployment {
        id
        status
      }
    }
  }
`;
type StatusSub = {
  appStatus: {
    id: string;
    latestDeployment: { id: string; status: DeploymentStatus } | null;
  } | null;
};

// useLiveDeploymentStatuses keeps the deployment Status chips live without a reload.
export function useLiveDeploymentStatuses(
  rows: { id: string; appSlug: string; status: DeploymentStatus }[],
): (id: string, serverStatus: DeploymentStatus) => DeploymentStatus {
  const router = useRouter();
  const [overlay, setOverlay] = React.useState<
    ReadonlyMap<string, DeploymentStatus>
  >(() => new Map());

  const statusOf = React.useCallback(
    (id: string, serverStatus: DeploymentStatus) =>
      overlay.get(id) ?? serverStatus,
    [overlay],
  );

  // Distinct app slugs with an in-progress row, by EFFECTIVE status - the only apps
  // whose deployment status can still change.
  const slugKey = React.useMemo(() => {
    const s = new Set<string>();
    for (const r of rows)
      if (IN_PROGRESS.has(overlay.get(r.id) ?? r.status)) s.add(r.appSlug);
    return [...s].sort().join(",");
  }, [rows, overlay]);

  React.useEffect(() => {
    if (!slugKey) return;
    const unsubs = slugKey.split(",").map((slug) =>
      gqlSubscribe<StatusSub>(
        DEPLOYMENT_STATUS_SUB,
        { slug },
        (data) => {
          const dep = data.appStatus?.latestDeployment;
          if (!dep) return;
          setOverlay((prev) => {
            if (prev.get(dep.id) === dep.status) return prev;
            const next = new Map(prev);
            next.set(dep.id, dep.status);
            return next;
          });
          // A settled build flips its actions/selectability too - pull fresh
          // server data. Bounded: fires once, on the in-progress→terminal edge.
          if (!IN_PROGRESS.has(dep.status)) router.refresh();
        },
        // A slug we can no longer watch (deleted/renamed app) must not spam.
        () => {},
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [slugKey, router]);

  return statusOf;
}
