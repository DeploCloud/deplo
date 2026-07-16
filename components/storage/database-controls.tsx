"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Play, Square, RotateCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import { useLiveDatabaseStatus } from "@/components/storage/database-live-status";
import type { DatabaseStatus } from "@/lib/types";

/**
 * Start / Stop / Restart for a database — the DB twin of AppControls. Live
 * status (subscription) drives the button so start/stop/restart reflect in real
 * time; everything is disabled while provisioning (the compose project doesn't
 * exist yet).
 */
export function DatabaseControls({
  id,
  status: serverStatus,
}: {
  id: string;
  status: DatabaseStatus;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const status = useLiveDatabaseStatus(serverStatus);
  const provisioning = status === "provisioning";
  const running = status === "running";

  function act(mutation: string, success: string) {
    startTransition(async () => {
      const res = await gqlAction(mutation, { id });
      if (res.ok) {
        toast.success(success);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  if (provisioning) {
    return (
      <Button variant="outline" size="sm" disabled>
        <Loader2 className="size-4 animate-spin" />
        Provisioning
      </Button>
    );
  }

  return (
    <>
      {running ? (
        <SimpleTooltip content="Stop this database's container">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              act(
                `mutation($id: String!) { setDatabaseRunning(id: $id, running: false) { id } }`,
                "Database stopped",
              )
            }
            disabled={pending}
          >
            <Square className="size-4" />
            Stop
          </Button>
        </SimpleTooltip>
      ) : (
        <SimpleTooltip content="Start this database's stopped container">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              act(
                `mutation($id: String!) { setDatabaseRunning(id: $id, running: true) { id } }`,
                "Database started",
              )
            }
            disabled={pending}
          >
            <Play className="size-4" />
            Start
          </Button>
        </SimpleTooltip>
      )}
      <SimpleTooltip content="Restart the container (stop then start) — no config change">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            act(
              `mutation($id: String!) { restartDatabase(id: $id) { id } }`,
              "Database restarted",
            )
          }
          disabled={pending || !running}
        >
          <RotateCw className="size-4" />
          Restart
        </Button>
      </SimpleTooltip>
    </>
  );
}
