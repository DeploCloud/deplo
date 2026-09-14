"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
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
import { FolderColorPicker } from "@/components/apps/folder-color-picker";
import { gqlAction } from "@/lib/graphql-client";

// CreateFolderDialog - controlled dialog that creates a folder in the active team.
export function CreateFolderDialog({
  open,
  onOpenChange,
  onCreated,
  description,
  parentId = null,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated?: (folderId: string) => void | Promise<void>;
  description?: React.ReactNode;
  parentId?: string | null;
}) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<string | null>(null);

  function reset() {
    setName("");
    setColor(null);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    create();
  }

  function create() {
    if (!name.trim()) return;
    const typed = { name, color };
    onOpenChange(false);
    reset();
    void (async () => {
      const res = await gqlAction<
        { createFolder: { id: string } },
        { id: string }
      >(
        `mutation($name: String!, $color: String, $parentId: ID) { createFolder(name: $name, color: $color, parentId: $parentId) { id } }`,
        { name: typed.name, color: typed.color, parentId },
        (d) => d.createFolder,
      );
      if (res.ok) {
        if (onCreated && res.data) await onCreated(res.data.id);
        toast.success("Folder created");
      } else {
        setName(typed.name);
        setColor(typed.color);
        onOpenChange(true);
        toast.error(res.error);
      }
      router.refresh();
    })();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a folder</DialogTitle>
          <DialogDescription>
            {description ??
              "Folders group apps on the Overview. Drag an app onto a folder, or use a card's menu, to move it in."}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-folder-name">Folder name</Label>
              <Input
                id="new-folder-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Production, Clients, Internal"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label>Colour</Label>
              <FolderColorPicker
                value={color}
                onChange={setColor}
                idPrefix="new-folder"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Create folder
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
