"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Hammer, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { gqlAction } from "@/lib/graphql-client";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * The database's Danger Zone — two destructive actions, each behind a typed
 * confirmation:
 *  - Rebuild: wipe the data volume and re-provision a fresh, empty database
 *    from the current settings (same engine/version/credentials — the
 *    connection string keeps working). The "factory reset".
 *  - Delete: destroy the container + data volume (and, optionally, its S3
 *    backup artifacts) via the shared DeleteWithArtifacts, which is already
 *    database-aware. On success, back to the storage overview.
 */
export function DatabaseDanger({ db }: { db: DatabaseDTO }) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
        <CardDescription>
          These actions erase data and cannot be undone. Each asks you to type
          the database name first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4">
          <div className="min-w-56 flex-1 space-y-1">
            <p className="text-sm font-medium">Rebuild database</p>
            <p className="text-sm text-muted-foreground">
              Wipe the data volume and provision a fresh, empty database from
              the current settings — same engine, version and credentials, so
              the connection string keeps working. All data is erased; restore
              a backup afterwards to bring data back.
            </p>
          </div>
          <ConfirmAction
            trigger={
              <Button variant="destructive" size="sm">
                <Hammer className="size-4" />
                Rebuild
              </Button>
            }
            title={`Rebuild ${db.name}?`}
            description="This destroys the database container AND its data volume, then provisions a fresh, empty database with the same settings and credentials. All data is permanently erased."
            confirmLabel="Rebuild database"
            confirmText={db.name}
            successMessage="Database rebuilt from scratch"
            onConfirm={async () => {
              const res = await gqlAction(
                `mutation($id: String!) { rebuildDatabase(id: $id) { id } }`,
                { id: db.id },
              );
              if (res.ok) router.refresh();
              return res;
            }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4">
          <div className="min-w-56 flex-1 space-y-1">
            <p className="text-sm font-medium">Delete database</p>
            <p className="text-sm text-muted-foreground">
              Permanently destroy this database container and all its data,
              including any backup schedules attached to it.
            </p>
          </div>
          <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="size-4" />
            Delete
          </Button>
        </div>
      </CardContent>

      <DeleteWithArtifacts
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        targetKind="database"
        targetId={db.id}
        targetName={db.name}
        title={`Delete ${db.name}?`}
        description="This permanently destroys the database container and all its data, including any backup schedules attached to it."
        confirmLabel="Delete database"
        successMessage="Database deleted"
        deleteMutation={() =>
          gqlAction(`mutation($id: String!) { deleteDatabase(id: $id) }`, {
            id: db.id,
          })
        }
        onDeleted={() => router.push("/storage")}
      />
    </Card>
  );
}
