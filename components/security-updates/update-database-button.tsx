"use client";

import * as React from "react";
import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";

// Pulls the database's own image tag again and recreates it on that build; the data stays.
export function UpdateDatabaseButton({
  id,
  name,
}: {
  id: string;
  name: string;
}) {
  return (
    <ConfirmAction
      trigger={
        <Button size="sm" variant="outline">
          <RotateCw className="size-4" />
          Update
        </Button>
      }
      title="Update database?"
      description={
        <>
          Deplo pulls the latest build of <strong>{name}</strong>&apos;s image
          and starts it again on it. Its data stays.
        </>
      }
      consequence="The database restarts, so apps using it lose their connection for a few seconds."
      confirmLabel="Update"
      variant="default"
      successMessage="Database updated"
      onConfirm={() =>
        gqlAction(
          `mutation($id: String!) { redeployDatabase(id: $id, pull: true) { id } }`,
          { id },
        )
      }
    />
  );
}
