"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
import { gqlAction } from "@/lib/graphql-client";

/**
 * Advanced settings: rebuild the container. Surfaces the `rebuildApp` mutation —
 * a full deployment that rebuilds the image from the current source and REPLACES
 * the running container, even when nothing about the stack changed (the deploy
 * carries `forceRecreate`, so `compose up` can't decide there is nothing to do).
 * Not destructive (volumes/domains/env survive), so a plain button with an honest
 * description, no confirmation dialog. On success we follow the build itself, so
 * the user watches it instead of hunting for it in the list.
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

  function rebuild() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!) { rebuildApp(id: $id) { id latestDeployment { id } } }`,
        { id: appId },
        (d: { rebuildApp: { latestDeployment: { id: string } | null } | null }) =>
          d.rebuildApp?.latestDeployment?.id ?? null,
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
        <CardTitle className="flex items-center gap-2 text-base">
          <Hammer className="size-4 text-muted-foreground" />
          Rebuild container
        </CardTitle>
        <CardDescription>
          Rebuild the image from the current source and replace the running
          container with a fresh one — a full deployment that bakes in your
          latest code, environment variables and settings. Attached volumes,
          domains and data are untouched; the current container keeps serving
          until the new build is ready. Use it when the container looks stuck
          or out of sync with its configuration. Cached layers are reused — to
          build from scratch, clear the build cache first (Settings →
          Deployment → Build &amp; Output → Advanced).
        </CardDescription>
      </CardHeader>
      <CardFooter className="justify-end">
        <Button size="sm" variant="outline" onClick={rebuild} disabled={pending}>
          <Hammer className={pending ? "size-4 animate-pulse" : "size-4"} />
          {pending ? "Starting rebuild…" : "Rebuild container"}
        </Button>
      </CardFooter>
    </Card>
  );
}
