"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { gqlAction } from "@/lib/graphql-client";

const RETRY = /* GraphQL */ `
  mutation RetryNetworkIsolation {
    retryNetworkIsolation
  }
`;

/**
 * The stacks the network-isolation move could not reach, said where somebody can
 * act on it. They still run where they were, so this is a delay, not an outage.
 */
export function NetworkSweepNotice({
  failed,
  canRetry,
}: {
  /** How many stacks stayed on the old network. 0 renders nothing. */
  failed: number;
  /** Whether the viewer is an instance admin (the only one who may re-run it). */
  canRetry: boolean;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  if (failed <= 0) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-2.5 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
        <div className="space-y-1">
          <p className="font-medium">
            {failed} {failed === 1 ? "app or database" : "apps and databases"}{" "}
            did not move to their own network
          </p>
          <p className="mt-1 text-muted-foreground">
            They are still running where they were. Deploying one moves it, or
            try the whole move again. Activity says which ones and why.
          </p>
        </div>
      </div>
      {canRetry && (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await gqlAction<
                { retryNetworkIsolation: boolean },
                boolean
              >(RETRY, {}, (d) => d.retryNetworkIsolation);
              if (res.ok) {
                toast.success("Moving the remaining stacks");
                router.refresh();
              } else toast.error(res.error);
            })
          }
        >
          Try again
        </Button>
      )}
    </div>
  );
}
