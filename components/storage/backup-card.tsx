"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { Cloud, Loader2, Server } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/shared/status-badge";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { ScheduleLabel } from "@/components/shared/schedule-picker";
import {
  useBackupActions,
  type BackupActionProps,
} from "@/components/storage/backup-actions";
import { BackupTarget, targetHref } from "@/components/storage/backup-target";
import { OverlayLink } from "@/components/shared/overlay-link";
import { formatBytes, timeAgo } from "@/lib/utils";

const OUTCOME: Record<string, string> = {
  success: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
};

export function BackupCard({
  backup,
  destinations,
  canManage,
  canRestore,
  canTestDestinations,
}: BackupActionProps) {
  const { isRunning, toggle, pending, menu, dialogs } = useBackupActions({
    backup,
    destinations,
    canManage,
    canRestore,
    canTestDestinations,
  });

  const isApp = backup.targetKind === "app";
  // The whole card opens the target's own Backups tab, where this schedule's
  // runs and restore points live. Null once the target is deleted.
  const href = targetHref(backup);
  // A destination is a bucket or a disk, and the icon has to say which.
  const onAServer =
    destinations.find((d) => d.id === backup.destinationId)?.kind === "server";
  const DestinationIcon = onAServer ? Server : Cloud;

  return (
    <>
      <Card className="group relative flex flex-col gap-4 p-5 transition-colors hover:border-foreground/20">
        <AutoRefresh active={isRunning} />
        {href && <OverlayLink href={href} label={backup.name} />}
        {/* Above the stretched link, and inert so every pixel of the card falls
            through to it; the controls below opt back in. */}
        <div className="pointer-events-none relative z-[1] flex flex-1 flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{backup.name}</p>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <BackupTarget backup={backup} size={18} linked={false} />
                <span className="shrink-0 text-muted-foreground/40">·</span>
                <span className="shrink-0">{isApp ? "app" : "database"}</span>
              </div>
            </div>
            <div
              data-card-actions
              className="pointer-events-auto relative z-10 flex shrink-0 items-center gap-2"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <SimpleTooltip content={backup.enabled ? "Enabled" : "Disabled"}>
                <span>
                  <Switch
                    checked={backup.enabled}
                    onCheckedChange={toggle}
                    disabled={pending || !canManage}
                    aria-label={backup.enabled ? "Enabled" : "Disabled"}
                  />
                </span>
              </SimpleTooltip>
              {menu}
            </div>
          </div>

          {/* The last outcome is what anyone opens this page to check, so it gets
              the box - the cadence below it is the setting, not the news. */}
          <div className="space-y-1.5 rounded-lg border border-border bg-secondary/40 p-3 text-xs">
            {isRunning ? (
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Running now
              </p>
            ) : backup.lastStatus === "never" ? (
              <p className="text-muted-foreground">Never run</p>
            ) : (
              <p className="flex items-center gap-1.5">
                <StatusDot status={backup.lastStatus} />
                <span>
                  {OUTCOME[backup.lastStatus] ?? backup.lastStatus}
                  {backup.lastRunAt ? ` ${timeAgo(backup.lastRunAt)}` : ""}
                </span>
                {/* Only next to a success: the newest artifact's size beside
                  "Failed" would read as the size of the run that failed. */}
                {backup.lastStatus === "success" &&
                  backup.lastSizeBytes !== null && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="text-muted-foreground">
                        {formatBytes(backup.lastSizeBytes)}
                      </span>
                    </>
                  )}
              </p>
            )}
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <DestinationIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{backup.destinationName}</span>
              <span className="text-muted-foreground/40">·</span>
              <span className="shrink-0">
                {`keeps ${backup.retentionCount} ${backup.retentionCount === 1 ? "backup" : "backups"}`}
              </span>
            </p>
          </div>

          <div className="mt-auto text-xs text-muted-foreground">
            <ScheduleLabel cron={backup.schedule} timezone={backup.timezone} />
          </div>
        </div>
      </Card>
      {dialogs}
    </>
  );
}
