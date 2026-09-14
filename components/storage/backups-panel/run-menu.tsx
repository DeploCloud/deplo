"use client";

import {
  Download,
  MoreHorizontal,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuAction } from "./menu-action";

// RunMenu - everything you can do with one artifact, behind one menu.
export function RunMenu({
  href,
  running,
  ok,
  canRestore,
  canDelete = false,
  canManage = false,
  onRestore,
  onDelete,
  onCancel,
}: {
  /** The download URL, or null for a run that has no id yet (the placeholder). */
  href: string | null;
  running: boolean;
  ok: boolean;
  canRestore: boolean;
  canDelete?: boolean;
  /** `manage_backups` - whoever may start a dump may stop it. */
  canManage?: boolean;
  onRestore?: () => void;
  onDelete?: () => void;
  onCancel?: () => void;
}) {
  const canDownload = ok && canRestore && href !== null;
  function reason(verb: "download" | "restore") {
    if (!canRestore) return `You don't have permission to ${verb} backups`;
    if (running) return "This backup is still running";
    if (!ok)
      return verb === "download"
        ? "Only a successful backup can be downloaded"
        : "Only a successful backup can be restored";
    return verb === "restore"
      ? "Restore this backup in place"
      : "Download this backup file";
  }
  // Delete is the one action a FAILED run still has: its record is clutter and
  // clearing it is the only thing left to do with it.
  function deleteReason() {
    if (!canDelete) return "You don't have permission to delete backups";
    if (running) return "This backup is still running";
    return "Delete this backup permanently";
  }
  // Icon + label as DIRECT children of the item, never wrapped: one <span> around
  // them makes the pair a single flex item and the item's `gap-2` stops applying.
  const downloadLabel = (
    <>
      <Download className="size-4" />
      Download
    </>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Backup menu">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <MenuAction disabled={!canDownload} tooltip={reason("download")}>
          <DropdownMenuItem asChild={canDownload} disabled={!canDownload}>
            {canDownload ? (
              <a href={href} download>
                {downloadLabel}
              </a>
            ) : (
              downloadLabel
            )}
          </DropdownMenuItem>
        </MenuAction>
        <MenuAction disabled={!ok || !canRestore} tooltip={reason("restore")}>
          <DropdownMenuItem
            disabled={!ok || !canRestore}
            onSelect={() => onRestore?.()}
          >
            <RotateCcw className="size-4" />
            Restore
          </DropdownMenuItem>
        </MenuAction>
        {running && onCancel && (
          <MenuAction
            disabled={!canManage}
            tooltip={
              canManage
                ? "Stop this backup and discard what it has written"
                : "You don't have permission to stop backups"
            }
          >
            <DropdownMenuItem disabled={!canManage} onSelect={onCancel}>
              <Square className="size-4" />
              Stop
            </DropdownMenuItem>
          </MenuAction>
        )}
        <DropdownMenuSeparator />
        <MenuAction disabled={!canDelete || running} tooltip={deleteReason()}>
          <DropdownMenuItem
            variant="destructive"
            disabled={!canDelete || running}
            onSelect={() => onDelete?.()}
          >
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </MenuAction>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
