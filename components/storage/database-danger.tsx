"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { gqlAction } from "@/lib/graphql-client";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * The database's Danger Zone — delete the container + data volume (and,
 * optionally, its S3 backup artifacts) via the shared DeleteWithArtifacts,
 * which is already database-aware. On success, back to the storage overview.
 */
export function DatabaseDanger({ db }: { db: DatabaseDTO }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base text-destructive">Delete database</CardTitle>
        <CardDescription>
          Permanently destroy this database container and all its data. This
          cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          <Trash2 className="size-4" />
          Delete {db.name}
        </Button>
      </CardContent>

      <DeleteWithArtifacts
        open={open}
        onOpenChange={setOpen}
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
