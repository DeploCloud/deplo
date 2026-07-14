"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil, Share2, SearchX } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
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
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { EnvVarDTO } from "@/lib/types";
import type { AppSharedVarDTO } from "@/lib/data/shared-vars";

/**
 * Standalone and shared variables share ONE row list so that the sort orders the
 * whole table: filtered/sorted per block, "Recently modified" would still stack
 * every standalone var above every shared one, whatever their timestamps say.
 * `kind` is what the actions cell keys off; the `Shared · <via>` badge is what
 * marks a row the app doesn't own.
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
  const router = useRouter();

  // Shared vars that currently inject into this app. Their VALUES read like any
  // other row's (plain revealed on demand, secret masked) — the app's table is
  // what its next deploy will get, so a row it can't read at all is a hole in
  // that picture. What it cannot do here is CHANGE them: they are edited centrally
  // on the Variables page, which is what "Manage" links to.
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

  // The page's one action. It rides the toolbar (the end of the search/sort row)
  // when there is a table to act on, and the empty state otherwise — the first
  // variable has to be reachable from a page that has no toolbar yet.
  const addButton = (
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
  );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Environment Variables</h3>
        <p className="text-sm text-muted-foreground">
          Secret values are encrypted at rest and never shown again.
        </p>
      </div>

      {hasVars && (
        <EnvFilters
          state={filters}
          onChange={setFilters}
          onClear={clear}
          facets={facets}
          counts={counts}
          total={rows.length}
          shown={shownRows.length}
          actions={addButton}
        />
      )}

      {!hasVars ? (
        <EmptyState
          icon={Plus}
          title="No environment variables"
          description="Add variables to configure your app at runtime."
          action={addButton}
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
                      <EnvValueCell value={row.value} masked={row.masked} />
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
                      <EnvValueCell value={row.value} masked={row.masked} />
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
