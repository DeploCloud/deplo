"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Folder,
  FolderOpen,
  FolderInput,
  MoreHorizontal,
  Palette,
  Pencil,
  Share2,
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
import { SimpleTooltip, MenuSubTooltip } from "@/components/ui/tooltip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { FolderColorPicker } from "@/components/apps/folder-color-picker";
import { ShareFolderDialog } from "@/components/apps/share-folder-dialog";
import { cn, readableTextColor } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";

export interface FolderCardData {
  id: string;
  name: string;
  appCount: number;
  /** Number of immediate child folders (nesting), for the count label. */
  subfolderCount?: number;
  /** Accent colour (`#rrggbb`), or null/undefined for the default tile. */
  color?: string | null;
  /** The CURRENT caller's effective capabilities on this folder. Drives per-folder
   *  action gating: rename/colour/move/delete show only when this includes
   *  `deploy` (the owner always has it). Absent ⇒ treated as no caps. */
  capabilities?: string[];
  /** True when the caller owns this folder or is a folder super-user — the only
   *  ones who may share it (open the Share dialog). */
  isOwner?: boolean;
  /** The folder's owner (creator), for reference; not needed for gating. */
  ownerUserId?: string | null;
  /** Parent folder id when nested, or null/absent at the top level. Gates the
   *  "Top level" move option (only offered when the folder is actually nested). */
  parentId?: string | null;
}

/** Build the Overview URL that opens a folder, preserving the list/grid view. */
export function folderHref(id: string, view: "grid" | "list"): string {
  const params = new URLSearchParams();
  params.set("folder", id);
  if (view === "list") params.set("view", "list");
  return `/?${params.toString()}`;
}

/** Menu-primitive set so the actions render once for both the ⋯ dropdown and the
 *  right-click context menu (see the note in app-card.tsx). */
type MenuKit = {
  Item: React.ElementType;
  Separator: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
};

const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

/**
 * A folder tile in the Overview grid. The whole card is a link that opens the
 * folder (a `?folder=<id>` view); the ⋯ menu and a right-click context menu
 * (open / rename / colour / move / delete / share) sit above that link.
 *
 * Per-folder gating is SELF-DERIVED from the folder's own data, not passed in:
 * rename/colour/move/delete show when the caller's effective folder caps include
 * `deploy` (the owner always has it), and Share shows when the caller owns the
 * folder or is a super-user. `isAdminOverride` short-circuits both so a
 * super-user (manage_team / instance admin) manages every folder regardless of
 * ownership. While a reorder drag is active the link is made inert, and
 * `dropActive` highlights the card as a drop target.
 */
export function FolderCard({
  folder,
  view = "grid",
  isAdminOverride = false,
  dragHandle,
  dragActive = false,
  dropActive = false,
  folders,
}: {
  folder: FolderCardData;
  view?: "grid" | "list";
  /** A super-user (manage_team / instance admin) may manage AND share every
   *  folder, even ones they don't own — bypasses the per-folder cap checks. */
  isAdminOverride?: boolean;
  dragHandle?: React.ReactNode;
  dragActive?: boolean;
  dropActive?: boolean;
  /** Every team folder (id + name) for the "Move to folder" menu (nesting).
   *  This folder itself is excluded; the server also rejects descendant moves. */
  folders?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [colorOpen, setColorOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [name, setName] = React.useState(folder.name);

  // Per-folder gating, derived from the folder's own data (see the doc comment).
  // A super-user override wins outright; otherwise `deploy` gates the mutating
  // actions and ownership gates sharing.
  const caps = folder.capabilities ?? [];
  const canManageThisFolder = isAdminOverride || caps.includes("deploy");
  const canShare = isAdminOverride || (folder.isOwner ?? false);
  // Draft colour while the colour dialog is open; seeded from the folder and
  // reset on open so cancelling discards an unsaved choice.
  const [draftColor, setDraftColor] = React.useState<string | null>(
    folder.color ?? null,
  );

  const href = folderHref(folder.id, view);
  const count = folder.appCount;
  const subCount = folder.subfolderCount ?? 0;
  // "3 apps · 2 folders" — the subfolder part only shows when nested.
  const countLabel =
    `${count} ${count === 1 ? "app" : "apps"}` +
    (subCount > 0 ? ` · ${subCount} ${subCount === 1 ? "folder" : "folders"}` : "");

  // The folder's icon tile: its chosen colour with an auto-contrast icon, or the
  // default neutral tile when no colour is set. One definition drives both
  // layouts so the list and grid cards always match.
  const tileColored = Boolean(folder.color);
  const tileStyle = folder.color
    ? {
        backgroundColor: folder.color,
        color: readableTextColor(folder.color),
      }
    : undefined;
  const tileClass = tileColored ? "" : "bg-secondary text-muted-foreground";

  // A coloured folder tints its whole card: a soft ~10% wash of the colour with a
  // slightly stronger edge, so it reads as that colour at a glance while keeping
  // the text legible. `dropActive`'s primary ring still draws on top. Hex alpha
  // suffixes: `1a` ≈ 10%, `40` ≈ 25%.
  const cardStyle = folder.color
    ? { backgroundColor: `${folder.color}1a`, borderColor: `${folder.color}40` }
    : undefined;

  function changeColor() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: ID!, $color: String) { setFolderColor(id: $id, color: $color) }`,
        { id: folder.id, color: draftColor },
      );
      if (res.ok) {
        toast.success("Folder colour updated");
        setColorOpen(false);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // Move (re-parent) this folder under another folder, or to the top level.
  // The server rejects moving a folder into itself or a descendant.
  function moveTo(parentId: string | null) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: ID!, $parentId: ID) { moveFolder(id: $id, parentId: $parentId) }`,
        { id: folder.id, parentId },
      );
      if (res.ok) {
        toast.success(parentId ? "Folder moved" : "Moved to top level");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function rename() {
    const next = name.trim();
    if (!next || next === folder.name) {
      setRenameOpen(false);
      return;
    }
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: ID!, $name: String!) { renameFolder(id: $id, name: $name) }`,
        { id: folder.id, name: next },
      );
      if (res.ok) {
        toast.success("Folder renamed");
        setRenameOpen(false);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // Folder actions, rendered once for whichever menu primitive is passed. Each
  // item has a native `title` so hovering it explains what it does. Open is
  // available to everyone; rename/colour/move/delete only when the viewer may
  // manage THIS folder; Share only when they may administer its access.
  const menu = (K: MenuKit) => (
    <>
      <SimpleTooltip content="Open this folder" side="left">
        <K.Item asChild>
          <Link href={href} className="cursor-pointer">
            <FolderOpen className="size-4" />
            Open
          </Link>
        </K.Item>
      </SimpleTooltip>
      {canManageThisFolder && (
        <>
          <SimpleTooltip content="Rename this folder" side="left">
            <K.Item
              onSelect={(e: Event) => {
                e.preventDefault();
                setName(folder.name);
                setRenameOpen(true);
              }}
            >
              <Pencil className="size-4" />
              Rename
            </K.Item>
          </SimpleTooltip>
          <SimpleTooltip content="Change this folder's colour" side="left">
            <K.Item
              onSelect={(e: Event) => {
                e.preventDefault();
                setDraftColor(folder.color ?? null);
                setColorOpen(true);
              }}
            >
              <Palette className="size-4" />
              Change colour
            </K.Item>
          </SimpleTooltip>
          {/* "Move to folder" only makes sense when there's somewhere to go:
              a parent to climb out of, or another folder to nest into. */}
          {folders &&
            (folder.parentId != null ||
              folders.some((f) => f.id !== folder.id)) && (
              <MenuSubTooltip
                Sub={K.Sub}
                SubTrigger={K.SubTrigger}
                SubContent={K.SubContent}
                content="Nest this folder inside another folder, or move it back to the top level"
                subContentClassName="max-h-72 overflow-y-auto"
                trigger={
                  <>
                    <FolderInput className="size-4" />
                    Move to folder
                  </>
                }
              >
                {/* Only offer "Top level" when the folder is actually nested. */}
                {folder.parentId != null && (
                  <>
                    <SimpleTooltip content="Move to the top level" side="left">
                      <K.Item onSelect={() => moveTo(null)} disabled={pending}>
                        Top level
                      </K.Item>
                    </SimpleTooltip>
                    {folders.some((f) => f.id !== folder.id) && <K.Separator />}
                  </>
                )}
                {folders
                  .filter((f) => f.id !== folder.id)
                  .map((f) => (
                    <SimpleTooltip
                      key={f.id}
                      content={`Move into ${f.name}`}
                      side="left"
                    >
                      <K.Item
                        onSelect={() => moveTo(f.id)}
                        disabled={pending || f.id === folder.parentId}
                      >
                        {f.name}
                      </K.Item>
                    </SimpleTooltip>
                  ))}
              </MenuSubTooltip>
            )}
          <K.Separator />
          <SimpleTooltip
            content="Delete the folder — its apps move back to the top level"
            side="left"
          >
            <K.Item
              variant="destructive"
              onSelect={(e: Event) => {
                e.preventDefault();
                setDeleteOpen(true);
              }}
            >
              <Trash2 className="size-4" />
              Delete
            </K.Item>
          </SimpleTooltip>
        </>
      )}
      {/* Share is a separate grant from managing: an owner who has shared their
          folder can hand out access even to actions they can't perform. */}
      {canShare && (
        <>
          {canManageThisFolder && <K.Separator />}
          <SimpleTooltip content="Share this folder with other members" side="left">
            <K.Item
              onSelect={(e: Event) => {
                e.preventDefault();
                setShareOpen(true);
              }}
            >
              <Share2 className="size-4" />
              Share folder…
            </K.Item>
          </SimpleTooltip>
        </>
      )}
    </>
  );

  // ⋯ menu: shown when the viewer may manage OR share this folder (open is always
  // available, but a bare card with no actions would be an empty menu).
  const actions = canManageThisFolder || canShare ? (
    <div className="pointer-events-auto relative z-10 flex items-center gap-1">
      {dragHandle}
      <div
        data-card-actions
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Folder menu">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {menu(DROPDOWN_KIT)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  ) : null;

  const overlayLink = (
    <Link
      href={href}
      aria-label={`Open folder ${folder.name}`}
      tabIndex={dragActive ? -1 : undefined}
      aria-hidden={dragActive || undefined}
      className={cn(
        "absolute inset-0 z-0 rounded-xl",
        dragActive ? "pointer-events-none cursor-default" : "cursor-pointer",
      )}
    />
  );

  const dialogs = canManageThisFolder || canShare ? (
    <>
      {canManageThisFolder && (
        <>
      <Dialog
        open={renameOpen}
        onOpenChange={(o) => {
          setRenameOpen(o);
          if (!o) setName(folder.name);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`rename-folder-${folder.id}`}>Folder name</Label>
            <Input
              id={`rename-folder-${folder.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && rename()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameOpen(false)}
              disabled={pending}
            >
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
          if (!o) setDraftColor(folder.color ?? null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Folder colour</DialogTitle>
          </DialogHeader>
          <FolderColorPicker
            value={draftColor}
            onChange={setDraftColor}
            idPrefix={`folder-${folder.id}`}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setColorOpen(false)}
              disabled={pending}
            >
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
        title={`Delete ${folder.name}?`}
        description="The folder is removed, but its apps are kept — they move back to the top level. This cannot be undone."
        confirmLabel="Delete folder"
        successMessage="Folder deleted"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($id: ID!) { deleteFolder(id: $id) }`,
            { id: folder.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
        </>
      )}
      {canShare && (
        <ShareFolderDialog
          folderId={folder.id}
          folderName={folder.name}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}
    </>
  ) : null;

  const cardInner =
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
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md",
              tileClass,
            )}
            style={tileStyle}
          >
            <Folder className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="truncate font-medium">{folder.name}</span>
            <p className="text-xs text-muted-foreground">{countLabel}</p>
          </div>
        </div>
        {actions}
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
            <div
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-md",
                tileClass,
              )}
              style={tileStyle}
            >
              <Folder className="size-4.5" />
            </div>
            <div className="min-w-0">
              <span className="truncate font-medium">{folder.name}</span>
              <p className="text-xs text-muted-foreground">{countLabel}</p>
            </div>
          </div>
          {actions}
        </div>
      </Card>
    );

  return (
    <>
      {cardInner}
      {dialogs}
    </>
  );
}
