"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Pencil,
  Rows3,
  FileText,
  Share2,
  Eye,
  EyeOff,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { FieldLabel } from "@/components/ui/info-tip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { EnvVarDialog } from "@/components/env/env-var-dialog";
import { parseEnv, serializeEnv } from "@/components/env/env-parse";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import type { EnvTarget, EnvVarDTO } from "@/lib/types";
import type { AppSharedVarDTO } from "@/lib/data/shared-vars";

const ALL_TARGETS: EnvTarget[] = ["production", "preview", "development"];

/** How a shared var reaches this app, for the read-only badge. */
const VIA_LABEL: Record<string, string> = {
  teamWide: "Team-wide",
  environment: "Environment",
  project: "Project",
  link: "Linked",
};

export function EnvManager({
  appId,
  vars,
  sharedVars,
}: {
  appId: string;
  vars: EnvVarDTO[];
  sharedVars: AppSharedVarDTO[];
}) {
  const [editing, setEditing] = React.useState<EnvVarDTO | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  // "table" → the per-row UI; "editor" → a raw .env text editor over all vars.
  const [mode, setMode] = React.useState<"table" | "editor">("table");
  const router = useRouter();

  // Shared vars that currently inject into this app — shown read-only (values
  // are managed centrally on the Variables page and never reach the client).
  const appliedShared = sharedVars.filter((v) => v.applied);

  // Which plain rows are currently revealed. Secrets are never in this set —
  // they have no reveal path. "Reveal all" fills/clears it in one shot.
  const [revealedIds, setRevealedIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const revealableIds = vars.filter((v) => !v.masked).map((v) => v.id);
  const allRevealed =
    revealableIds.length > 0 && revealableIds.every((id) => revealedIds.has(id));

  function toggleReveal(id: string, next: boolean) {
    setRevealedIds((prev) => {
      const set = new Set(prev);
      if (next) set.add(id);
      else set.delete(id);
      return set;
    });
  }

  return (
    <div className="space-y-4">
      {/* Title on the left, the actions + Table/Editor switch on the right — one
          justify-between row (same layout as the deployments pages). */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-medium">Environment Variables</h3>
          <p className="text-sm text-muted-foreground">
            Secret values are encrypted at rest and never shown again.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mode === "table" && (
            <>
              {revealableIds.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setRevealedIds(
                      allRevealed ? new Set() : new Set(revealableIds),
                    )
                  }
                >
                  {allRevealed ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                  {allRevealed ? "Hide all" : "Reveal all"}
                </Button>
              )}
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
            </>
          )}
          {/* Sits last so it holds the far-right slot whether or not the
              table-mode actions are showing. */}
          <ViewToggle mode={mode} onChange={setMode} />
        </div>
      </div>

      {mode === "editor" ? (
        <EnvEditor appId={appId} vars={vars} onDone={() => setMode("table")} />
      ) : vars.length === 0 && appliedShared.length === 0 ? (
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
                    <EnvValueCell
                      value={v.value}
                      masked={v.masked}
                      revealed={revealedIds.has(v.id)}
                      onRevealedChange={(next) => toggleReveal(v.id, next)}
                    />
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
              {appliedShared.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-mono text-xs font-medium">
                    <div className="flex items-center gap-2">
                      {v.key}
                      <Badge
                        variant="muted"
                        className="gap-1 text-[10px] font-normal"
                      >
                        <Share2 className="size-3" />
                        Shared · {VIA_LABEL[v.via] ?? "Shared"}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    {/* Shared values are never exposed to the client. */}
                    <span className="text-xs text-muted-foreground">
                      managed centrally
                    </span>
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
                    <Button
                      variant="link"
                      size="sm"
                      asChild
                      className="h-auto p-0 text-xs text-muted-foreground"
                    >
                      <Link href="/variables?tab=shared">Manage</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <EnvVarDialog
        key={editing?.id ?? "new"}
        open={addOpen}
        onOpenChange={setAddOpen}
        appId={appId}
        editing={editing}
        sharedVars={sharedVars}
      />
      <ConfirmAction
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
        title="Delete variable?"
        description="This removes the variable. It will no longer be available to new deployments."
        confirmLabel="Delete"
        successMessage="Variable deleted"
        onConfirm={async () => {
          const res = await gqlAction<{ deleteEnv: boolean }>(
            `mutation($id: String!) { deleteEnv(id: $id) }`,
            { id: deleteId! },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}

/** Segmented Table / Editor switch for the manager's two views. */
function ViewToggle({
  mode,
  onChange,
}: {
  mode: "table" | "editor";
  onChange: (m: "table" | "editor") => void;
}) {
  const opt = (m: "table" | "editor", Icon: typeof Rows3, label: string) => (
    <SimpleTooltip content={`${label} view`}>
      <button
        type="button"
        onClick={() => onChange(m)}
        aria-pressed={mode === m}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
          mode === m
            ? "bg-background font-medium text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Icon className="size-3.5" />
        {label}
      </button>
    </SimpleTooltip>
  );
  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-secondary/40 p-0.5">
      {opt("table", Rows3, "Table")}
      {opt("editor", FileText, "Editor")}
    </div>
  );
}

/**
 * The ".env editor": one textarea over ALL of an app's variables. Plain
 * values are editable in place; secret values show as a mask and are preserved
 * unless changed (you can't read a secret you didn't set). Saving upserts every
 * line and deletes the ones removed — new vars are PLAIN and land in the chosen
 * default environments. Existing vars keep their own type + environments.
 */
function EnvEditor({
  appId,
  vars,
  onDone,
}: {
  appId: string;
  vars: EnvVarDTO[];
  onDone: () => void;
}) {
  const initial = React.useMemo(() => serializeEnv(vars), [vars]);
  const [text, setText] = React.useState(initial);
  const [targets, setTargets] = React.useState<EnvTarget[]>([...ALL_TARGETS]);
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  const hasSecrets = vars.some((v) => v.masked);
  const dirty = text !== initial;

  function toggleTarget(t: EnvTarget) {
    setTargets((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
    );
  }

  function save() {
    startTransition(async () => {
      const entries = parseEnv(text);
      const res = await gqlAction<{ setAppEnv: number }, number>(
        `mutation($appId: String!, $entries: [EnvEntryInput!]!, $defaultTargets: [EnvTarget!]!) {
          setAppEnv(appId: $appId, entries: $entries, defaultTargets: $defaultTargets)
        }`,
        { appId, entries, defaultTargets: targets },
        (d) => d.setAppEnv,
      );
      if (res.ok) {
        toast.success("Environment saved");
        router.refresh();
        onDone();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Edit every variable as a <code className="font-mono">.env</code> file.
        Deleting a line removes that variable.
        {hasSecrets &&
          " Secret values are hidden — leave a secret's masked value unchanged to keep it."}
      </p>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={16}
        spellCheck={false}
        placeholder={"DATABASE_URL=postgres://...\nPORT=3000"}
        className="font-mono text-xs"
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <FieldLabel className="text-xs" info="Environments assigned to any variable you add here. Existing variables keep the environments they already have.">
            New variables apply to
          </FieldLabel>
          <div className="flex flex-wrap gap-4">
            {ALL_TARGETS.map((t) => (
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
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setText(initial);
              onDone();
            }}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={pending || !dirty || targets.length === 0}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
