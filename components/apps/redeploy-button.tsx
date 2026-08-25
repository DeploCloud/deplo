"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCw, Rocket, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import { CapabilityTip, useAppCan } from "@/components/apps/app-capabilities";
import { useNeverDeployed } from "@/components/apps/app-live-status";

export function RedeployButton({
  appId,
  slug,
  variant = "outline",
  size = "sm",
}: {
  appId: string;
  /** Owning app slug — used to route to the new deployment's live logs. */
  slug: string;
  variant?: "outline" | "default" | "secondary";
  size?: "sm" | "default";
}) {
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();
  const can = useAppCan("deploy_apps");
  // Nothing has ever been built for this app — an imported one, or one created by
  // someone without `deploy_apps`.
  const first = useNeverDeployed();
  const label = first ? "Deploy" : "Redeploy";
  const Icon = first ? Rocket : RotateCw;

  function redeploy() {
    startTransition(async () => {
      const res = await gqlAction<
        { redeploy: { id: string | null } | null },
        { id: string | null } | null
      >(
        `mutation($appId: String!) { redeploy(appId: $appId) { id } }`,
        { appId },
        (d) => d.redeploy,
      );
      if (res.ok) {
        toast.success(first ? "Deploy started" : "Redeploy started");
        // Follow the new build straight to its live logs (same destination as the
        // create + Save & Deploy flows); fall back to a refresh if the redeploy
        // returned no id.
        if (res.data?.id) {
          router.push(`/apps/${slug}/deployments/${res.data.id}`);
        } else {
          router.refresh();
        }
      } else toast.error(res.error);
    });
  }

  // Without the capability the button is plainly disabled (and says why on
  // hover) instead of failing on click - the server would refuse it anyway.
  if (!can) {
    return (
      <CapabilityTip cap="deploy_apps">
        <Button variant={variant} size={size} disabled>
          <Icon className="size-4" />
          {label}
        </Button>
      </CapabilityTip>
    );
  }

  return (
    <SimpleTooltip
      content={
        first
          ? "Build and start this app for the first time"
          : "Redeploy the latest successful build"
      }
    >
      <Button
        variant={variant}
        size={size}
        onClick={redeploy}
        disabled={pending}
      >
        {/* The house spinner while it fires — a spinning rocket is not a thing. */}
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Icon className="size-4" />
        )}
        {pending ? (first ? "Deploying" : "Redeploying") : label}
      </Button>
    </SimpleTooltip>
  );
}
