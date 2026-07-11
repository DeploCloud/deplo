"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { FieldLabel } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { gqlAction } from "@/lib/graphql-client";
import type { EnvironmentEnvVarDTO } from "@/lib/types";

// Sentinel for an unchanged secret on edit — matches lib/data/environment-env.ts's
// MASK, which preserves the stored value when it comes back verbatim.
const MASK = "••••••••••••";

/** One environment of a project, with its shared vars (serializable DTO shape). */
export interface EnvironmentEnvGroupRow {
  environmentId: string;
  environmentName: string;
  kind: string;
  isDefault: boolean;
  vars: EnvironmentEnvVarDTO[];
}

/**
 * Manage ONE project's environment-scoped shared variables, organized as a
 * section per environment (ADR-0008). A variable added here reaches EVERY
 * service of the project when it deploys in that environment's context — no
 * per-service attachment and no targets picker: the environment IS the scope.
 */
export function EnvironmentEnvManager({
  groups,
  canManage,
}: {
  groups: EnvironmentEnvGroupRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = React.useState<{
    environmentId: string;
    environmentName: string;
    editing: EnvironmentEnvVarDTO | null;
  } | null>(null);
  const [deleteFor, setDeleteFor] = React.useState<EnvironmentEnvVarDTO | null>(
    null,
  );

  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.environmentId} className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium">{g.environmentName}</h4>
              {g.isDefault && (
                <Badge variant="secondary" className="text-[10px]">
                  Default
                </Badge>
              )}
              <Badge variant="muted" className="text-[10px] capitalize">
                {g.kind}
              </Badge>
            </div>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setDialog({
                    environmentId: g.environmentId,
                    environmentName: g.environmentName,
                    editing: null,
                  })
                }
              >
                <Plus className="size-4" />
                Add
              </Button>
            )}
          </div>

          {g.vars.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No shared variables in this environment.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Value</TableHead>
                    {canManage && (
                      <TableHead className="text-right">Actions</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.vars.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-mono text-xs font-medium">
                        {v.key}
                      </TableCell>
                      <TableCell>
                        <EnvValueCell value={v.value} masked={v.masked} />
                      </TableCell>
                      {canManage && (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() =>
                                setDialog({
                                  environmentId: g.environmentId,
                                  environmentName: g.environmentName,
                                  editing: v,
                                })
                              }
                              aria-label="Edit"
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => setDeleteFor(v)}
                              aria-label="Delete"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      ))}

      {dialog && (
        <EnvironmentEnvDialog
          key={dialog.editing?.id ?? `new-${dialog.environmentId}`}
          open
          onOpenChange={(o) => !o && setDialog(null)}
          environmentId={dialog.environmentId}
          environmentName={dialog.environmentName}
          editing={dialog.editing}
        />
      )}
      <ConfirmAction
        open={deleteFor !== null}
        onOpenChange={(v) => !v && setDeleteFor(null)}
        title={deleteFor ? `Delete ${deleteFor.key}?` : "Delete variable?"}
        description="This removes the variable from the environment. Services of this project will no longer receive it on deploy."
        confirmLabel="Delete"
        successMessage="Variable deleted"
        onConfirm={async () => {
          const res = await gqlAction<Record<string, boolean>>(
            `mutation($id: String!) { deleteEnvironmentEnv(id: $id) }`,
            { id: deleteFor!.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}

function EnvironmentEnvDialog({
  open,
  onOpenChange,
  environmentId,
  environmentName,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  environmentName: string;
  editing: EnvironmentEnvVarDTO | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [key, setKey] = React.useState(editing?.key ?? "");
  // A secret's value is never sent to the client; prefill the MASK sentinel when
  // editing a secret so the operator can flip ONLY its type — or overwrite it by
  // typing. Plain vars prefill their real value.
  const [value, setValue] = React.useState(
    editing ? (editing.masked ? MASK : editing.value) : "",
  );
  const [secret, setSecret] = React.useState(editing?.type === "secret");

  function submit() {
    startTransition(async () => {
      const res = await gqlAction<Record<string, { id: string }>>(
        `mutation($input: UpsertEnvironmentEnvInput!) { upsertEnvironmentEnv(input: $input) { id } }`,
        {
          input: {
            environmentId,
            key,
            value,
            type: secret ? "secret" : "plain",
          },
        },
      );
      if (!res.ok) return;
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit variable" : "Add variable"} — {environmentName}
          </DialogTitle>
          <DialogDescription>
            Shared by every service of this project when it runs in this
            environment. A service&apos;s own variable with the same key
            overrides it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <FieldLabel
              htmlFor="ee-key"
              info="The variable name your services read from the environment. It can't be renamed after the variable is created."
            >
              Key
            </FieldLabel>
            <Input
              id="ee-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="API_BASE_URL"
              className="font-mono text-sm"
              disabled={!!editing}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel
              htmlFor="ee-value"
              info={
                editing?.masked
                  ? "Leave the mask to keep the current secret; type to replace it."
                  : undefined
              }
            >
              Value
            </FieldLabel>
            <Input
              id="ee-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="ee-secret">Secret</Label>
              <p className="text-xs text-muted-foreground">
                Encrypted at rest and never shown again.
              </p>
            </div>
            <Switch id="ee-secret" checked={secret} onCheckedChange={setSecret} />
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
          <Button onClick={submit} disabled={pending || !key.trim() || !value}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
