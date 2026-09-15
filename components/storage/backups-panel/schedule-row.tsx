"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Loader2, MoreHorizontal, Pencil, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TableCell, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { StatusDot } from "@/components/shared/status-badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { timeAgo } from "@/lib/utils";
import { ScheduleLabel } from "@/components/shared/schedule-picker";
import { useOptimisticRow } from "@/components/shared/optimistic-list";
import { gqlAction } from "@/lib/graphql-client";
import type { BackupDTO } from "@/lib/data/backups/schedules";
import type { BackupTarget, Destination } from "./target";
import { MenuAction } from "./menu-action";
import { EditScheduleDialog } from "./edit-schedule-dialog";

export function ScheduleRow({
  schedule,
  target,
  destinations,
  canManage,
  canTestDestinations,
  onStart,
}: {
  schedule: BackupDTO;
  target: BackupTarget;
  destinations: Destination[];
  canManage: boolean;
  canTestDestinations: boolean;
  onStart: (destinationId: string, run: () => Promise<unknown>) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const { hide, restore } = useOptimisticRow(schedule.id);
  const [editOpen, setEditOpen] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const isRunning = running || schedule.lastStatus === "running";

  function run() {
    setRunning(true);
    onStart(schedule.destinationId, () =>
      gqlAction(`mutation($id: String!) { runBackup(id: $id) }`, {
        id: schedule.id,
      }).then((res) => {
        setRunning(false);
        if (res.ok) toast.success("Backup finished");
        else toast.error(res.error);
        router.refresh();
      }),
    );
  }

  function toggle(enabled: boolean) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $enabled: Boolean!) { toggleBackup(id: $id, enabled: $enabled) }`,
        { id: schedule.id, enabled },
      );
      if (!res.ok) toast.error(res.error);
      else router.refresh();
    });
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{schedule.name}</TableCell>
      <TableCell className="text-muted-foreground">
        {schedule.destinationName}
      </TableCell>
      <TableCell>
        <ScheduleLabel cron={schedule.schedule} timezone={schedule.timezone} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {schedule.retentionCount}{" "}
        {schedule.retentionCount === 1 ? "backup" : "backups"}
      </TableCell>
      <TableCell>
        {isRunning ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Running
          </span>
        ) : schedule.lastStatus === "never" ? (
          <span className="text-xs text-muted-foreground">Never run</span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs">
            <StatusDot status={schedule.lastStatus} />
            {schedule.lastRunAt ? timeAgo(schedule.lastRunAt) : ""}
          </span>
        )}
      </TableCell>
      <TableCell>
        <Switch
          checked={schedule.enabled}
          onCheckedChange={toggle}
          disabled={pending || !canManage}
        />
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Schedule menu">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <MenuAction
              disabled={pending || isRunning || !canManage}
              tooltip={
                !canManage
                  ? "You don't have permission to run backups"
                  : isRunning
                    ? "This backup is already running"
                    : "Run this backup now"
              }
            >
              <DropdownMenuItem
                onSelect={run}
                disabled={pending || isRunning || !canManage}
              >
                <Play className="size-4" />
                Run now
              </DropdownMenuItem>
            </MenuAction>
            <MenuAction
              disabled={!canManage}
              tooltip={
                canManage
                  ? "Edit this schedule"
                  : "You don't have permission to edit backup schedules"
              }
            >
              <DropdownMenuItem
                disabled={!canManage}
                onSelect={() => setEditOpen(true)}
              >
                <Pencil className="size-4" />
                Edit
              </DropdownMenuItem>
            </MenuAction>
            <DropdownMenuSeparator />
            <MenuAction
              disabled={!canManage}
              tooltip={
                canManage
                  ? "Delete this schedule"
                  : "You don't have permission to delete backup schedules"
              }
            >
              <DropdownMenuItem
                variant="destructive"
                disabled={!canManage}
                onSelect={() => setConfirmOpen(true)}
              >
                <Trash2 className="size-4" />
                Delete
              </DropdownMenuItem>
            </MenuAction>
          </DropdownMenuContent>
        </DropdownMenu>
        <EditScheduleDialog
          key={editOpen ? "edit-open" : "edit-closed"}
          schedule={schedule}
          target={target}
          destinations={destinations}
          canTestDestinations={canTestDestinations}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
        <ConfirmAction
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Delete backup schedule?"
          description={`${schedule.name} stops running. Backups it already made are kept.`}
          confirmLabel="Delete schedule"
          successMessage="Backup schedule deleted"
          optimistic
          onConfirm={async () => {
            hide();
            const res = await gqlAction(
              `mutation($id: String!) { deleteBackup(id: $id) }`,
              { id: schedule.id },
            );
            if (!res.ok) restore();
            router.refresh();
            return res;
          }}
        />
      </TableCell>
    </TableRow>
  );
}
