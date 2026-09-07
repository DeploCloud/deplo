"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RedeployButton } from "@/components/apps/redeploy-button";
import { useAppCan } from "@/components/apps/app-capabilities";
import { gqlAction } from "@/lib/graphql-client";

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
  const router = useRouter();
  const canDeploy = useAppCan("deploy_apps");
  const canDismiss = useAppCan("manage_env");
  const [pending, startTransition] = React.useTransition();
  if (!pendingChangesAt || neverDeployed) return null;

  // The stamp is a hint, not a diff: adding a variable and taking it back leaves
  // the app exactly as deployed, and only the person who did it knows that.
  function dismiss() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($appId: String!) { dismissPendingChanges(appId: $appId) }`,
        { appId },
      );
      if (res.ok) router.refresh();
      else toast.error(res.error);
    });
  }

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
      <div className="flex items-center gap-1">
        {canDeploy && <RedeployButton appId={appId} slug={slug} />}
        {canDismiss && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss"
            disabled={pending}
            onClick={dismiss}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
