"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, Upload, Eye, EyeOff, Trash2, Pencil } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/shared/copy-button";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  upsertEnvAction,
  deleteEnvAction,
  importEnvAction,
  revealEnvAction,
} from "@/lib/actions/env";
import type { EnvTarget, EnvVarDTO } from "@/lib/types";

const ALL_TARGETS: EnvTarget[] = ["production", "preview", "development"];

export function EnvManager({
  projectId,
  vars,
}: {
  projectId: string;
  vars: EnvVarDTO[];
}) {
  const [editing, setEditing] = React.useState<EnvVarDTO | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState<Record<string, string>>({});
  const [pending, startTransition] = React.useTransition();

  function reveal(v: EnvVarDTO) {
    if (revealed[v.id]) {
      setRevealed((r) => {
        const n = { ...r };
        delete n[v.id];
        return n;
      });
      return;
    }
    startTransition(async () => {
      const res = await revealEnvAction(v.id);
      if (res.ok && res.data) setRevealed((r) => ({ ...r, [v.id]: res.data!.value }));
      else if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Environment Variables</h3>
          <p className="text-sm text-muted-foreground">
            Secrets are encrypted at rest and injected into your deployments.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="size-4" />
            Import .env
          </Button>
          <Button size="sm" onClick={() => { setEditing(null); setAddOpen(true); }}>
            <Plus className="size-4" />
            Add
          </Button>
        </div>
      </div>

      {vars.length === 0 ? (
        <EmptyState
          icon={Plus}
          title="No environment variables"
          description="Add variables to configure your app per environment."
        />
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Environments</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vars.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-mono text-xs font-medium">
                    {v.key}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <code className="max-w-[220px] truncate font-mono text-xs text-muted-foreground">
                        {v.masked ? revealed[v.id] ?? v.value : v.value}
                      </code>
                      {v.masked && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-6 text-muted-foreground"
                          onClick={() => reveal(v)}
                          disabled={pending}
                          aria-label="Reveal value"
                        >
                          {revealed[v.id] ? (
                            <EyeOff className="size-3.5" />
                          ) : (
                            <Eye className="size-3.5" />
                          )}
                        </Button>
                      )}
                      {revealed[v.id] && <CopyButton value={revealed[v.id]} className="size-6" />}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {v.targets.map((t) => (
                        <Badge key={t} variant="muted" className="text-[10px] capitalize">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => { setEditing(v); setAddOpen(true); }}
                        aria-label="Edit"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleteId(v.id)}
                        aria-label="Delete"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <EnvDialog
        key={editing?.id ?? "new"}
        open={addOpen}
        onOpenChange={setAddOpen}
        projectId={projectId}
        editing={editing}
      />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        projectId={projectId}
      />
      <ConfirmAction
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
        title="Delete variable?"
        description="This removes the variable. It will no longer be available to new deployments."
        confirmLabel="Delete"
        successMessage="Variable deleted"
        onConfirm={() => deleteEnvAction(deleteId!)}
      />
    </div>
  );
}

function EnvDialog({
  open,
  onOpenChange,
  projectId,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  editing: EnvVarDTO | null;
}) {
  const [key, setKey] = React.useState(editing?.key ?? "");
  const [value, setValue] = React.useState("");
  const [secret, setSecret] = React.useState(editing?.type !== "plain");
  const [targets, setTargets] = React.useState<EnvTarget[]>(
    editing?.targets ?? ["production", "preview", "development"]
  );
  const [pending, startTransition] = React.useTransition();

  function toggleTarget(t: EnvTarget) {
    setTargets((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]
    );
  }

  function submit() {
    startTransition(async () => {
      const res = await upsertEnvAction({
        projectId,
        key,
        value,
        targets,
        type: secret ? "secret" : "plain",
      });
      if (res.ok) {
        toast.success(editing ? "Variable updated" : "Variable added");
        onOpenChange(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit variable" : "Add variable"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the value or environments for this variable."
              : "Add a new environment variable to this project."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Key</Label>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="API_KEY"
              className="font-mono text-sm"
              disabled={!!editing}
            />
          </div>
          <div className="space-y-2">
            <Label>Value</Label>
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={editing ? "Enter a new value" : "value"}
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label>Environments</Label>
            <div className="flex flex-wrap gap-4">
              {ALL_TARGETS.map((t) => (
                <label key={t} className="flex cursor-pointer items-center gap-2 text-sm capitalize">
                  <Checkbox
                    checked={targets.includes(t)}
                    onCheckedChange={() => toggleTarget(t)}
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">Secret</p>
              <p className="text-xs text-muted-foreground">
                Hide the value in the UI after saving.
              </p>
            </div>
            <Switch checked={secret} onCheckedChange={setSecret} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !key.trim()}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
}) {
  const [blob, setBlob] = React.useState("");
  const [targets, setTargets] = React.useState<EnvTarget[]>([
    "production",
    "preview",
    "development",
  ]);
  const [pending, startTransition] = React.useTransition();

  function toggleTarget(t: EnvTarget) {
    setTargets((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]
    );
  }

  function submit() {
    startTransition(async () => {
      const res = await importEnvAction({ projectId, blob, targets });
      if (res.ok && res.data) {
        toast.success(`Imported ${res.data.count} variable(s)`);
        onOpenChange(false);
        setBlob("");
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import .env</DialogTitle>
          <DialogDescription>
            Paste the contents of a .env file. Each line becomes a secret.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Textarea
            value={blob}
            onChange={(e) => setBlob(e.target.value)}
            placeholder={"DATABASE_URL=postgres://...\nAPI_KEY=sk_live_..."}
            rows={8}
          />
          <div className="space-y-2">
            <Label>Environments</Label>
            <div className="flex flex-wrap gap-4">
              {ALL_TARGETS.map((t) => (
                <label key={t} className="flex cursor-pointer items-center gap-2 text-sm capitalize">
                  <Checkbox
                    checked={targets.includes(t)}
                    onCheckedChange={() => toggleTarget(t)}
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !blob.trim()}>
            {pending ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
