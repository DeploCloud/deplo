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
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { gqlAction } from "@/lib/graphql-client";
import { ALL_ENV_TARGETS } from "@/lib/types";
import type { EnvTarget, GlobalEnvScope, GlobalEnvVarDTO } from "@/lib/types";

// Sentinel for an unchanged secret on edit: kept verbatim by the upsert (which
// then preserves the stored value), matching lib/data/global-env.ts's MASK. Lets
// an operator edit ONLY a secret's targets without re-entering its value.
const MASK = "••••••••••••";

// GraphQL mutation field names per scope. The `team` scope is GONE — team-global
// vars became team-wide SHARED vars (ADR-0010) and their mutations were deleted
// from the schema; leaving a dead `team` branch here would 500 at runtime.
const MUTATIONS: Record<
  GlobalEnvScope,
  { upsert: string; del: string; input: string }
> = {
  instance: {
    upsert: "upsertInstanceEnv",
    del: "deleteInstanceEnv",
    input: "UpsertGlobalEnvInput",
  },
};

/**
 * Manage INSTANCE-wide global variables (every app of every team, admin-only). A
 * flat key/value/targets table with add/edit/delete — no per-app attachment,
 * because a global applies to every app automatically.
 */
export function GlobalEnvManager({
  scope,
  vars,
}: {
  scope: GlobalEnvScope;
  vars: GlobalEnvVarDTO[];
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<GlobalEnvVarDTO | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const m = MUTATIONS[scope];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">All-teams variables</h3>
          <p className="text-sm text-muted-foreground">
            Injected into every app of every team. Any shared or app variable with
            the same key overrides it.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setAddOpen(true);
          }}
        >
          <Plus className="size-4" />
          Add
        </Button>
      </div>

      {vars.length === 0 ? (
        <EmptyState
          icon={Plus}
          title="No variables yet"
          description="Add a variable to inject it into every app of every team."
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
                    <EnvValueCell value={v.value} masked={v.masked} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {v.targets.map((target) => (
                        <Badge
                          key={target}
                          variant="muted"
                          className="text-[10px] capitalize"
                        >
                          {target}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          setEditing(v);
                          setAddOpen(true);
                        }}
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

      <GlobalEnvDialog
        key={editing?.id ?? "new"}
        open={addOpen}
        onOpenChange={setAddOpen}
        editing={editing}
        upsertField={m.upsert}
        inputType={m.input}
      />
      <ConfirmAction
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
        title="Delete variable?"
        description="This removes the variable. It will no longer be injected into deployments."
        confirmLabel="Delete"
        successMessage="Variable deleted"
        onConfirm={async () => {
          const res = await gqlAction<Record<string, boolean>>(
            `mutation($id: String!) { ${m.del}(id: $id) }`,
            { id: deleteId! },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}

function GlobalEnvDialog({
  open,
  onOpenChange,
  editing,
  upsertField,
  inputType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: GlobalEnvVarDTO | null;
  upsertField: string;
  inputType: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [key, setKey] = React.useState(editing?.key ?? "");
  // A secret's value is never sent to the client; prefill the MASK sentinel when
  // editing a secret so the operator can change ONLY its targets (the upsert
  // keeps the stored value when it sees the unchanged MASK) — or overwrite it by
  // typing. Plain vars prefill their real value.
  const [value, setValue] = React.useState(
    editing ? (editing.masked ? MASK : editing.value) : "",
  );
  const [secret, setSecret] = React.useState(editing?.type === "secret");
  const [targets, setTargets] = React.useState<EnvTarget[]>(
    editing?.targets ?? [...ALL_ENV_TARGETS],
  );

  function toggleTarget(t: EnvTarget, on: boolean) {
    setTargets((prev) =>
      on ? [...new Set([...prev, t])] : prev.filter((x) => x !== t),
    );
  }

  function submit() {
    startTransition(async () => {
      const res = await gqlAction<Record<string, { id: string }>>(
        `mutation($input: ${inputType}!) { ${upsertField}(input: $input) { id } }`,
        {
          input: {
            key,
            value,
            targets,
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
          <DialogTitle>{editing ? "Edit variable" : "Add variable"}</DialogTitle>
          <DialogDescription>
            Applies to every targeted environment of the apps in this scope.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <FieldLabel
              htmlFor="ge-key"
              info={
                <>
                  The environment variable name injected into deployments, e.g.{" "}
                  <code className="font-mono">API_BASE_URL</code>. It can&apos;t
                  be renamed after the variable is created.
                </>
              }
            >
              Key
            </FieldLabel>
            <Input
              id="ge-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="API_BASE_URL"
              className="font-mono text-sm"
              disabled={!!editing}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel
              htmlFor="ge-value"
              info={
                editing?.masked
                  ? "Leave the mask to keep the current secret; type to replace it."
                  : undefined
              }
            >
              Value
            </FieldLabel>
            <Input
              id="ge-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="ge-secret">Secret</Label>
              <p className="text-xs text-muted-foreground">
                Encrypted at rest and never shown again.
              </p>
            </div>
            <Switch id="ge-secret" checked={secret} onCheckedChange={setSecret} />
          </div>
          <div className="space-y-2">
            <FieldLabel
              info={
                <>
                  Which deployment environments this variable is injected into —{" "}
                  <code className="font-mono">production</code>,{" "}
                  <code className="font-mono">preview</code> and{" "}
                  <code className="font-mono">development</code>. Deselect one to
                  withhold the variable there.
                </>
              }
            >
              Environments
            </FieldLabel>
            <div className="flex flex-wrap gap-3">
              {ALL_ENV_TARGETS.map((t) => (
                <label
                  key={t}
                  className="flex cursor-pointer items-center gap-2 text-sm capitalize"
                >
                  <Checkbox
                    checked={targets.includes(t)}
                    onCheckedChange={(c) => toggleTarget(t, c === true)}
                  />
                  {t}
                </label>
              ))}
            </div>
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
          <Button
            onClick={submit}
            disabled={pending || !key.trim() || !value || targets.length === 0}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
