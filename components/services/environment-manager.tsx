"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, MoreHorizontal, Pencil, Star, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";

export interface EnvironmentRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  gitBranch: string;
  isDefault: boolean;
}

/**
 * Manage a Project container's Environments (ADR-0008 Phase 3): add a custom one,
 * rename, pick the default, delete. The isolated per-environment deploy pipeline
 * (URLs / branches / containers) is wired in a later phase; this is the CRUD
 * surface over the environment records.
 */
export function EnvironmentManager({
  projectId,
  environments,
  canManage,
}: {
  projectId: string;
  environments: EnvironmentRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [addOpen, setAddOpen] = React.useState(false);
  const [addName, setAddName] = React.useState("");
  const [renameFor, setRenameFor] = React.useState<EnvironmentRow | null>(null);
  const [renameName, setRenameName] = React.useState("");
  const [deleteFor, setDeleteFor] = React.useState<EnvironmentRow | null>(null);

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

  function makeDefault(env: EnvironmentRow) {
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
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Environments</h2>
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            Add environment
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {environments.map((e) => (
          <Card key={e.id} className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{e.name}</span>
                {e.isDefault && (
                  <Badge variant="secondary" className="text-[10px]">
                    Default
                  </Badge>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {e.gitBranch ? `branch: ${e.gitBranch}` : `kind: ${e.kind}`}
              </p>
            </div>
            {canManage && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Environment menu">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                    onSelect={(ev) => {
                      ev.preventDefault();
                      setRenameFor(e);
                      setRenameName(e.name);
                    }}
                  >
                    <Pencil className="size-4" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={e.isDefault || pending}
                    onSelect={(ev) => {
                      ev.preventDefault();
                      makeDefault(e);
                    }}
                  >
                    <Star className="size-4" />
                    Make default
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={e.isDefault}
                    onSelect={(ev) => {
                      ev.preventDefault();
                      setDeleteFor(e);
                    }}
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </Card>
        ))}
      </div>

      <Dialog open={addOpen} onOpenChange={(o) => { setAddOpen(o); if (!o) setAddName(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add environment</DialogTitle>
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
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={add} disabled={pending || !addName.trim()}>
              {pending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameFor != null} onOpenChange={(o) => !o && setRenameFor(null)}>
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
            <Button variant="outline" onClick={() => setRenameFor(null)} disabled={pending}>
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
    </section>
  );
}
