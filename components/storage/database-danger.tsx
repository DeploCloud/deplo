"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { ArrowLeftRight, Hammer, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DeleteDatabaseDialog } from "@/components/storage/delete-database-dialog";
import { TransferDatabaseDialog } from "@/components/storage/transfer-database-dialog";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { needsCapability } from "@/components/apps/app-capabilities";
import { gqlAction } from "@/lib/graphql-client";
import type { DatabaseDTO } from "@/lib/data/databases/rows";
import { DocsLink } from "@/components/ui/docs-link";

export function DatabaseDanger({
  db,
  canMove,
}: {
  db: DatabaseDTO;
  canMove: boolean;
}) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base text-destructive">
          Danger Zone
        </CardTitle>
        <CardDescription>
          Each action here asks you to type the database name first.{" "}
          <DocsLink topic="databases.lifecycle" />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4">
          <div className="min-w-56 flex-1 space-y-1">
            <p className="text-sm font-medium">Transfer to another team</p>
            <p className="text-sm text-muted-foreground">
              Hand this database to another team. It keeps its data; this team
              loses access.
            </p>
          </div>
          {canMove ? (
            <TransferDatabaseDialog
              databaseId={db.id}
              databaseName={db.name}
              onTransferred={() => router.push("/storage")}
              trigger={
                <Button variant="outline" size="sm">
                  <ArrowLeftRight className="size-4" />
                  Transfer
                </Button>
              }
            />
          ) : (
            <SimpleTooltip content={needsCapability("move_databases")}>
              <span className="inline-flex cursor-not-allowed">
                <Button variant="outline" size="sm" disabled>
                  <ArrowLeftRight className="size-4" />
                  Transfer
                </Button>
              </span>
            </SimpleTooltip>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4">
          <div className="min-w-56 flex-1 space-y-1">
            <p className="text-sm font-medium">Rebuild database</p>
            <p className="text-sm text-muted-foreground">
              Wipe the data volume and provision a fresh, empty database.
              Engine, version and credentials stay, so the connection string
              keeps working.
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
            description={
              <>
                The container and its data volume are destroyed, then a{" "}
                <strong>fresh, empty database</strong> is provisioned with the
                same settings.
              </>
            }
            consequence="All data is erased. Restore a backup afterwards to bring it back."
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
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
        </div>
      </CardContent>

      <DeleteDatabaseDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        databaseId={db.id}
        databaseName={db.name}
        onDeleted={() => router.push("/storage")}
      />
    </Card>
  );
}
