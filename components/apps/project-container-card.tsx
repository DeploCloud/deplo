"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Boxes, FolderOpen, MoreHorizontal, Palette, Pencil, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { cn, readableTextColor } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
// Shared with the Overview SERVER component — must stay in a plain module (an
// RSC cannot call a function exported from a "use client" file).
import { projectHref } from "@/lib/overview-links";

export interface ProjectCardData {
  id: string;
  name: string;
  slug: string;
  color?: string | null;
  appCount: number;
  environmentCount: number;
}

/** Menu items for the ⋯ dropdown. */
type MenuKit = {
  Item: React.ElementType;
  Separator: React.ElementType;
};

/**
 * A Project tile on the Overview — an "advanced folder" (ADR-0009) whose
 * environments each hold their own apps. The whole card links to the
 * drill-in view on the Overview itself (`/?project=<id>`, environment dropdown
 * inside); a ⋯ menu (open / rename / colour / delete) sits above the link.
 * Delete re-parents the project's apps back to the top
 * level — it never deletes them. While a reorder drag is active the link is
 * made inert, and `dropActive` highlights the card as a drop target.
 */
export function ProjectContainerCard({
  project,
  view = "grid",
  canManage = true,
  dragHandle,
  dragActive = false,
  dropActive = false,
}: {
  project: ProjectCardData;
  view?: "grid" | "list";
  /** Whether the caller may mutate this container (holds `deploy`). */
  canManage?: boolean;
  dragHandle?: React.ReactNode;
  dragActive?: boolean;
  dropActive?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [colorOpen, setColorOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [name, setName] = React.useState(project.name);
  const [draftColor, setDraftColor] = React.useState<string | null>(
    project.color ?? null,
  );

  const href = projectHref(project.id, view);
  const e = project.environmentCount;
  const s = project.appCount;
  const countLabel =
    `${s} ${s === 1 ? "app" : "apps"} · ${e} ${e === 1 ? "environment" : "environments"}`;

  const tileStyle = project.color
    ? { backgroundColor: project.color, color: readableTextColor(project.color) }
    : undefined;
  const cardStyle = project.color
    ? { backgroundColor: `${project.color}1a`, borderColor: `${project.color}40` }
    : undefined;

  function rename() {
    const next = name.trim();
    if (!next || next === project.name) {
      setRenameOpen(false);
      return;
    }
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: ID!, $name: String!) { renameProject(id: $id, name: $name) }`,
        { id: project.id, name: next },
      );
      if (res.ok) {
        toast.success("Project renamed");
        setRenameOpen(false);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function changeColor() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: ID!, $color: String) { setProjectColor(id: $id, color: $color) }`,
        { id: project.id, color: draftColor },
      );
      if (res.ok) {
        toast.success("Project colour updated");
        setColorOpen(false);
        router.refresh();
      } else toast.error(res.error);
    });
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
          <K.Item
            variant="destructive"
            onSelect={() => setDeleteOpen(true)}
          >
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
          {menu({ Item: DropdownMenuItem, Separator: DropdownMenuSeparator })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const overlayLink = (
    <Link
      href={href}
      aria-label={`Open project ${project.name}`}
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
        project.color ? "" : "bg-secondary text-muted-foreground",
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
          <div className="space-y-2">
            <Label htmlFor={`rename-project-${project.id}`}>Project name</Label>
            <Input
              id={`rename-project-${project.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && rename()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={rename} disabled={pending || !name.trim()}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
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
          <FolderColorPicker
            value={draftColor}
            onChange={setDraftColor}
            idPrefix={`project-${project.id}`}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setColorOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={changeColor} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmAction
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${project.name}?`}
        description="The project is removed, but its apps are kept — they move back to the Overview top level. This cannot be undone."
        confirmLabel="Delete project"
        successMessage="Project deleted"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($id: ID!) { deleteProject(id: $id) }`,
            { id: project.id },
          );
          if (res.ok) router.refresh();
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
            <span className="truncate font-medium">{project.name}</span>
            <p className="text-xs text-muted-foreground">{countLabel}</p>
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
              <span className="block truncate font-medium">{project.name}</span>
              <p className="text-xs text-muted-foreground">{countLabel}</p>
            </div>
          </div>
          {actions}
        </div>
        {dialogs}
      </Card>
    );

  return card;
}
