"use client";

import * as React from "react";
import { Brush, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";

/** The server's Reclaim disk cleanup, started from wherever its disk is shown. */
export function CleanupNowButton({
  serverId,
  serverName,
}: {
  serverId: string;
  serverName: string;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();

  function run() {
    start(async () => {
      const res = await gqlAction(
        /* GraphQL */ `
          mutation RunDockerCleanupNow($serverId: String!) {
            runDockerCleanupNow(serverId: $serverId) {
              id
            }
          }
        `,
        { serverId },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Cleaning up ${serverName} in the background`, {
        action: {
          label: "Show",
          onClick: () =>
            router.push(`/settings/servers/${serverId}?tab=cleanup`),
        },
      });
    });
  }

  return (
    <SimpleTooltip content="Deplo already does this on a schedule. Run it now to free space right away.">
      <Button variant="outline" size="sm" onClick={run} disabled={pending}>
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Brush className="size-3.5" />
        )}
        Clean up
      </Button>
    </SimpleTooltip>
  );
}
