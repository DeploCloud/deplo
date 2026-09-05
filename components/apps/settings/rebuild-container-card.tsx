"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Hammer } from "lucide-react";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import { CapabilityTip, useAppCan } from "@/components/apps/app-capabilities";

/**
 * Advanced settings: rebuild the container.
 */
export function RebuildContainerCard({
  appId,
  slug,
}: {
  appId: string;
  slug: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  // A rebuild IS a deployment, so it answers to the deploy permission.
  const can = useAppCan("deploy_apps");

  function rebuild() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!) { rebuildApp(id: $id) { id latestDeployment { id } } }`,
        { id: appId },
        (d: {
          rebuildApp: { latestDeployment: { id: string } | null } | null;
        }) => d.rebuildApp?.latestDeployment?.id ?? null,
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Rebuild started");
      // Land on the live build when we know which one it is; the list is the
      // fallback (it shows the same build at the top, already building).
      router.push(
        res.data
          ? `/apps/${slug}/deployments/${res.data}`
          : `/apps/${slug}/deployments`,
      );
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          <Hammer className="size-4 text-muted-foreground" />
          Rebuild container
          <InfoTip
            content="A full deployment from the current source, for a container that looks stuck. Cached layers are reused."
            docs="deploy.trace"
          />
        </CardTitle>
        {/* The consequence, which is the thing you want to know before clicking. */}
        <CardDescription>
          Volumes, domains and data are untouched, and the current container
          keeps serving until the new build is ready.
        </CardDescription>
      </CardHeader>
      <CardFooter className="justify-end">
        <CapabilityTip cap="deploy_apps">
          <Button
            size="sm"
            variant="outline"
            onClick={rebuild}
            disabled={pending || !can}
          >
            <Hammer className={pending ? "size-4 animate-pulse" : "size-4"} />
            {pending ? "Starting rebuild" : "Rebuild container"}
          </Button>
        </CapabilityTip>
      </CardFooter>
    </Card>
  );
}
