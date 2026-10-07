"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
import { toast } from "sonner";
import { gqlAction } from "@/lib/graphql-client";

const RETRY = /* GraphQL */ `
  mutation RetryNetworkIsolation {
    retryNetworkIsolation
  }
`;

const DISMISS = /* GraphQL */ `
  mutation DismissNetworkIsolationNotice {
    dismissNetworkIsolationNotice
  }
`;

export function NetworkSweepNotice({ failed }: { failed: number }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  if (failed <= 0) return null;

  const run = (doc: string, field: string, done?: string) =>
    start(async () => {
      const res = await gqlAction<Record<string, boolean>, boolean>(
        doc,
        {},
        (d) => d[field],
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (done) toast.success(done);
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-wash-strong px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-2.5 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div>
          <p className="font-medium">
            {failed === 1
              ? "1 app or database is still on the old shared network"
              : `${failed} apps and databases are still on the old shared network`}
          </p>
          <p className="mt-1 text-muted-foreground">
            Nothing is down: they keep running, and each one moves on its next
            deploy. Activity says which ones and why.{" "}
            <DocsLink topic="network.isolationSweep" />
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            run(RETRY, "retryNetworkIsolation", "Moving the remaining stacks")
          }
        >
          Try again
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          disabled={pending}
          onClick={() => run(DISMISS, "dismissNetworkIsolationNotice")}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
