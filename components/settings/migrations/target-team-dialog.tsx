"use client";

import * as React from "react";
import { Check, Plus } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TeamAvatar } from "@/components/shared/user-avatar";
import type { TargetTeam } from "./types";

/**
 * Where the migration lands. The import runs in the active team, so picking one
 * here switches it - said on the dialog rather than left to be discovered.
 */
export function TargetTeamDialog({
  open,
  onOpenChange,
  teams,
  activeId,
  canCreate,
  onSelect,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  teams: TargetTeam[];
  activeId: string;
  /** Whether to offer a new team as well as the ones that exist. */
  canCreate: boolean;
  onSelect: (teamId: string) => void;
  onCreate: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Select another team</DialogTitle>
          <DialogDescription>
            Everything you migrate lands there. Nothing you have picked so far
            is lost, and this also switches your active team.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-64 space-y-1 overflow-y-auto">
          {teams.map((t) => (
            <button
              type="button"
              key={t.id}
              // The team it already lands in is offered too: picking it is how a
              // re-check is asked for when one failed.
              onClick={() => {
                onOpenChange(false);
                onSelect(t.id);
              }}
              className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left hover:border-border hover:bg-accent"
            >
              <TeamAvatar name={t.name} avatarUrl={t.avatarUrl} size="lg" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {t.name}
              </span>
              {t.id === activeId && (
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Check className="size-3.5" />
                  Current
                </span>
              )}
            </button>
          ))}
        </div>

        {canCreate && (
          <div className="space-y-3 pt-1">
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">
                somewhere new?
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onCreate();
              }}
              className="group flex w-full cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-accent"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
                <Plus className="size-4" />
              </span>
              <span className="text-sm font-medium">Create a new team</span>
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
