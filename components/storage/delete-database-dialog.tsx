"use client";

import * as React from "react";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { gql, gqlAction } from "@/lib/graphql-client";

export function DeleteDatabaseDialog({
  open,
  onOpenChange,
  databaseId,
  databaseName,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  databaseId: string;
  databaseName: string;
  onDeleted: () => void;
}) {
  const connected = useConnectedApps(open ? databaseId : null);
  return (
    <DeleteWithArtifacts
      open={open}
      onOpenChange={onOpenChange}
      targetName={databaseName}
      title="Delete database?"
      description={`${databaseName} is stopped, and its container, all its data and every backup it has stored are permanently destroyed.`}
      consequence={
        connected.length > 0
          ? `${connected.join(", ")} also ${connected.length === 1 ? "loses its" : "lose their"} connection to it.`
          : undefined
      }
      confirmLabel="Delete database"
      successMessage="Database deleted"
      forceRetry={{
        label: "Delete it from Deplo anyway",
        description:
          "The database disappears from Deplo now, and Deplo keeps retrying to remove its container and data volume from the server.",
        confirmLabel: "Delete anyway",
        successMessage: "Removed from Deplo, its container will be cleaned up",
      }}
      deleteMutation={({ force }) =>
        gqlAction(
          `mutation($id: String!, $force: Boolean) { deleteDatabase(id: $id, force: $force) }`,
          { id: databaseId, force },
        )
      }
      onDeleted={onDeleted}
    />
  );
}

// Read when the dialog opens: the card and menu callers have no links of their own.
function useConnectedApps(databaseId: string | null): string[] {
  const [names, setNames] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!databaseId) return;
    let alive = true;
    gql<{ databaseAppLinks: { links: { appName: string }[] } | null }>(
      /* GraphQL */ `
        query ($id: String!) {
          databaseAppLinks(databaseId: $id) {
            links {
              appName
            }
          }
        }
      `,
      { id: databaseId },
    )
      .then((d) => {
        const all = d.databaseAppLinks?.links.map((l) => l.appName) ?? [];
        if (alive) setNames([...new Set(all)]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [databaseId]);
  return names;
}
