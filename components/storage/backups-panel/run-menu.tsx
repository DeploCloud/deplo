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
  href: string | null;
  running: boolean;
  ok: boolean;
  canRestore: boolean;
  canDelete?: boolean;
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
  function deleteReason() {
    if (!canDelete) return "You don't have permission to delete backups";
    if (running) return "This backup is still running";
    return "Delete this backup permanently";
  }
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
