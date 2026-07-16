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
 * Advanced settings: rebuild the container from scratch. Surfaces the
 * `rebuildApp` mutation (previously API-only) — a full deployment that
 * rebuilds the image from the current source and rolls the container. Not
 * destructive (volumes/domains/env survive), so a plain button with an honest
 * description, no confirmation dialog. On success we follow the build to the
 * Deployments page, same destination the header Redeploy flow lands on.
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
        `mutation($id: String!) { rebuildApp(id: $id) { id } }`,
        { id: appId },
      );
      if (res.ok) {
        toast.success("Rebuild started");
        router.push(`/apps/${slug}/deployments`);
      } else toast.error(res.error);
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
          or out of sync with its configuration.
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
