"use client";

import {
  Archive,
  CalendarClock,
  ChevronDown,
  Play,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuAction } from "./menu-action";

export function BackUpMenu({
  canManage,
  canRestore,
  noDestinations,
  onRunNow,
  onNewSchedule,
  onRestoreFromFile,
}: {
  canManage: boolean;
  canRestore: boolean;
  noDestinations: boolean;
  onRunNow: () => void;
  onNewSchedule: () => void;
  onRestoreFromFile: () => void;
}) {
  const blocked = !canManage
    ? null
    : noDestinations
      ? "Add a backup destination first"
      : null;
  const runBlocked = !canManage
    ? "You don't have permission to run backups"
    : blocked;
  const scheduleBlocked = !canManage
    ? "You don't have permission to schedule backups"
    : blocked;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">
          <Archive className="size-4" />
          Back up
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <MenuAction
          disabled={!!runBlocked}
          tooltip={runBlocked ?? "Run a one-off backup now"}
        >
          <DropdownMenuItem disabled={!!runBlocked} onSelect={onRunNow}>
            <Play className="size-4" />
            Back up now
          </DropdownMenuItem>
        </MenuAction>
        <MenuAction
          disabled={!!scheduleBlocked}
          tooltip={scheduleBlocked ?? "Schedule recurring backups"}
        >
          <DropdownMenuItem
            disabled={!!scheduleBlocked}
            onSelect={onNewSchedule}
          >
            <CalendarClock className="size-4" />
            New schedule
          </DropdownMenuItem>
        </MenuAction>
        <DropdownMenuSeparator />
        <MenuAction
          disabled={!canRestore}
          tooltip={
            canRestore
              ? "Restore from a backup file on your own machine"
              : "You don't have permission to restore backups"
          }
        >
          <DropdownMenuItem disabled={!canRestore} onSelect={onRestoreFromFile}>
            <Upload className="size-4" />
            Restore from file
            <Badge variant="info" className="ml-auto text-[10px] font-normal">
              Beta
            </Badge>
          </DropdownMenuItem>
        </MenuAction>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
