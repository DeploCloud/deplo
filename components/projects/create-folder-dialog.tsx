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
import { FolderColorPicker } from "@/components/projects/folder-color-picker";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Create a folder in the active team. Controlled (no trigger of its own) so it
 * can be opened from the Overview "Add new" menu. A folder is a team-wide,
 * single-level grouping — projects are moved into it afterward from the grid.
 */
export function CreateFolderDialog({
  open,
  onOpenChange,
  onCreated,
  description,
  parentId = null,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Called with the new folder's id after it's created (before the refresh) —
   *  e.g. to move a current selection of projects into it. */
  onCreated?: (folderId: string) => void | Promise<void>;
  /** Override the default body copy (e.g. the "with selected projects" variant). */
  description?: React.ReactNode;
  /** Create the folder nested under this parent (e.g. the folder currently open
   *  on the Overview). Null/absent ⇒ a top-level folder. */
  parentId?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<string | null>(null);

  function reset() {
    setName("");
    setColor(null);
  }

  function create() {
    if (!name.trim()) return;
    startTransition(async () => {
      const res = await gqlAction<
        { createFolder: { id: string } },
        { id: string }
      >(
        `mutation($name: String!, $color: String, $parentId: ID) { createFolder(name: $name, color: $color, parentId: $parentId) { id } }`,
        { name, color, parentId },
        (d) => d.createFolder,
      );
      if (res.ok) {
        if (onCreated && res.data) await onCreated(res.data.id);
        toast.success("Folder created");
        onOpenChange(false);
        reset();
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
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
              "Folders group projects on the Overview. Drag a project onto a folder — or use a card's menu — to move it in."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-folder-name">Folder name</Label>
            <Input
              id="new-folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              placeholder="Production, Clients, Internal…"
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
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={create} disabled={pending || !name.trim()}>
            {pending ? "Creating…" : "Create folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
