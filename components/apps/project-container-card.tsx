"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Boxes,
  FolderOpen,
  MoreHorizontal,
  Palette,
  Pencil,
  Trash2,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { FolderColorPicker } from "@/components/apps/folder-color-picker";
import { useBulkAppActions } from "@/components/apps/bulk-app-actions";
import { DeleteAppsOption } from "@/components/apps/delete-apps-option";
import { cn, readableTextColor } from "@/lib/utils";
import { useOptimisticValue } from "@/components/shared/use-optimistic-value";
import { gqlAction } from "@/lib/graphql-client";
// Shared with the Overview SERVER component - must stay in a plain module (an
// RSC cannot call a function exported from a "use client" file).
import { projectHref } from "@/lib/overview-links";

export interface ProjectCardData {
  id: string;
  name: string;
  slug: string;
  color?: string | null;
  appCount: number;
  environmentCount: number;
  /** The CURRENT caller's effective capabilities on this project (grants
   *  included): gates the "All apps" actions. Absent means none. */
  capabilities?: string[];
  /** The migration still creating this project, or null. Pulsing and inert
   *  while it is set - the run decides what is inside it until it ends. */
  migrationRunId?: string | null;
}

/** Menu items for the ⋯ dropdown. */
type MenuKit = {
  Item: React.ElementType;
  Separator: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
};

/**
 * A Project tile on the Overview - an "advanced folder" (ADR-0009) whose
 * environments each hold their own apps.
 */
export function ProjectContainerCard({
  project,
  view = "grid",
  canManage = true,
  dragHandle,
  dragActive = false,
  dropActive = false,
  onDeleted,
  onRestored,
}: {
  project: ProjectCardData;
  view?: "grid" | "list";
  /** Whether the caller may mutate this container (holds `deploy`). */
  canManage?: boolean;
  dragHandle?: React.ReactNode;
  dragActive?: boolean;
  dropActive?: boolean;
  /** Deleting takes the card off the grid on the CLICK and puts it back if the
   *  mutation is refused. Owned by the grid, which holds the cards. */
  onDeleted?: () => void;
  onRestored?: () => void;
}) {
  const router = useRouter();
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [colorOpen, setColorOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  // "Delete all apps" on the delete dialog - off on every open (see below).
  const [deleteApps, setDeleteApps] = React.useState(false);
  const [name, setName] = React.useState(project.name);
  // What the card SHOWS: a rename or a recolour lands here on the click and the
  // server's own value takes over when the refresh brings it.
  const [shownName, applyName] = useOptimisticValue(project.name);
  const [shownColor, applyColor] = useOptimisticValue<string | null>(
    project.color ?? null,
  );
  const [draftColor, setDraftColor] = React.useState<string | null>(
    project.color ?? null,
  );

  const href = projectHref(project.id, view);
  const e = project.environmentCount;
  const s = project.appCount;

  // Start / stop / restart / redeploy every app in this project, across all of
  // its environments. Its own capabilities decide, not `canManage`: running the
  // apps and renaming the project are different permissions.
  const caps = project.capabilities ?? [];
  const bulk = useBulkAppActions({
    scope: { projectId: project.id },
    name: project.name,
    appCount: s,
    canControl: caps.includes("control_apps"),
    canDeploy: caps.includes("deploy_apps"),
  });
  // Deleting the apps too is `delete_apps` HERE - a different permission from
  // deleting the container, so a member who may tidy the grid isn't offered the
  // one click that destroys its contents.
  const canDeleteApps = caps.includes("delete_apps");
  const countLabel = `${s} ${s === 1 ? "app" : "apps"} · ${e} ${e === 1 ? "environment" : "environments"}`;

  const tileStyle = shownColor
    ? { backgroundColor: shownColor, color: readableTextColor(shownColor) }
    : undefined;
  const cardStyle = shownColor
    ? { backgroundColor: `${shownColor}1a`, borderColor: `${shownColor}40` }
    : undefined;

  function onRenameSubmit(e: React.FormEvent) {
    e.preventDefault();
    rename();
  }

  function rename() {
    const next = name.trim();
    if (!next || next === project.name) {
      setRenameOpen(false);
      return;
    }
    setRenameOpen(false);
    applyName(
      next,
      () =>
        gqlAction(
          `mutation($id: ID!, $name: String!) { renameProject(id: $id, name: $name) }`,
          { id: project.id, name: next },
        ),
      { success: "Project renamed" },
    );
  }

  function onColorSubmit(e: React.FormEvent) {
    e.preventDefault();
    changeColor();
  }

  function changeColor() {
    const picked = draftColor;
    setColorOpen(false);
    applyColor(
      picked,
      () =>
        gqlAction(
          `mutation($id: ID!, $color: String) { setProjectColor(id: $id, color: $color) }`,
          { id: project.id, color: picked },
        ),
      { success: "Project colour updated" },
    );
  }

  // Project actions for the ⋯ dropdown (open / rename / colour / delete).
  const menu = (K: MenuKit) => (
    <>
      <K.Item asChild>
        <Link href={href} className="cursor-pointer">
          <FolderOpen className="size-4" />
          Open
        </Link>
      </K.Item>
      {bulk.items(K)}
      {canManage && (
        <>
          <K.Item
            onSelect={() => {
              setName(project.name);
              setRenameOpen(true);
            }}
          >
            <Pencil className="size-4" />
            Rename
          </K.Item>
          <K.Item
            onSelect={() => {
              setDraftColor(project.color ?? null);
              setColorOpen(true);
            }}
          >
            <Palette className="size-4" />
            Change colour
          </K.Item>
          <K.Separator />
          <K.Item variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 className="size-4" />
            Delete
          </K.Item>
        </>
      )}
    </>
  );

  // The grip stays OUTSIDE the stop-propagation wrapper: its pointer events
  // must bubble to the sortable wrapper to start a drag; only the ⋯ trigger
  // needs the guard (the exact FolderCard structure).
  const actions = (
    <div className="pointer-events-auto relative z-10 flex items-center gap-1">
      {dragHandle}
      <DropdownMenu>
        <div
          data-card-actions
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Project menu">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent align="end" className="w-44">
          {menu({
            Item: DropdownMenuItem,
            Separator: DropdownMenuSeparator,
            Sub: DropdownMenuSub,
            SubTrigger: DropdownMenuSubTrigger,
            SubContent: DropdownMenuSubContent,
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const overlayLink = (
    <Link
      href={href}
      aria-label={`Open project ${shownName}`}
      tabIndex={dragActive ? -1 : undefined}
      aria-hidden={dragActive || undefined}
      className={cn(
        "absolute inset-0 z-0 rounded-xl",
        dragActive ? "pointer-events-none cursor-default" : "cursor-pointer",
      )}
    />
  );

  const tile = (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md",
        shownColor ? "" : "bg-secondary text-muted-foreground",
      )}
      style={tileStyle}
    >
      <Boxes className="size-4.5" />
    </div>
  );

  const dialogs = canManage ? (
    <>
      <Dialog
        open={renameOpen}
        onOpenChange={(o) => {
          setRenameOpen(o);
          if (!o) setName(project.name);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={onRenameSubmit}>
            <div className="space-y-2">
              <Label htmlFor={`rename-project-${project.id}`}>
                Project name
              </Label>
              <Input
                id={`rename-project-${project.id}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={colorOpen}
        onOpenChange={(o) => {
          setColorOpen(o);
          if (!o) setDraftColor(project.color ?? null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Project colour</DialogTitle>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={onColorSubmit}>
            <FolderColorPicker
              value={draftColor}
              onChange={setDraftColor}
              idPrefix={`project-${project.id}`}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setColorOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmAction
        open={deleteOpen}
        // The option is a per-delete decision, so it resets on close: reopening
        // the dialog must never arrive with the apps already ticked for deletion.
        onOpenChange={(o) => {
          setDeleteOpen(o);
          if (!o) setDeleteApps(false);
        }}
        title="Delete project?"
        description={
          deleteApps
            ? `${project.name} and every app in it are deleted, containers and volumes included. This cannot be undone.`
            : `${project.name} is removed, but its apps are kept - they move back to the Overview top level. This cannot be undone.`
        }
        confirmLabel="Delete project"
        successMessage="Project deleted"
        optimistic
        extra={
          s > 0 && canDeleteApps ? (
            <DeleteAppsOption
              checked={deleteApps}
              onChange={setDeleteApps}
              count={s}
            />
          ) : undefined
        }
        onConfirm={async () => {
          onDeleted?.();
          const res = await gqlAction(
            `mutation($id: ID!, $deleteApps: Boolean) { deleteProject(id: $id, deleteApps: $deleteApps) }`,
            { id: project.id, deleteApps },
          );
          if (!res.ok) onRestored?.();
          router.refresh();
          return res;
        }}
      />
    </>
  ) : null;

  const card =
    view === "list" ? (
      <Card
        style={cardStyle}
        className={cn(
          "group relative flex items-center gap-4 p-4 transition-colors hover:border-foreground/20",
          dropActive && "border-primary ring-2 ring-primary/40",
        )}
      >
        {overlayLink}
        <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-4">
          {tile}
          <div className="min-w-0 flex-1">
            <span className="truncate font-medium">{shownName}</span>
            <p className="mt-1 text-xs text-muted-foreground">{countLabel}</p>
          </div>
        </div>
        {actions}
        {dialogs}
      </Card>
    ) : (
      <Card
        style={cardStyle}
        className={cn(
          "group relative flex flex-col gap-4 p-5 transition-colors hover:border-foreground/20",
          dropActive && "border-primary ring-2 ring-primary/40",
        )}
      >
        {overlayLink}
        <div className="pointer-events-none relative z-[1] flex flex-1 items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {tile}
            <div className="min-w-0">
              <span className="block truncate font-medium">{shownName}</span>
              <p className="mt-1 text-xs text-muted-foreground">{countLabel}</p>
            </div>
          </div>
          {actions}
        </div>
        {dialogs}
      </Card>
    );

  // Still arriving: the run is still deciding what environments and apps this
  // project has. `inert`, not just pointer-events-none, which the ⋯ cluster opts
  // back out of with pointer-events-auto - the menu opened and Delete worked.
  if (project.migrationRunId)
    return (
      <div
        inert
        aria-busy
        title="This is still being brought over by a migration"
        className="pointer-events-none animate-pulse opacity-70 select-none"
      >
        {card}
      </div>
    );

  return (
    <>
      {card}
      {bulk.dialog}
    </>
  );
}
