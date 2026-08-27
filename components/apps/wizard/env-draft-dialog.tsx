"use client";

import * as React from "react";
import { KeyRound, Variable } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { DocsLink } from "@/components/ui/docs-link";
import {
  EnvRowsEditor,
  filledRows,
  invalidRows,
  type EnvRow,
} from "@/components/env/env-rows-editor";
import { SecretRow } from "@/components/env/secret-row";

/** A variable typed into the wizard: no row exists yet, so it carries its own
 *  type instead of reading one back. */
export interface DraftEnvRow {
  key: string;
  value: string;
  /** Undefined lets the key's own name decide, which is what the server does. */
  secret?: boolean;
}

/** The team's shared variables, as much of one as the picker shows. */
export interface LinkableSharedVar {
  id: string;
  key: string;
  type: "plain" | "secret";
  teamWide: boolean;
}

type Tab = "variables" | "shared";

/**
 * The variables modal with no app behind it: everything typed or ticked here is
 * held by the wizard and sent with `createApp`, so the FIRST deploy already has
 * it. Same two tabs the app's Environment tab shows.
 */
export function EnvDraftDialog({
  open,
  onOpenChange,
  rows,
  sharedIds,
  sharedVars,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: DraftEnvRow[];
  sharedIds: string[];
  sharedVars: LinkableSharedVar[];
  onSave: (rows: DraftEnvRow[], sharedIds: string[]) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Environment variables</DialogTitle>
          <DialogDescription>
            Available to the app from its first deploy.{" "}
            <DocsLink topic="env.overview" />
          </DialogDescription>
        </DialogHeader>
        {/* The body mounts with the dialog, so it starts from what the wizard
            holds and a cancelled edit leaves nothing behind. */}
        <EnvDraftBody
          rows={rows}
          sharedIds={sharedIds}
          sharedVars={sharedVars}
          onCancel={() => onOpenChange(false)}
          onSave={(next, ids) => {
            onSave(next, ids);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function EnvDraftBody({
  rows,
  sharedIds,
  sharedVars,
  onCancel,
  onSave,
}: {
  rows: DraftEnvRow[];
  sharedIds: string[];
  sharedVars: LinkableSharedVar[];
  onCancel: () => void;
  onSave: (rows: DraftEnvRow[], sharedIds: string[]) => void;
}) {
  const [tab, setTab] = React.useState<Tab>("variables");
  const [draft, setDraft] = React.useState<EnvRow[]>(
    rows.length ? rows : [{ key: "", value: "" }],
  );
  const [secret, setSecret] = React.useState(rows.some((r) => r.secret));
  const [picked, setPicked] = React.useState<string[]>(sharedIds);

  const invalid = invalidRows(draft).length > 0;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (invalid) return;
    // Batch-level, like the app's own Add dialog. Left off, the row carries no
    // type at all and the key's name decides - which is what a template wants.
    onSave(
      filledRows(draft).map((r) => ({
        key: r.key.trim(),
        value: r.value,
        secret: secret || undefined,
      })),
      picked,
    );
  }

  return (
    <>
      <form onSubmit={onSubmit} className="grid gap-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="grid h-auto w-full grid-cols-2 rounded-lg border border-border bg-secondary/40 p-1">
            <TabsTrigger value="variables">
              <Variable className="size-4" />
              Variables
            </TabsTrigger>
            <TabsTrigger value="shared">
              <KeyRound className="size-4" />
              Shared
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === "variables" ? (
          <div className="space-y-3">
            <EnvRowsEditor rows={draft} onChange={setDraft} />
            <SecretRow secret={secret} onChange={setSecret} />
          </div>
        ) : sharedVars.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            This team has no shared variables yet.
          </p>
        ) : (
          <div className="focus-safe-scroll max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
            {sharedVars.map((v) => (
              <label
                key={v.id}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40"
              >
                <Checkbox
                  checked={picked.includes(v.id)}
                  onCheckedChange={(on) =>
                    setPicked((ids) =>
                      on ? [...ids, v.id] : ids.filter((i) => i !== v.id),
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {v.key}
                </span>
                {v.type === "secret" && (
                  <Badge variant="outline" className="gap-1">
                    <KeyRound className="size-3" />
                    Secret
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {v.teamWide ? "Team-wide" : "Scoped"}
                </span>
              </label>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={invalid}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
