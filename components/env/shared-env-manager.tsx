"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Boxes, Share2 } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  saveSharedEnvGroupAction,
  deleteSharedEnvGroupAction,
  revealSharedEnvBlobAction,
} from "@/lib/actions/shared-env";
import type { SharedEnvGroupDTO } from "@/lib/data/shared-env";
import { ALL_ENV_TARGETS } from "@/lib/types";
import type { EnvTarget } from "@/lib/types";

interface ProjectLite {
  id: string;
  name: string;
  slug: string;
}

export function SharedEnvManager({
  groups,
  projects,
}: {
  groups: SharedEnvGroupDTO[];
  projects: ProjectLite[];
}) {
  const [editing, setEditing] = React.useState<SharedEnvGroupDTO | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);

  function openNew() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(g: SharedEnvGroupDTO) {
    setEditing(g);
    setDialogOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Define a set of variables once and attach it to many projects. Every
          attached project references the same value — edit it here to update
          them all.
        </p>
        <Button size="sm" onClick={openNew} className="shrink-0">
          <Plus className="size-4" />
          New shared group
        </Button>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={Share2}
          title="No shared variables yet"
          description="Create a shared group to reuse the same secrets across projects."
        />
      ) : (
        <div className="grid gap-3">
          {groups.map((g) => (
            <Card key={g.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      <Boxes className="size-4 text-muted-foreground" />
                      {g.name}
                    </p>
                    {g.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {g.description}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => openEdit(g)}
                      aria-label="Edit group"
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteId(g.id)}
                      aria-label="Delete group"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {g.variables.map((v) => (
                    <Badge key={v.key} variant="muted" className="font-mono text-[10px]">
                      {v.key}
                    </Badge>
                  ))}
                  {g.variables.length === 0 && (
                    <span className="text-xs text-muted-foreground">
                      No variables
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Targets:</span>
                  <div className="flex flex-wrap gap-1">
                    {g.targets.map((t) => (
                      <Badge key={t} variant="muted" className="text-[10px] capitalize">
                        {t}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Attached to:</span>
                  {g.projects.length === 0 ? (
                    <span>no projects</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {g.projects.map((p) => (
                        <Badge key={p.id} variant="secondary" className="text-[10px]">
                          {p.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <SharedEnvDialog
        key={editing?.id ?? "new"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        projects={projects}
      />
      <ConfirmAction
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
        title="Delete shared group?"
        description="Projects attached to this group lose these variables on their next deploy."
        confirmLabel="Delete"
        successMessage="Shared group deleted"
        onConfirm={() => deleteSharedEnvGroupAction(deleteId!)}
      />
    </div>
  );
}

function SharedEnvDialog({
  open,
  onOpenChange,
  editing,
  projects,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: SharedEnvGroupDTO | null;
  projects: ProjectLite[];
}) {
  const [name, setName] = React.useState(editing?.name ?? "");
  const [description, setDescription] = React.useState(editing?.description ?? "");
  const [blob, setBlob] = React.useState("");
  const [projectIds, setProjectIds] = React.useState<string[]>(
    editing?.projectIds ?? [],
  );
  const [targets, setTargets] = React.useState<EnvTarget[]>(
    editing?.targets ?? ALL_ENV_TARGETS,
  );
  const [pending, startTransition] = React.useTransition();

  // When editing, fetch the decrypted .env so the user can amend it. setState
  // runs only inside the async callback, so it does not cascade renders.
  React.useEffect(() => {
    if (!open || !editing) return;
    let active = true;
    revealSharedEnvBlobAction(editing.id).then((res) => {
      if (active && res.ok && res.data) setBlob(res.data.blob);
    });
    return () => {
      active = false;
    };
  }, [open, editing]);

  function toggleProject(id: string) {
    setProjectIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  }

  function toggleTarget(t: EnvTarget) {
    setTargets((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
    );
  }

  function submit() {
    startTransition(async () => {
      const res = await saveSharedEnvGroupAction({
        id: editing?.id,
        name,
        description,
        blob,
        projectIds,
        targets,
      });
      if (res.ok) {
        toast.success(editing ? "Shared group updated" : "Shared group created");
        onOpenChange(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit shared group" : "New shared group"}
          </DialogTitle>
          <DialogDescription>
            Variables are written as a .env block and shared across the selected
            projects.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Shared secrets"
            />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div className="space-y-2">
            <Label>Variables (.env)</Label>
            <Textarea
              value={blob}
              onChange={(e) => setBlob(e.target.value)}
              placeholder={"SENTRY_DSN=...\nRESEND_API_KEY=..."}
              rows={7}
              spellCheck={false}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Keys matching secret patterns (key, token, secret…) are masked
              automatically.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Targets</Label>
            <div className="flex flex-wrap gap-4">
              {ALL_ENV_TARGETS.map((t) => (
                <label
                  key={t}
                  className="flex cursor-pointer items-center gap-2 text-sm capitalize"
                >
                  <Checkbox
                    checked={targets.includes(t)}
                    onCheckedChange={() => toggleTarget(t)}
                  />
                  {t}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              The runtimes these variables reach. Include{" "}
              <code className="font-mono">development</code> to inject them into
              attached projects&apos; dev containers.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Attach to projects</Label>
            {projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">No projects yet.</p>
            ) : (
              <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
                {projects.map((p) => (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/40"
                  >
                    <Checkbox
                      checked={projectIds.includes(p.id)}
                      onCheckedChange={() => toggleProject(p.id)}
                    />
                    <span className="truncate">{p.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !name.trim() || targets.length === 0}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
