"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SharedVarDTO } from "@/lib/data/shared-vars/team-view";
import type { TeamEnvironment } from "@/lib/data/environments";
import type { AppRef, ProjectRef, TeamRef } from "./types";
import { SharedVarWizardBody } from "./wizard-body";

/**
 * Create/edit shared variables, as a wizard: the same key/value table the app's
 * own variables are written in, then WHO gets them, then only the details of
 * what you picked.
 */
export function SharedVarDialog({
  open,
  onOpenChange,
  editing,
  apps,
  projects,
  environments,
  teams,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: SharedVarDTO | null;
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
  teams: TeamRef[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* selfManaged: the body owns its height and eases between steps instead
          of padding out to the tallest one. */}
      <DialogContent
        selfManaged
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>
            {editing ? "Edit shared variable" : "New shared variables"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Change who can use it - the key stays as it is."
              : "Write them once, then choose who can use them."}
          </DialogDescription>
        </DialogHeader>
        <SharedVarWizardBody
          editing={editing}
          apps={apps}
          projects={projects}
          environments={environments}
          teams={teams}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}
