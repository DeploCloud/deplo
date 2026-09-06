"use client";

import { TriangleAlert } from "lucide-react";
import { RedeployButton } from "@/components/apps/redeploy-button";
import { useAppCan } from "@/components/apps/app-capabilities";

/**
 * Config saved but not live: a variable, a limit or a build setting changes
 * nothing inside a running container until the next deploy hands it over.
 */
export function PendingChangesNotice({
  appId,
  slug,
  pendingChangesAt,
  neverDeployed,
}: {
  appId: string;
  slug: string;
  /** `App.pendingChangesAt` - null renders nothing. */
  pendingChangesAt: string | null;
  /** Nothing has ever been deployed, so there is no live version to be behind. */
  neverDeployed: boolean;
}) {
  const canDeploy = useAppCan("deploy_apps");
  if (!pendingChangesAt || neverDeployed) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning-wash-strong px-3.5 py-2.5 text-sm">
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div>
          <p className="font-medium text-warning">Changes not deployed yet</p>
          <p className="mt-1 text-muted-foreground">
            {canDeploy
              ? "Deploy the app to apply them."
              : "They apply on this app's next deploy."}
          </p>
        </div>
      </div>
      {canDeploy && <RedeployButton appId={appId} slug={slug} />}
    </div>
  );
}
