"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The ONE delete-database confirmation - used by the Storage card menu and by the
 * database's Danger Zone, which only differ in where they go afterwards.
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
      title="Delete database?"
      description={`${databaseName} is stopped, and its container, all its data and every backup it has stored are permanently destroyed.`}
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
