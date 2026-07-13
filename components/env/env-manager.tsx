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
  SearchX,
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
import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { EnvVarDialog } from "@/components/env/env-var-dialog";
import { EnvAuthorCell } from "@/components/env/env-author-cell";
import {
  EnvFilters,
  useEnvFilters,
  editorFacet,
  sourceFacet,
  typeFacet,
  updatedFacet,
  VIA_LABEL,
} from "@/components/env/env-filters";
import { parseEnv, serializeEnv } from "@/components/env/env-parse";
import { gqlAction } from "@/lib/graphql-client";
import { cn, timeAgo } from "@/lib/utils";
import type { EnvVarDTO } from "@/lib/types";
import type { AppSharedVarDTO } from "@/lib/data/shared-vars";

/**
 * Standalone and shared variables share ONE row list so that the sort orders the
 * whole table: filtered/sorted per block, "Recently modified" would still stack
 * every standalone var above every shared one, whatever their timestamps say.
 * `kind` is what the actions cell keys off; the `Shared · <via>` badge is what
 * the eye keys off.
 */
type EnvRow =
  | ({ kind: "standalone" } & EnvVarDTO)
  | ({ kind: "shared" } & AppSharedVarDTO);

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
  const appliedShared = React.useMemo(
    () => sharedVars.filter((v) => v.applied),
    [sharedVars],
  );

  const rows = React.useMemo<EnvRow[]>(
    () => [
      ...vars.map((v): EnvRow => ({ ...v, kind: "standalone" })),
      ...appliedShared.map((v): EnvRow => ({ ...v, kind: "shared" })),
    ],
    [vars, appliedShared],
  );

  // One app's table: the variable is either its own or shared with it (Source),
  // and beyond that only what/who/when apply — a Project or Environment filter
  // would have exactly one value here.
  const facets = React.useMemo(
    () => [
      sourceFacet(rows),
      typeFacet(rows),
      editorFacet(rows),
      updatedFacet<EnvRow>(),
    ],
    [rows],
  );
  const {
    state: filters,
    setState: setFilters,
    clear,
    shown: shownRows,
    counts,
  } = useEnvFilters(rows, facets);

  const hasVars = rows.length > 0;
  const hasMatches = shownRows.length > 0;

  // Which plain rows are currently revealed. Secrets are never in this set —
  // they have no reveal path. "Reveal all" fills/clears it in one shot.
  const [revealedIds, setRevealedIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Scoped to the VISIBLE rows, not every row: with a filter on, "Reveal all"
  // must act on what you can actually see, or the button reads "Hide all" for
  // rows that aren't on screen and clicking it appears to do nothing.
  const revealableIds = React.useMemo(
    () =>
      shownRows
        .filter((r) => r.kind === "standalone" && !r.masked)
        .map((r) => r.id),
    [shownRows],
  );
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
      <div>
        <h3 className="text-sm font-medium">Environment Variables</h3>
        <p className="text-sm text-muted-foreground">
          Secret values are encrypted at rest and never shown again.
        </p>
      </div>

      {/* The actions sit OUTSIDE the mode branch below (the view toggle has to
          survive the editor swapping the table out) and ABOVE the filters, which
          need the full width to keep their dropdowns on one row. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto flex flex-wrap items-center gap-2">
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
          <ViewToggle mode={mode} onChange={setMode} />
        </div>
      </div>

      {mode === "table" && hasVars && (
        <EnvFilters
          state={filters}
          onChange={setFilters}
          onClear={clear}
          facets={facets}
          counts={counts}
          total={rows.length}
          shown={shownRows.length}
        />
      )}

      {mode === "editor" ? (
        // UNFILTERED on purpose: the editor saves through `setAppEnv`, which deletes
        // every variable absent from the text it is given. Handing it the filtered
        // rows would silently drop whatever the search happened to hide.
        <EnvEditor appId={appId} vars={vars} onDone={() => setMode("table")} />
      ) : !hasVars ? (
        <EmptyState
          icon={Plus}
          title="No environment variables"
          description="Add variables to configure your app at runtime."
        />
      ) : !hasMatches ? (
        <EmptyState
          icon={SearchX}
          title="No matching variables"
          description="No variable matches the current search and filters."
          action={
            <Button variant="outline" size="sm" onClick={clear}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Last modified</TableHead>
                <TableHead>Modified by</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownRows.map((row) =>
                row.kind === "standalone" ? (
                  <TableRow key={`standalone:${row.id}`}>
                    <TableCell className="font-mono text-xs font-medium">
                      {row.key}
                    </TableCell>
                    <TableCell>
                      <EnvValueCell
                        value={row.value}
                        masked={row.masked}
                        revealed={revealedIds.has(row.id)}
                        onRevealedChange={(next) => toggleReveal(row.id, next)}
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      <SimpleTooltip
                        content={new Date(row.updatedAt).toLocaleString()}
                      >
                        <span>{timeAgo(row.updatedAt)}</span>
                      </SimpleTooltip>
                    </TableCell>
                    <TableCell>
                      <EnvAuthorCell
                        author={row.updatedBy ?? row.createdBy ?? null}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => { setEditing(row); setAddOpen(true); }}
                          aria-label="Edit"
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteId(row.id)}
                          aria-label="Delete"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={`shared:${row.id}`}>
                    <TableCell className="font-mono text-xs font-medium">
                      <div className="flex items-center gap-2">
                        {row.key}
                        <Badge
                          variant="muted"
                          className="gap-1 text-[10px] font-normal"
                        >
                          <Share2 className="size-3" />
                          Shared · {VIA_LABEL[row.via] ?? "Shared"}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      {/* Shared values are never exposed to the client. */}
                      <span className="text-xs text-muted-foreground">
                        managed centrally
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      <SimpleTooltip
                        content={new Date(row.updatedAt).toLocaleString()}
                      >
                        <span>{timeAgo(row.updatedAt)}</span>
                      </SimpleTooltip>
                    </TableCell>
                    <TableCell>
                      {/* A shared row carries no creator — it falls back server-side. */}
                      <EnvAuthorCell author={row.updatedBy ?? null} />
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
                ),
              )}
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
 * line and deletes the ones removed — new vars are PLAIN. Existing vars keep
 * their own type.
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
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  const hasSecrets = vars.some((v) => v.masked);
  const dirty = text !== initial;

  function save() {
    startTransition(async () => {
      const entries = parseEnv(text);
      const res = await gqlAction<{ setAppEnv: number }, number>(
        `mutation($appId: String!, $entries: [EnvEntryInput!]!) {
          setAppEnv(appId: $appId, entries: $entries)
        }`,
        { appId, entries },
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
      <div className="flex justify-end gap-2">
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
        <Button onClick={save} disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
