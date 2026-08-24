"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";

const ACCEPT_APP = /* GraphQL */ `
  mutation DeployWithoutMigratedData($id: String!) {
    deployWithoutMigratedData(id: $id) {
      id
      dataCopyError
    }
  }
`;

const ACCEPT_DATABASE = /* GraphQL */ `
  mutation StartWithoutMigratedData($id: String!) {
    startWithoutMigratedData(id: $id) {
      id
      dataCopyError
    }
  }
`;

/**
 * The data a migration could not bring, said where somebody is about to press
 * Deploy.
 *
 * A cross-host copy empties the destination volume before extracting into it, so
 * a copy that dies mid-stream leaves nothing or half of something - and starting
 * the workload on that is what makes the loss permanent (an engine handed an
 * empty data directory initialises a new one and reports success). Deploy, Start,
 * Restart and Redeploy are all refused while this is set, so the banner is not a
 * warning next to a button that still works: it is the explanation for a button
 * that does not.
 *
 * Two ways out, and both belong to the person, not to the platform. Copying again
 * means the migration wizard: the API key that reads the other side is never
 * stored, so nothing here could re-run the copy on its own even when the source
 * machine is still up. Accepting the loss is the other, and it has to exist -
 * the machine an app was migrated from is usually turned off soon after, and an
 * app that can never be deployed again would be a worse outcome than the one
 * this is protecting.
 */
export function DataCopyNotice({
  kind,
  id,
  name,
  error,
  canAccept,
}: {
  kind: "app" | "database";
  id: string;
  name: string;
  /** `dataCopyError` from the row. Empty renders nothing. */
  error: string;
  /** Whether the viewer holds the capability that would start it. */
  canAccept: boolean;
}) {
  const router = useRouter();
  if (!error) return null;

  const verb = kind === "app" ? "Deploy" : "Start";

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-2.5 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
        <div className="space-y-1">
          <p className="font-medium">
            {name}&apos;s data did not come across from the migration
          </p>
          <p className="text-muted-foreground">
            Its storage is empty, so {verb.toLowerCase()} is held until the data
            is copied again or you accept starting without it.
          </p>
          {/* Verbatim, and monospaced: this is the host's or the engine's own
              sentence, and it is what tells someone whether the copy is worth
              retrying or the source is simply gone. */}
          <p className="rounded bg-muted px-2 py-1 font-mono text-xs break-words text-muted-foreground">
            {error}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href="/settings/migrations">Copy the data again</Link>
        </Button>
        {canAccept && (
          <ConfirmAction
            trigger={
              <Button size="sm" variant="outline">
                {verb} anyway
              </Button>
            }
            title={`${verb} ${name} without its data?`}
            description={
              kind === "app"
                ? `${name} will start on empty storage. Anything it kept in those volumes is not coming back, and an app that writes to them will carry on as if it were new.`
                : `${name} will initialise a brand new, EMPTY database on that volume. The data that was meant to be there is not coming back.`
            }
            confirmLabel={`${verb} anyway`}
            successMessage={`${name} can be ${kind === "app" ? "deployed" : "started"} again`}
            onConfirm={async () => {
              const res = await gqlAction(
                kind === "app" ? ACCEPT_APP : ACCEPT_DATABASE,
                { id },
              );
              if (res.ok) router.refresh();
              return res;
            }}
          />
        )}
      </div>
    </div>
  );
}
