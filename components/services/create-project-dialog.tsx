"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
 * Overview's context menu. Folders and services are moved into it afterward;
 * creation lands on the container's Overview drill-in view (`/?project=<id>`).
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
      const res = await gqlAction<{ createProject: { id: string } }>(
        `mutation($name: String!, $color: String) { createProject(name: $name, color: $color) { id } }`,
        { name: name.trim(), color },
      );
      if (res.ok) {
        toast.success("Project created");
        onOpenChange(false);
        setName("");
        setColor(null);
        const created = res.data?.createProject.id;
        if (created) router.push(`/?project=${created}`);
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
            A project is an advanced folder: each of its environments holds its
            own services and its own shared variables. You can move services
            into it afterward.
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

