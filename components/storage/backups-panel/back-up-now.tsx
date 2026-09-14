"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DestinationCombobox } from "@/components/storage/destination-combobox";
import { gqlAction } from "@/lib/graphql-client";
import { noun, type BackupTarget, type Destination } from "./target";

// BackUpNow - the one-off dump, started from the Back up menu.
export function BackUpNow({
  target,
  destinations,
  canTestDestinations,
  open,
  onOpenChange,
  onStart,
}: {
  target: BackupTarget;
  destinations: Destination[];
  canTestDestinations: boolean;
  /** Opened from the Back up menu, which carries the gate; no trigger here. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Puts a placeholder row on the page and keeps it refreshing until this
   *  backup lands. */
  onStart: (destinationId: string, run: () => Promise<unknown>) => void;
}) {
  const router = useRouter();
  const [destinationId, setDestinationId] = React.useState(
    destinations[0]?.id ?? "",
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    // The mutation runs the WHOLE dump - it resolves only once the archive is written.
    onOpenChange(false);
    const mutation =
      target.kind === "app"
        ? `mutation($id: String!, $destinationId: String!) {
             runAppBackup(appId: $id, destinationId: $destinationId)
           }`
        : `mutation($id: String!, $destinationId: String!) {
             runDatabaseBackup(databaseId: $id, destinationId: $destinationId)
           }`;
    onStart(destinationId, () =>
      gqlAction(mutation, { id: target.id, destinationId }).then((res) => {
        if (res.ok) toast.success("Backup finished");
        else {
          toast.error(res.error);
          onOpenChange(true);
        }
        router.refresh();
      }),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Back up now</DialogTitle>
          <DialogDescription>
            {target.kind === "app"
              ? "Dump this app's volumes, files and compose/env snapshot to a destination now - no schedule needed."
              : "Dump this database to a destination now - no schedule needed."}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <FieldLabel
              htmlFor="backup-now-destination"
              info="Where this backup is written. Each one shows whether Deplo could reach it."
              docs="backups.destinations"
            >
              Destination
            </FieldLabel>
            <DestinationCombobox
              id="backup-now-destination"
              destinations={destinations}
              value={destinationId}
              onChange={setDestinationId}
              sameDiskServerId={target.serverId}
              sameDiskNoun={noun(target)}
              canProbe={canTestDestinations}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!destinationId}>
              Start backup
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
