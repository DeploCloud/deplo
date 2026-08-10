"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  BackupScheduleFields,
  browserTimezone,
} from "@/components/storage/backup-schedule-fields";
import { DestinationCombobox } from "@/components/storage/destination-combobox";
import { gqlAction } from "@/lib/graphql-client";
import { DEFAULT_SCHEDULE, isValidSchedule } from "@/lib/schedule";
import type { DestinationOption } from "@/lib/data/destinations";

type TargetKind = "database" | "app";

export function CreateBackup({
  databases,
  services = [],
  destinations,
  canCreate = true,
  canTestDestinations = false,
  autoOpen = false,
}: {
  /** `serverId` is only used to flag a destination sitting on the target's own
   *  disk; leave it out and the picker simply says nothing. */
  databases: { id: string; name: string; serverId?: string | null }[];
  services?: { id: string; name: string; serverId?: string | null }[];
  destinations: DestinationOption[];
  /** Whether the current user may schedule a backup (`manage_backups`). False
   *  shows the button disabled with a tooltip saying so and nothing can open the
   *  dialog. Defaults to true for the per-app and per-database backup tabs,
   *  whose pages already refuse the whole surface without the capability. */
  canCreate?: boolean;
  /** Whether this user may run the destination picker's live probe
   *  (`manage_backup_destinations`). Without it the picker shows the stored
   *  badges instead of firing a mutation the server would refuse. */
  canTestDestinations?: boolean;
  /** Open on mount — used by the global "New ▸ Schedule backup" menu
   *  (which links to /storage?new=backup). */
  autoOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(autoOpen && canCreate);
  const [pending, startTransition] = React.useTransition();

  // Drop the ?new=backup param after opening so a refresh/Back doesn't reopen it.
  React.useEffect(() => {
    if (autoOpen) router.replace("/storage", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [name, setName] = React.useState("");
  // Apps are the common case — a whole app (volumes, files, compose/env
  // snapshot) is what most people come here to protect, and a database that
  // matters usually belongs to one. Databases still win the default when the
  // team has no apps at all, so the dialog never opens on an empty select.
  const [targetKind, setTargetKind] = React.useState<TargetKind>(
    services.length === 0 && databases.length > 0 ? "database" : "app"
  );
  const [databaseId, setDatabaseId] = React.useState<string>(
    databases[0]?.id ?? ""
  );
  const [appId, setAppId] = React.useState<string>(
    services[0]?.id ?? ""
  );
  const [destinationId, setDestinationId] = React.useState<string>(
    destinations[0]?.id ?? ""
  );
  const [schedule, setSchedule] = React.useState(DEFAULT_SCHEDULE);
  const [timezone, setTimezone] = React.useState(browserTimezone);
  const [retention, setRetention] = React.useState(14);

  const noDeps = destinations.length === 0;
  // Why the button can't be clicked, if it can't. The missing permission wins:
  // adding a destination would not unblock it.
  const blocked = !canCreate
    ? "You don't have permission to schedule backups"
    : noDeps
      ? "Add a backup destination first"
      : null;
  // The chosen target must have a concrete id selected — otherwise the schedule
  // would point at nothing.
  const targetId = targetKind === "database" ? databaseId : appId;
  // The server the chosen target runs on — a destination on it is a same-disk copy.
  const targetServerId =
    (targetKind === "database" ? databases : services).find((t) => t.id === targetId)
      ?.serverId ?? null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: CreateBackupInput!) { createBackup(input: $input) }`,
        {
          input: {
            name,
            targetKind,
            databaseId: targetKind === "database" ? databaseId || null : null,
            appId: targetKind === "app" ? appId || null : null,
            destinationId,
            schedule,
            timezone,
            retentionDays: retention,
          },
        }
      );
      if (res.ok) {
        toast.success("Backup schedule created");
        setOpen(false);
        setName("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          {blocked ? (
            // Disabled buttons swallow pointer events, so wrap in a focusable
            // span to keep the tooltip reachable. No DialogTrigger here means a
            // click can never open the dialog while it is blocked.
            <span tabIndex={0}>
              <Button size="sm" disabled>
                <Plus className="size-4" />
                New Backup
              </Button>
            </span>
          ) : (
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4" />
                New Backup
              </Button>
            </DialogTrigger>
          )}
        </TooltipTrigger>
        <TooltipContent>{blocked ?? "Schedule a backup"}</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule a backup</DialogTitle>
          <DialogDescription>
            Periodically back up a database or an app to a backup destination.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid gap-4">
            <div className="space-y-2">
              <Label htmlFor="new-backup-name">Name</Label>
              <Input
                id="new-backup-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nightly Postgres backup"
              />
            </div>
            {/* Target-kind toggle: a schedule backs up either a database or a
                whole project (volumes + files + compose/env snapshot). */}
            <div className="space-y-2">
              <FieldLabel
                info={
                  <>
                    Choose whether this schedule backs up a database or an app.
                    An app backup captures its volumes, files, and compose/env
                    snapshot.
                  </>
                }
              >
                Target
              </FieldLabel>
              <div className="grid grid-cols-2 gap-1 rounded-lg border border-border p-1">
                <Button
                  type="button"
                  size="sm"
                  variant={targetKind === "app" ? "secondary" : "ghost"}
                  onClick={() => setTargetKind("app")}
                >
                  App
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={targetKind === "database" ? "secondary" : "ghost"}
                  onClick={() => setTargetKind("database")}
                >
                  Database
                </Button>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                {targetKind === "database" ? (
                  <>
                    <Label htmlFor="new-backup-database">Database</Label>
                    <Select value={databaseId} onValueChange={setDatabaseId}>
                      <SelectTrigger id="new-backup-database">
                        <SelectValue placeholder="Select one" />
                      </SelectTrigger>
                      <SelectContent>
                        {databases.map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                ) : (
                  <>
                    <Label htmlFor="new-backup-app">App</Label>
                    <Select value={appId} onValueChange={setAppId}>
                      <SelectTrigger id="new-backup-app">
                        <SelectValue placeholder="Select one" />
                      </SelectTrigger>
                      <SelectContent>
                        {services.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
              </div>
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="new-backup-destination"
                  info="Where backup archives are written and kept. Each one shows whether Deplo could reach it."
                >
                  Destination
                </FieldLabel>
                <DestinationCombobox
                  id="new-backup-destination"
                  destinations={destinations}
                  value={destinationId}
                  onChange={setDestinationId}
                  sameDiskServerId={targetServerId}
                  sameDiskNoun={targetKind === "database" ? "database" : "app"}
                  canProbe={canTestDestinations}
                />
              </div>
            </div>
            <BackupScheduleFields
              idPrefix="new-backup"
              schedule={schedule}
              onScheduleChange={setSchedule}
              timezone={timezone}
              onTimezoneChange={setTimezone}
              retention={retention}
              onRetentionChange={setRetention}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                !name.trim() ||
                !destinationId ||
                !targetId ||
                !isValidSchedule(schedule)
              }
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : "Create schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
