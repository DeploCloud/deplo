"use client";

import * as React from "react";
import { toast } from "sonner";
import { Play, Trash2, MoreHorizontal } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusDot } from "@/components/shared/status-badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { timeAgo } from "@/lib/utils";
import {
  runBackupAction,
  toggleBackupAction,
  deleteBackupAction,
} from "@/lib/actions/backups";
import type { BackupDTO } from "@/lib/data/backups";

export function BackupRow({ backup }: { backup: BackupDTO }) {
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  function run() {
    startTransition(async () => {
      const res = await runBackupAction(backup.id);
      if (res.ok) toast.success("Backup started");
      else toast.error(res.error);
    });
  }

  function toggle(enabled: boolean) {
    startTransition(async () => {
      const res = await toggleBackupAction(backup.id, enabled);
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{backup.name}</TableCell>
      <TableCell className="text-muted-foreground">
        {backup.databaseName ?? ""}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {backup.destinationName}
      </TableCell>
      <TableCell>
        <code className="font-mono text-xs">{backup.schedule}</code>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {backup.retentionDays}d
      </TableCell>
      <TableCell>
        {backup.lastStatus === "never" ? (
          <span className="text-xs text-muted-foreground">Never run</span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs">
            <StatusDot status={backup.lastStatus} />
            {backup.lastRunAt ? timeAgo(backup.lastRunAt) : ""}
          </span>
        )}
      </TableCell>
      <TableCell>
        <Switch
          checked={backup.enabled}
          onCheckedChange={toggle}
          disabled={pending}
        />
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Backup menu">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={run} disabled={pending}>
              <Play className="size-4" />
              Run now
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={(e) => {
                e.preventDefault();
                setConfirmOpen(true);
              }}
            >
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ConfirmAction
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Delete ${backup.name}?`}
          description="This removes the backup schedule. Existing backup files in your bucket are not deleted."
          confirmLabel="Delete schedule"
          successMessage="Backup schedule deleted"
          onConfirm={() => deleteBackupAction(backup.id)}
        />
      </TableCell>
    </TableRow>
  );
}
