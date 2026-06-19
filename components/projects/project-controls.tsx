"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Play, Square, Hammer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { gqlAction } from "@/lib/graphql-client";
import type { ProjectStatus } from "@/lib/types";

export function ProjectControls({
  projectId,
  status,
}: {
  projectId: string;
  status: ProjectStatus;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  // Anything other than an explicitly stopped (idle) project counts as running.
  const stopped = status === "idle";

  function act(mutation: string, success: string) {
    startTransition(async () => {
      const res = await gqlAction(mutation, { id: projectId });
      if (res.ok) {
        toast.success(success);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <>
      {stopped ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            act(
              `mutation($id: String!) { startProject(id: $id) { id } }`,
              "Container started",
            )
          }
          disabled={pending}
        >
          <Play className="size-4" />
          Start
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            act(
              `mutation($id: String!) { stopProject(id: $id) { id } }`,
              "Container stopped",
            )
          }
          disabled={pending}
        >
          <Square className="size-4" />
          Stop
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          act(
            `mutation($id: String!) { rebuildProject(id: $id) { id } }`,
            "Rebuild started",
          )
        }
        disabled={pending}
      >
        <Hammer className="size-4" />
        Rebuild
      </Button>
    </>
  );
}
