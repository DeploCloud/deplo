"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Boxes, MoreHorizontal, Palette, Pencil, Trash2 } from "lucide-react";
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
import { FolderColorPicker } from "@/components/services/folder-color-picker";
import { cn, readableTextColor } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";

export interface ProjectCardData {
  id: string;
  name: string;
  slug: string;
  color?: string | null;
  folderCount: number;
  serviceCount: number;
}

/**
 * A Project CONTAINER tile on the `/projects` index. The whole card links to the
 * container's detail page (`/projects/<slug>`); a ⋯ menu (rename / colour /
 * delete) sits above the link. Delete re-parents the container's folders and
 * services back to the top level — it never deletes them.
 */
export function ProjectContainerCard({
  project,
  canManage = true,
}: {
  project: ProjectCardData;
  /** Whether the caller may mutate this container (holds `deploy`). */
  canManage?: boolean;
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

  const href = `/projects/${project.slug}`;
  const f = project.folderCount;
  const s = project.serviceCount;
  const countLabel =
    `${s} ${s === 1 ? "service" : "services"} · ${f} ${f === 1 ? "folder" : "folders"}`;

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

  return (
    <Card
      style={cardStyle}
      className="group relative flex flex-col gap-4 p-5 transition-colors hover:border-foreground/20"
    >
      <Link
        href={href}
        aria-label={`Open project ${project.name}`}
        className="absolute inset-0 z-0 cursor-pointer rounded-xl"
      />
      <div className="pointer-events-none relative z-[1] flex flex-1 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md",
              project.color ? "" : "bg-secondary text-muted-foreground",
            )}
            style={tileStyle}
          >
            <Boxes className="size-4.5" />
          </div>
          <div className="min-w-0">
            <span className="block truncate font-medium">{project.name}</span>
            <p className="text-xs text-muted-foreground">{countLabel}</p>
          </div>
        </div>
        {canManage && (
          <div
            className="pointer-events-auto relative z-10"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Project menu">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    setName(project.name);
                    setRenameOpen(true);
                  }}
                >
                  <Pencil className="size-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    setDraftColor(project.color ?? null);
                    setColorOpen(true);
                  }}
                >
                  <Palette className="size-4" />
                  Change colour
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={(e) => {
                    e.preventDefault();
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

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
        description="The project is removed, but its folders and services are kept — they move back to the top level. This cannot be undone."
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
    </Card>
  );
}
