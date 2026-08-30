"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { RecopyDataDialog } from "@/components/shared/recopy-data-dialog";

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
  const [recopyOpen, setRecopyOpen] = React.useState(false);
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
        <Button size="sm" variant="outline" onClick={() => setRecopyOpen(true)}>
          Copy the data again
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
      <RecopyDataDialog
        open={recopyOpen}
        onOpenChange={setRecopyOpen}
        kind={kind}
        id={id}
        name={name}
      />
    </div>
  );
}
