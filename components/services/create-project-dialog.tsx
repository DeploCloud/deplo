"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FolderColorPicker } from "@/components/services/folder-color-picker";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Create a Project CONTAINER (ADR-0008) in the active team. Controlled (no
 * trigger of its own) so it can be opened from an "Add new" menu or the
 * `/projects` index header. Folders and services are moved into it afterward.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<string | null>(null);

  function create() {
    if (!name.trim()) return;
    startTransition(async () => {
      const res = await gqlAction<{ createProject: { slug: string } }>(
        `mutation($name: String!, $color: String) { createProject(name: $name, color: $color) { slug } }`,
        { name: name.trim(), color },
      );
      if (res.ok) {
        toast.success("Project created");
        onOpenChange(false);
        setName("");
        setColor(null);
        const created = res.data?.createProject.slug;
        if (created) router.push(`/projects/${created}`);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setName("");
          setColor(null);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project groups folders and services and owns their environments.
            You can move existing items into it afterward.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-project-name">Project name</Label>
            <Input
              id="new-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              placeholder="e.g. Acme Platform"
              autoFocus
            />
          </div>
          <FolderColorPicker value={color} onChange={setColor} idPrefix="new-project" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={create} disabled={pending || !name.trim()}>
            {pending ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A self-contained "New project" button that owns the {@link CreateProjectDialog}
 * open state, so a server component (the `/projects` index) can drop it into a
 * header without managing client state itself.
 */
export function NewProjectButton({ label = "New project" }: { label?: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        {label}
      </Button>
      <CreateProjectDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
