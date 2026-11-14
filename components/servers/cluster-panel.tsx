import { TriangleAlert } from "lucide-react";

import type { ClusterWarning } from "@/lib/clusters/warnings";
import { StartLeaderButton } from "./cluster-actions";
import { CloudflareTokenFixButton } from "./cloudflare-token-fix";

/** The banners above an open cluster's servers, styled like an App page's. */
export function ClusterNoticeList({
  clusterId,
  warnings,
}: {
  clusterId: string;
  warnings: ClusterWarning[];
}) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-3">
      {warnings.map((w) => (
        <div
          key={w.key}
          className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-wash-strong px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="flex items-start gap-2.5 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
            <div className="space-y-1">
              <p className="font-medium">{w.title}</p>
              <p className="text-muted-foreground">{w.body}</p>
            </div>
          </div>
          {w.startLeader && <StartLeaderButton clusterId={clusterId} />}
          {w.fixCloudflareToken && <CloudflareTokenFixButton />}
        </div>
      ))}
    </div>
  );
}

export async function ClusterNotices({
  clusterId,
  warnings,
}: {
  clusterId: string;
  warnings: Promise<ClusterWarning[]>;
}) {
  return <ClusterNoticeList clusterId={clusterId} warnings={await warnings} />;
}
