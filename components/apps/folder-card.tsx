"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
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
import { useBulkAppActions } from "@/components/apps/bulk-app-actions";
import { DeleteAppsOption } from "@/components/apps/delete-apps-option";
import { cn, readableTextColor } from "@/lib/utils";
import { useOptimisticValue } from "@/components/shared/use-optimistic-value";
import { gqlAction } from "@/lib/graphql-client";
import { folderHref } from "@/lib/overview-links";

export interface FolderCardData {
  id: string;
  name: string;
  appCount: number;
  subfolderCount?: number;
  color?: string | null;
  capabilities?: string[];
  isOwner?: boolean;
  ownerUserId?: string | null;
  parentId?: string | null;
}

export { folderHref };

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

export function FolderCard({
  folder,
  view = "grid",
  isAdminOverride = false,
  dragHandle,
  dragActive = false,
  dropActive = false,
  folders,
  onDeleted,
  onRestored,
}: {
  folder: FolderCardData;
  view?: "grid" | "list";
  isAdminOverride?: boolean;
  dragHandle?: React.ReactNode;
  dragActive?: boolean;
  dropActive?: boolean;
  folders?: { id: string; name: string }[];
  onDeleted?: () => void;
  onRestored?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteApps, setDeleteApps] = React.useState(false);
  const [colorOpen, setColorOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [name, setName] = React.useState(folder.name);
  const [shownName, applyName] = useOptimisticValue(folder.name);
  const [shownColor, applyColor] = useOptimisticValue<string | null>(
    folder.color ?? null,
  );

  const caps = folder.capabilities ?? [];
  const canManageThisFolder = isAdminOverride || caps.includes("deploy");
  const canShare = isAdminOverride || (folder.isOwner ?? false);
  const canDeleteApps = isAdminOverride || caps.includes("delete_apps");
  const [draftColor, setDraftColor] = React.useState<string | null>(
    folder.color ?? null,
  );

  const href = folderHref(folder.id, view);
  const count = folder.appCount;
  const subCount = folder.subfolderCount ?? 0;
  const countLabel =
    `${count} ${count === 1 ? "app" : "apps"}` +
    (subCount > 0
      ? ` · ${subCount} ${subCount === 1 ? "folder" : "folders"}`
      : "");

  const bulk = useBulkAppActions({
    scope: { folderId: folder.id },
    name: folder.name,
    appCount: count,
    canControl: caps.includes("control_apps"),
    canDeploy: caps.includes("deploy_apps"),
  });

  const tileColored = Boolean(shownColor);
  const tileStyle = shownColor
    ? {
        backgroundColor: shownColor,
        color: readableTextColor(shownColor),
      }
    : undefined;
  const tileClass = tileColored ? "" : "bg-secondary text-muted-foreground";

  const cardStyle = shownColor
    ? {
        backgroundColor: `color-mix(in srgb, ${shownColor} 10%, var(--background))`,
        borderColor: `color-mix(in srgb, ${shownColor} 25%, var(--background))`,
      }
    : undefined;

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
          `mutation($id: ID!, $color: String) { setFolderColor(id: $id, color: $color) }`,
          { id: folder.id, color: picked },
        ),
      { success: "Folder colour updated" },
    );
  }

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

  function onRenameSubmit(e: React.FormEvent) {
    e.preventDefault();
    rename();
  }

  function rename() {
    const next = name.trim();
    if (!next || next === folder.name) {
      setRenameOpen(false);
      return;
    }
    setRenameOpen(false);
    applyName(
      next,
      () =>
        gqlAction(
          `mutation($id: ID!, $name: String!) { renameFolder(id: $id, name: $name) }`,
          { id: folder.id, name: next },
        ),
      { success: "Folder renamed" },
    );
  }

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
      {bulk.items(K)}
      {canManageThisFolder && (
        <>
          <SimpleTooltip content="Rename this folder" side="left">
            <K.Item
              onSelect={() => {
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
              onSelect={() => {
                setDraftColor(folder.color ?? null);
                setColorOpen(true);
              }}
            >
              <Palette className="size-4" />
              Change colour
            </K.Item>
          </SimpleTooltip>
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
            content="Delete the folder - its apps move back to the top level"
            side="left"
          >
            <K.Item variant="destructive" onSelect={() => setDeleteOpen(true)}>
              <Trash2 className="size-4" />
              Delete
            </K.Item>
          </SimpleTooltip>
        </>
      )}
      {canShare && (
        <>
          {canManageThisFolder && <K.Separator />}
          <SimpleTooltip
            content="Share this folder with other members"
            side="left"
          >
            <K.Item onSelect={() => setShareOpen(true)}>
              <Share2 className="size-4" />
              Share folder…
            </K.Item>
          </SimpleTooltip>
        </>
      )}
    </>
  );

  const actions =
    canManageThisFolder || canShare || bulk.available ? (
      <div className="pointer-events-auto relative z-10 flex items-center gap-1 self-center">
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
      aria-label={`Open folder ${shownName}`}
      tabIndex={dragActive ? -1 : undefined}
      aria-hidden={dragActive || undefined}
      className={cn(
        "absolute inset-0 z-0 rounded-xl",
        dragActive ? "pointer-events-none cursor-default" : "cursor-pointer",
      )}
    />
  );

  const dialogs =
    canManageThisFolder || canShare ? (
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
                <form className="grid gap-4" onSubmit={onRenameSubmit}>
                  <div className="space-y-2">
                    <Label htmlFor={`rename-folder-${folder.id}`}>
                      Folder name
                    </Label>
                    <Input
                      id={`rename-folder-${folder.id}`}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setRenameOpen(false)}
                    >
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
                if (!o) setDraftColor(folder.color ?? null);
              }}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Folder colour</DialogTitle>
                </DialogHeader>
                <form className="grid gap-4" onSubmit={onColorSubmit}>
                  <FolderColorPicker
                    value={draftColor}
                    onChange={setDraftColor}
                    idPrefix={`folder-${folder.id}`}
                  />
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setColorOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button type="submit">Save</Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>

            <ConfirmAction
              open={deleteOpen}
              onOpenChange={(o) => {
                setDeleteOpen(o);
                if (!o) setDeleteApps(false);
              }}
              title="Delete folder?"
              description={
                deleteApps ? (
                  <>
                    <strong>{folder.name}</strong> and every app in it are
                    deleted.
                  </>
                ) : (
                  <>
                    <strong>{folder.name}</strong> is removed, but its apps are
                    kept - they move back to the top level.
                  </>
                )
              }
              consequence={
                deleteApps
                  ? "Their containers and volumes go with them. This cannot be undone."
                  : undefined
              }
              confirmLabel="Delete folder"
              successMessage="Folder deleted"
              optimistic
              extra={
                count > 0 && canDeleteApps ? (
                  <DeleteAppsOption
                    checked={deleteApps}
                    onChange={setDeleteApps}
                    count={count}
                  />
                ) : undefined
              }
              onConfirm={async () => {
                onDeleted?.();
                const res = await gqlAction(
                  `mutation($id: ID!, $deleteApps: Boolean) { deleteFolder(id: $id, deleteApps: $deleteApps) }`,
                  { id: folder.id, deleteApps },
                );
                if (!res.ok) onRestored?.();
                router.refresh();
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
            <span className="block truncate font-medium">{shownName}</span>
            <p className="mt-1 text-xs text-muted-foreground">{countLabel}</p>
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
              <span className="block truncate font-medium">{shownName}</span>
              <p className="mt-1 text-xs text-muted-foreground">{countLabel}</p>
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
      {bulk.dialog}
    </>
  );
}
