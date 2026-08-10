"use client";

import * as React from "react";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The ONE delete-database confirmation — used by the Storage card menu and by the
 * database's Danger Zone, which only differ in where they go afterwards.
 *
 * Deleting a database is a real teardown, not a record removal: the server stops
 * and destroys the container and its data volume first, and the mutation REFUSES
 * (deleting nothing) when it can't prove that happened — an unreachable host, a
 * stack the agent couldn't remove. The operator gets that reason verbatim in the
 * toast, and only then the "delete it anyway" option {@link DeleteWithArtifacts}
 * renders, for the case that matters: a server that is never coming back, whose
 * databases would otherwise be undeletable (a server can't be removed while it
 * still hosts one).
 */
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
  return (
    <DeleteWithArtifacts
      open={open}
      onOpenChange={onOpenChange}
      targetKind="database"
      targetId={databaseId}
      targetName={databaseName}
      title={`Delete ${databaseName}?`}
      description="This stops the database and permanently destroys its container, all its data, and every backup it has stored."
      confirmLabel="Delete database"
      successMessage="Database deleted"
      forceRetry={{
        label: "Delete it from Deplo anyway",
        description:
          "The database disappears from Deplo, but its container and data volume stay on the server and keep running there.",
        confirmLabel: "Delete anyway",
        successMessage: "Removed from Deplo — its container is still on the server",
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
