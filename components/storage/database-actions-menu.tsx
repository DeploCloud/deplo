"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { MoreHorizontal, Pencil, Settings, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RenameDialog } from "@/components/shared/rename-dialog";
import { DeleteDatabaseDialog } from "@/components/storage/delete-database-dialog";
import { needsCapability } from "@/components/apps/app-capabilities";
import { gqlAction } from "@/lib/graphql-client";

export function DatabaseActionsMenu({
  id,
  name,
  canConfigure,
  canDelete,
}: {
  id: string;
  name: string;
  canConfigure: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Database actions"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <SimpleTooltip
            content={
              canConfigure
                ? "Change this database's name"
                : needsCapability("configure_databases")
            }
            side="left"
          >
            <DropdownMenuItem
              onSelect={() => setRenameOpen(true)}
              disabled={!canConfigure}
            >
              <Pencil className="size-4" />
              Rename
            </DropdownMenuItem>
          </SimpleTooltip>
          <SimpleTooltip content="Open this database's settings" side="left">
            <DropdownMenuItem asChild>
              <Link
                href={`/storage/databases/${id}/settings`}
                className="cursor-pointer"
              >
                <Settings className="size-4" />
                Settings
              </Link>
            </DropdownMenuItem>
          </SimpleTooltip>
          <DropdownMenuSeparator />
          <SimpleTooltip
            content={
              canDelete
                ? "Permanently delete this database and its data"
                : needsCapability("delete_databases")
            }
            side="left"
          >
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDeleteOpen(true)}
              disabled={!canDelete}
            >
              <Trash2 className="size-4" />
              Delete database
            </DropdownMenuItem>
          </SimpleTooltip>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        noun="database"
        name={name}
        rename={(next) =>
          gqlAction(
            `mutation($id: String!, $name: String!) { renameDatabase(id: $id, name: $name) { id } }`,
            { id: id, name: next },
          )
        }
      />
      <DeleteDatabaseDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        databaseId={id}
        databaseName={name}
        onDeleted={() => router.push("/storage")}
      />
    </>
  );
}
