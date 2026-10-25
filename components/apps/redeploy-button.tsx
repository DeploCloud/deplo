"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
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
  label: asked,
  pendingLabel,
  hint,
}: {
  appId: string;
  slug: string;
  variant?: "outline" | "default" | "secondary";
  size?: "sm" | "default";
  // A redeploy offered for a specific reason ("Update") names itself after it.
  label?: string;
  pendingLabel?: string;
  hint?: string;
}) {
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();
  const can = useAppCan("deploy_apps");
  const first = useNeverDeployed();
  const label = first ? "Deploy" : (asked ?? "Redeploy");
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
        if (res.data?.id) {
          router.push(`/apps/${slug}/deployments/${res.data.id}`);
        } else {
          router.refresh();
        }
      } else toast.error(res.error);
    });
  }

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
          : (hint ?? "Deploy the latest version of this app again")
      }
    >
      <Button
        variant={variant}
        size={size}
        onClick={redeploy}
        disabled={pending}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Icon className="size-4" />
        )}
        {pending
          ? first
            ? "Deploying"
            : (pendingLabel ?? "Redeploying")
          : label}
      </Button>
    </SimpleTooltip>
  );
}
