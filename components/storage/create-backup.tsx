"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Boxes, Database as DatabaseIcon, Loader2, Plus } from "lucide-react";
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
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChoiceCard } from "@/components/shared/choice-card";
import {
  BackupScheduleFields,
  DEFAULT_RETENTION,
  browserTimezone,
  suggestScheduleName,
} from "@/components/storage/backup-schedule-fields";
import { DestinationCombobox } from "@/components/storage/destination-combobox";
import {
  TargetCombobox,
  type BackupTargetOption,
} from "@/components/storage/target-combobox";
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
  databases: BackupTargetOption[];
  services?: BackupTargetOption[];
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
  // Named after its frequency until the user says otherwise — the same as the
  // per-app dialog, so the two never disagree about what a new schedule is
  // called or about whether Create is reachable on open.
  const [name, setName] = React.useState(() =>
    suggestScheduleName(DEFAULT_SCHEDULE),
  );
  const [nameTouched, setNameTouched] = React.useState(false);
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
  const [retention, setRetention] = React.useState(DEFAULT_RETENTION);

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
            retentionCount: retention,
          },
        }
      );
      if (res.ok) {
        toast.success("Backup schedule created");
        setOpen(false);
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
              <FieldLabel
                htmlFor="new-backup-name"
                info="What this schedule is called in the list. Follows the frequency until you change it."
              >
                Name
              </FieldLabel>
              <Input
                id="new-backup-name"
                value={name}
                onChange={(e) => {
                  setNameTouched(true);
                  setName(e.target.value);
                }}
              />
            </div>
            {/* Target-kind choice: a schedule backs up either a database or a
                whole app (volumes + files + compose/env snapshot). Two cards in
                a real radio group - the pair of Buttons this replaced looked
                like a segmented control and answered to neither the arrow keys
                nor a screen reader. */}
            <div className="space-y-2">
              <FieldLabel info="An app backup captures its volumes, files and compose/env snapshot. A database backup is a dump of that database alone.">
                Target
              </FieldLabel>
              <div
                role="radiogroup"
                aria-label="What to back up"
                className="grid gap-3 sm:grid-cols-2"
              >
                <ChoiceCard
                  title="App"
                  blurb="Volumes, files and settings"
                  icon={Boxes}
                  selected={targetKind === "app"}
                  disabled={services.length === 0}
                  disabledNote="No apps in this team yet"
                  onSelect={() => setTargetKind("app")}
                />
                <ChoiceCard
                  title="Database"
                  blurb="A dump of one database"
                  icon={DatabaseIcon}
                  selected={targetKind === "database"}
                  disabled={databases.length === 0}
                  disabledNote="No databases in this team yet"
                  onSelect={() => setTargetKind("database")}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                {targetKind === "database" ? (
                  <>
                    <FieldLabel htmlFor="new-backup-database">
                      Database
                    </FieldLabel>
                    <TargetCombobox
                      id="new-backup-database"
                      kind="database"
                      targets={databases}
                      value={databaseId}
                      onChange={setDatabaseId}
                    />
                  </>
                ) : (
                  <>
                    <FieldLabel htmlFor="new-backup-app">App</FieldLabel>
                    <TargetCombobox
                      id="new-backup-app"
                      kind="app"
                      targets={services}
                      value={appId}
                      onChange={setAppId}
                    />
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
              onScheduleChange={(cron) => {
                setSchedule(cron);
                if (!nameTouched) setName(suggestScheduleName(cron));
              }}
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
