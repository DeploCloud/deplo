"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { Loader2 } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { StatusDot } from "@/components/shared/status-badge";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { ScheduleLabel } from "@/components/shared/schedule-picker";
import { BackupTarget } from "@/components/storage/backup-target";
import { selectableProps } from "@/components/shared/card-selection";
import {
  useBackupActions,
  type BackupActionProps,
} from "@/components/storage/backup-actions";
import { cn, timeAgo } from "@/lib/utils";

export function BackupRow({
  backup,
  destinations,
  canManage,
  canRestore,
  canTestDestinations,
  selected,
  onSelect,
}: BackupActionProps & {
  selected: boolean;
  onSelect: (
    id: string,
    e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) => boolean;
}) {
  const { isRunning, toggle, pending, menu, dialogs } = useBackupActions({
    backup,
    destinations,
    canManage,
    canRestore,
    canTestDestinations,
  });

  return (
    <TableRow
      {...selectableProps(backup.id, (e) => onSelect(backup.id, e))}
      className={cn(selected && "bg-primary/10 hover:bg-primary/10")}
    >
      {/* A dump takes minutes and nothing here changes by itself: re-read the
          page while this one runs, wherever it was started from. */}
      <AutoRefresh active={isRunning} />
      <TableCell className="font-medium">{backup.name}</TableCell>
      <TableCell className="text-muted-foreground">
        <BackupTarget backup={backup} size={18} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {backup.destinationName}
      </TableCell>
      <TableCell>
        <ScheduleLabel cron={backup.schedule} timezone={backup.timezone} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {backup.retentionCount}{" "}
        {backup.retentionCount === 1 ? "backup" : "backups"}
      </TableCell>
      <TableCell>
        {backup.lastStatus === "never" ? (
          <span className="text-xs text-muted-foreground">Never run</span>
        ) : backup.lastStatus === "running" ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Running
          </span>
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
          disabled={pending || !canManage}
        />
      </TableCell>
      <TableCell className="text-right">
        {menu}
        {dialogs}
      </TableCell>
    </TableRow>
  );
}
