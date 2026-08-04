"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import { CapabilityTip, useAppCan } from "@/components/apps/app-capabilities";

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
        toast.success("Redeploy started");
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
          <RotateCw className="size-4" />
          Redeploy
        </Button>
      </CapabilityTip>
    );
  }

  return (
    <SimpleTooltip content="Redeploy the latest successful build">
      <Button variant={variant} size={size} onClick={redeploy} disabled={pending}>
        <RotateCw className={pending ? "size-4 animate-spin" : "size-4"} />
        {pending ? "Redeploying" : "Redeploy"}
      </Button>
    </SimpleTooltip>
  );
}
