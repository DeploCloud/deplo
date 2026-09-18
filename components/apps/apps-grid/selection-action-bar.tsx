"use client";

import {
  ChevronDown,
  FolderPlus,
  FolderInput,
  MousePointerSquareDashed,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FolderRef } from "./grid-contract";

export interface SelectionBulk {
  count: number;
  appCount: number;
  canDelete: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onDelete: () => void;
  onNewFolderWithSelection: () => void;
  moveTargets: FolderRef[];
  onMoveTo: (folderId: string | null) => void;
}

export function SelectionActionBar({
  selection,
  canCreateFolder,
  canMoveApps,
}: {
  selection: SelectionBulk;
  canCreateFolder: boolean;
  canMoveApps: boolean;
}) {
  if (selection.count === 0) return null;
  return (
    <div
      data-selection-bar=""
      className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-popover/95 py-1.5 pr-1.5 pl-4 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-popover/80">
        <span className="text-sm font-medium whitespace-nowrap">
          {selection.count} selected
        </span>
        <span className="mx-1.5 h-5 w-px bg-border" />
        {canCreateFolder && selection.appCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={selection.onNewFolderWithSelection}
          >
            <FolderPlus className="size-4" />
            New folder
          </Button>
        )}
        {canMoveApps && selection.appCount > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <FolderInput className="size-4" />
                Move to
                <ChevronDown className="size-3.5 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="center"
              className="max-h-72 w-52 overflow-y-auto"
            >
              <DropdownMenuItem onSelect={() => selection.onMoveTo(null)}>
                Ungrouped
              </DropdownMenuItem>
              {selection.moveTargets.length > 0 && <DropdownMenuSeparator />}
              {selection.moveTargets.map((f) => (
                <DropdownMenuItem
                  key={f.id}
                  onSelect={() => selection.onMoveTo(f.id)}
                >
                  {f.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {selection.canDelete && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={selection.onDelete}
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
        )}
        <span className="mx-1.5 h-5 w-px bg-border" />
        <Button variant="ghost" size="sm" onClick={selection.onSelectAll}>
          <MousePointerSquareDashed className="size-4" />
          Select all
        </Button>
        <Button
          variant="ghost"
          className="rounded-full!"
          size="icon-sm"
          aria-label="Clear selection"
          onClick={selection.onClear}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
