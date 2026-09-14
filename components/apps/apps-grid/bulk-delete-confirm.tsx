"use client";

import { ConfirmAction } from "@/components/shared/confirm-action";
import { DeleteAppsOption } from "@/components/apps/delete-apps-option";
import type { ActionResult } from "@/lib/result";

/** "1 app is" / "3 apps are" - both forms spelled out by the caller. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// The copy names exactly what is selected: only apps are actually destroyed (a
// folder or a project is just removed), so one fixed sentence would mislead.
function describeDelete(
  appCount: number,
  folderCount: number,
  projectCount: number,
  deleteApps: boolean,
): string {
  const deleteParts: string[] = [];
  if (appCount)
    deleteParts.push(
      `${count(appCount, "app is", "apps are")} permanently deleted, including deployments, domains and env vars.`,
    );
  if (folderCount)
    deleteParts.push(
      deleteApps
        ? `${count(folderCount, "folder is", "folders are")} removed with every app inside.`
        : `${count(folderCount, "folder is", "folders are")} removed - the apps inside move back to the top level.`,
    );
  if (projectCount)
    deleteParts.push(
      deleteApps
        ? `${count(projectCount, "project is", "projects are")} removed with every app inside.`
        : `${count(projectCount, "project is", "projects are")} removed - the apps inside move back to the top level.`,
    );
  deleteParts.push("This can't be undone.");
  return deleteParts.join(" ");
}

// BulkDeleteConfirm is the confirm dialog for deleting a whole selection.
export function BulkDeleteConfirm({
  open,
  onOpenChange,
  selectionCount,
  appCount,
  folderCount,
  projectCount,
  deleteApps,
  onDeleteAppsChange,
  hasNestedApps,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectionCount: number;
  appCount: number;
  folderCount: number;
  projectCount: number;
  deleteApps: boolean;
  onDeleteAppsChange: (value: boolean) => void;
  /** A selected folder or project actually holds apps (both counts cover their
   *  whole subtree) - what "Delete all apps" would have to delete. */
  hasNestedApps: boolean;
  onConfirm: () => Promise<ActionResult<unknown>>;
}) {
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${selectionCount} item${selectionCount === 1 ? "" : "s"}?`}
      description={describeDelete(
        appCount,
        folderCount,
        projectCount,
        deleteApps,
      )}
      confirmLabel="Delete selection"
      successMessage="Selection deleted"
      optimistic
      extra={
        // Only when the selection holds a CONTAINER WITH APPS in it: for a
        // selection of apps alone the delete already destroys them, and a
        // checkbox offering it again would read like a second, different thing.
        hasNestedApps ? (
          <DeleteAppsOption
            checked={deleteApps}
            onChange={onDeleteAppsChange}
          />
        ) : undefined
      }
      onConfirm={onConfirm}
    />
  );
}
