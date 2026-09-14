"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BackupScheduleFields } from "@/components/storage/backup-schedule-fields";
import { gqlAction } from "@/lib/graphql-client";
import { isValidSchedule } from "@/lib/schedule";
import type { BackupDTO } from "@/lib/data/backups/schedules";
import { noun, type BackupTarget, type Destination } from "./target";
import {
  DestinationField,
  NameField,
  type ScheduleFields,
} from "./schedule-fields";

// EditScheduleDialog - change an existing schedule's name, destination, frequency and retention.
export function EditScheduleDialog({
  schedule,
  target,
  destinations,
  canTestDestinations,
  open,
  onOpenChange,
}: {
  schedule: BackupDTO;
  target: BackupTarget;
  destinations: Destination[];
  canTestDestinations: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  // Seeded on mount; the parent remounts this dialog (via `key`) each time it
  // opens, so a cancelled edit never leaks stale input into the next open.
  const [fields, setFields] = React.useState<ScheduleFields>({
    name: schedule.name,
    destinationId: schedule.destinationId,
    schedule: schedule.schedule,
    timezone: schedule.timezone || "UTC",
    retention: schedule.retentionCount,
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    // Closes on the click; a refusal reopens it with the fields as typed.
    onOpenChange(false);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $input: UpdateBackupInput!) { updateBackup(id: $id, input: $input) }`,
        {
          id: schedule.id,
          input: {
            name: fields.name,
            destinationId: fields.destinationId,
            schedule: fields.schedule,
            timezone: fields.timezone,
            retentionCount: fields.retention,
          },
        },
      );
      if (res.ok) toast.success("Backup schedule updated");
      else {
        onOpenChange(true);
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit schedule</DialogTitle>
          <DialogDescription>
            Change this schedule&apos;s name, destination, frequency and
            retention. The {noun(target)} it backs up can&apos;t be changed.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          {/* No auto-rename here: the name is already the user's own. */}
          <NameField
            value={fields.name}
            onChange={(v) => setFields((f) => ({ ...f, name: v }))}
            autoFocus
          />
          <DestinationField
            value={fields.destinationId}
            onChange={(v) => setFields((f) => ({ ...f, destinationId: v }))}
            target={target}
            destinations={destinations}
            canTestDestinations={canTestDestinations}
          />
          <BackupScheduleFields
            idPrefix="backup"
            schedule={fields.schedule}
            onScheduleChange={(cron) =>
              setFields((f) => ({ ...f, schedule: cron }))
            }
            timezone={fields.timezone}
            onTimezoneChange={(tz) =>
              setFields((f) => ({ ...f, timezone: tz }))
            }
            retention={fields.retention}
            onRetentionChange={(count) =>
              setFields((f) => ({ ...f, retention: count }))
            }
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                !fields.name.trim() ||
                !fields.destinationId ||
                !isValidSchedule(fields.schedule)
              }
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Save changes"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
