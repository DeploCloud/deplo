"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { gqlSubscribe } from "@/lib/graphql-client";
import type { DeploymentStatus } from "@/lib/types/deployment";
import { withLiveStatus } from "./status-overlay";

export const IN_PROGRESS = new Set<DeploymentStatus>(["queued", "building"]);

export const STATUS_ORDER: DeploymentStatus[] = [
  "queued",
  "building",
  "ready",
  "error",
  "canceled",
];

export const STATUS_LABELS: Record<DeploymentStatus, string> = {
  queued: "Queued",
  building: "Building",
  ready: "Ready",
  error: "Error",
  canceled: "Canceled",
};

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

  const onScreen = React.useRef<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    onScreen.current = new Set(rows.map((r) => r.id));
  }, [rows]);

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
          setOverlay((prev) =>
            withLiveStatus(prev, dep.id, dep.status, onScreen.current),
          );
          if (!IN_PROGRESS.has(dep.status)) router.refresh();
        },
        () => {},
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [slugKey, router]);

  return statusOf;
}
