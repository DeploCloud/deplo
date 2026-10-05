"use client";

import * as React from "react";
import { Brush, Loader2 } from "lucide-react";
import { toast } from "sonner";

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
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs leading-none text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        {pending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Brush className="size-3" />
        )}
        Clean up
      </button>
    </SimpleTooltip>
  );
}
