"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  Boxes,
  Plus,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

export interface EnvironmentOption {
  id: string;
  name: string;
  isDefault: boolean;
}

/**
 * The project drill-in's ENVIRONMENT dropdown (ADR-0009): each environment of a
 * project holds its own apps, so picking one here switches which apps
 * the Overview shows. The selection rides the URL (`/?project=<id>&env=<envId>`),
 * so it survives refreshes and is shareable.
 *
 * It is also the whole environment-management surface — there is no separate
 * panel any more (the project view mirrors a folder view: just its apps).
 * With `canManage`, each row carries a `⋯` submenu (rename / make default /
 * delete) and a "New environment" action closes out the menu.
 */
export function EnvironmentSwitcher({
  projectId,
  view,
  environments,
  selectedId,
  canManage = false,
}: {
  projectId: string;
  view: "grid" | "list";
  environments: EnvironmentOption[];
  selectedId: string;
  canManage?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [addOpen, setAddOpen] = React.useState(false);
  const [addName, setAddName] = React.useState("");
  const [renameFor, setRenameFor] = React.useState<EnvironmentOption | null>(
    null,
  );
  const [renameName, setRenameName] = React.useState("");
  const [deleteFor, setDeleteFor] = React.useState<EnvironmentOption | null>(
    null,
  );

  const selected = environments.find((e) => e.id === selectedId);

  function select(envId: string) {
    if (envId === selectedId) return;
    const params = new URLSearchParams();
    params.set("project", projectId);
    params.set("env", envId);
    if (view === "list") params.set("view", "list");
    router.replace(`/?${params.toString()}`);
  }

  function add() {
    if (!addName.trim()) return;
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($projectId: ID!, $name: String!) { createEnvironment(projectId: $projectId, name: $name) { id } }`,
        { projectId, name: addName.trim() },
      );
      if (res.ok) {
        toast.success("Environment added");
        setAddOpen(false);
        setAddName("");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function rename() {
    if (!renameFor || !renameName.trim()) return;
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: ID!, $name: String!) { renameEnvironment(id: $id, name: $name) }`,
        { id: renameFor.id, name: renameName.trim() },
      );
      if (res.ok) {
        toast.success("Environment renamed");
        setRenameFor(null);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function makeDefault(env: EnvironmentOption) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: ID!) { setDefaultEnvironment(id: $id) }`,
        { id: env.id },
      );
      if (res.ok) {
        toast.success(`${env.name} is now the default`);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-9 gap-2">
            <Boxes className="size-4 text-muted-foreground" />
            <span className="max-w-32 truncate">
              {selected?.name ?? "Environment"}
            </span>
            <ChevronDown className="size-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {environments.map((e) => {
            const isSelected = e.id === selectedId;
            return (
              <div key={e.id} className="flex items-center gap-0.5">
                <DropdownMenuItem
                  className="flex-1 cursor-pointer"
                  onSelect={() => select(e.id)}
                >
                  <Check
                    className={cn(
                      "size-4",
                      isSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="flex-1 truncate">{e.name}</span>
                  {e.isDefault && (
                    <span className="text-xs text-muted-foreground">
                      default
                    </span>
                  )}
                </DropdownMenuItem>
                {canManage && (
                  <DropdownMenuSub>
                    <DropdownMenuPrimitive.SubTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Manage ${e.name}`}
                        className="flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus:bg-accent data-[state=open]:bg-accent"
                      >
                        <MoreHorizontal className="size-4" />
                      </button>
                    </DropdownMenuPrimitive.SubTrigger>
                    <DropdownMenuSubContent className="w-44">
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onSelect={() => {
                          setRenameFor(e);
                          setRenameName(e.name);
                        }}
                      >
                        <Pencil className="size-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer"
                        disabled={e.isDefault || pending}
                        onSelect={() => makeDefault(e)}
                      >
                        <Star className="size-4" />
                        Make default
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        className="cursor-pointer"
                        disabled={e.isDefault}
                        onSelect={() => setDeleteFor(e)}
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
              </div>
            );
          })}
          {canManage && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => setAddOpen(true)}
              >
                <Plus className="size-4" />
                New environment
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) setAddName("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New environment</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="add-env-name">Environment name</Label>
            <Input
              id="add-env-name"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="e.g. Staging"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button onClick={add} disabled={pending || !addName.trim()}>
              {pending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameFor != null}
        onOpenChange={(o) => !o && setRenameFor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename environment</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-env-name">Environment name</Label>
            <Input
              id="rename-env-name"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && rename()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameFor(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button onClick={rename} disabled={pending || !renameName.trim()}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmAction
        open={deleteFor != null}
        onOpenChange={(o) => !o && setDeleteFor(null)}
        title={deleteFor ? `Delete ${deleteFor.name}?` : "Delete environment?"}
        description="This removes the environment. Its future isolated deploy target and variables go with it. This cannot be undone."
        confirmLabel="Delete environment"
        successMessage="Environment deleted"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($id: ID!) { deleteEnvironment(id: $id) }`,
            { id: deleteFor!.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </>
  );
}
