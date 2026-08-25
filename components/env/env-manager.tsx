"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Share2, SearchX, Unlink } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { EnvGraphic } from "@/components/env/env-graphic";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { EnvVarDialog } from "@/components/env/env-var-dialog";
import { EnvAuthorCell } from "@/components/env/env-author-cell";
import { SharedVarEditDialog } from "@/components/env/shared-var-edit-dialog";
import { EnvEditButton } from "@/components/env/env-edit-button";
import {
  EnvFilters,
  useEnvFilters,
  editorFacet,
  sourceFacet,
  typeFacet,
  updatedFacet,
} from "@/components/env/env-filters";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { EnvVarDTO } from "@/lib/types";
import type { AppSharedVarDTO, SharedVarDTO } from "@/lib/data/shared-vars";

/**
 * Standalone and shared variables share ONE row list so that the sort orders the
 * whole table: filtered/sorted per block, "Recently modified" would still stack
 * every standalone var above every shared one, whatever their timestamps say.
 */
type EnvRow =
  ({ kind: "standalone" } & EnvVarDTO) | ({ kind: "shared" } & AppSharedVarDTO);

/**
 * A row's identity in this table - also its React key and what an optimistic
 * removal is tracked by. `kind` is part of it because the two lists are minted
 * separately: an id only identifies a row together with the list it came from.
 */
const rowKey = (row: EnvRow) => `${row.kind}:${row.id}`;

export function EnvManager({
  appId,
  vars,
  sharedVars,
  sharedVarDetails,
}: {
  appId: string;
  vars: EnvVarDTO[];
  sharedVars: AppSharedVarDTO[];
  /**
   * The full shared-var record for every shared var applied to this app, so a
   * value edit here can round-trip its scope verbatim (SharedVarEditDialog needs
   * the whole DTO). Keyed by id into `detailsById` below.
   */
  sharedVarDetails: SharedVarDTO[];
}) {
  const [editing, setEditing] = React.useState<EnvVarDTO | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const router = useRouter();

  // Shared vars this app has OPTED INTO (linked - the only way a shared var injects,
  // ADR-0012).
  const appliedShared = React.useMemo(
    () => sharedVars.filter((v) => v.linked),
    [sharedVars],
  );

  const detailsById = React.useMemo(
    () => new Map(sharedVarDetails.map((v) => [v.id, v] as const)),
    [sharedVarDetails],
  );

  const serverRows = React.useMemo<EnvRow[]>(
    () => [
      ...vars.map((v): EnvRow => ({ ...v, kind: "standalone" })),
      ...appliedShared.map((v): EnvRow => ({ ...v, kind: "shared" })),
    ],
    [vars, appliedShared],
  );

  // A deleted (or unlinked) row leaves the table on the click, instead of waiting out
  // the mutation and then the `router.refresh()` that reloads this page's variables -
  // the window in which a second click on the same row used to earn a "Not found".
  const {
    visible: rows,
    remove,
    restore,
  } = useOptimisticRemove(serverRows, rowKey);

  // One app's table: the variable is either its own or shared with it (Source),
  // and beyond that only what/who/when apply - a Project or Environment filter
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

  // The page's one action, and it only ever has one home at a time: the toolbar when
  // there is a table to act on, the heading row when there is not - the first
  // variable has to be reachable from a page that has no toolbar yet.
  const addButton = (size: "sm" | "default") => (
    <Button
      size={size}
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
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Environment Variables</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Secret values are encrypted at rest and never shown again.
          </p>
        </div>
        {!hasVars && addButton("sm")}
      </div>

      {hasVars && (
        <EnvFilters
          state={filters}
          onChange={setFilters}
          onClear={clear}
          facets={facets}
          counts={counts}
          actions={addButton("default")}
        />
      )}

      {!hasVars ? (
        <EmptyState
          graphic={<EnvGraphic />}
          title="No environment variables"
          docs="env.overview"
          description="Add variables to configure your app - available during builds and at runtime."
        />
      ) : !hasMatches ? (
        <EmptyState
          icon={SearchX}
          title="No matching variables"
          description="No variable matches the current search and filters."
        />
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">Key</TableHead>
                <TableHead className="w-full">Value</TableHead>
                <TableHead className="whitespace-nowrap">
                  Last modified
                </TableHead>
                <TableHead className="whitespace-nowrap">Modified by</TableHead>
                <TableHead className="text-right whitespace-nowrap">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownRows.map((row) =>
                row.kind === "standalone" ? (
                  <TableRow key={rowKey(row)}>
                    <TableCell className="font-mono text-xs font-medium">
                      {row.key}
                    </TableCell>
                    <TableCell>
                      <EnvValueCell value={row.value} masked={row.masked} />
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
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
                        <EnvEditButton
                          secret={row.type === "secret"}
                          onClick={() => {
                            setEditing(row);
                            setAddOpen(true);
                          }}
                        />
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
                  <TableRow key={rowKey(row)}>
                    <TableCell className="font-mono text-xs font-medium">
                      <div className="flex items-center gap-2">
                        {row.key}
                        <Badge
                          variant="muted"
                          className="gap-1 text-[10px] font-normal whitespace-nowrap"
                        >
                          <Share2 className="size-3" />
                          Shared
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <EnvValueCell value={row.value} masked={row.masked} />
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      <SimpleTooltip
                        content={new Date(row.updatedAt).toLocaleString()}
                      >
                        <span>{timeAgo(row.updatedAt)}</span>
                      </SimpleTooltip>
                    </TableCell>
                    <TableCell>
                      {/* A shared row carries no creator - it falls back server-side. */}
                      <EnvAuthorCell author={row.updatedBy ?? null} />
                    </TableCell>
                    <TableCell className="text-right">
                      <SharedRowActions
                        row={row}
                        appId={appId}
                        detail={detailsById.get(row.id)}
                        onRemoved={() => remove(rowKey(row))}
                        onRestored={() => restore(rowKey(row))}
                      />
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
        optimistic
        onConfirm={async () => {
          // `deleteId` is this render's value: the dialog has already closed
          // itself (and cleared it) by the time this runs.
          const id = deleteId!;
          const key = `standalone:${id}`;
          remove(key);
          const res = await gqlAction<{ deleteEnv: boolean }>(
            `mutation($id: String!) { deleteEnv(id: $id) }`,
            { id },
          );
          if (res.ok) router.refresh();
          else restore(key);
          return res;
        }}
      />
    </div>
  );
}

/**
 * Actions for a SHARED row on one app's table: edit its value, and a delete menu
 * that separates the two very different removals a shared var has.
 */
function SharedRowActions({
  row,
  appId,
  detail,
  onRemoved,
  onRestored,
}: {
  row: AppSharedVarDTO;
  appId: string;
  detail: SharedVarDTO | undefined;
  /**
   * Both removals below take the row off THIS table, so both tell the table to
   * drop it on the click rather than leaving it clickable until the refresh
   * lands, and to put it back if the mutation behind it is refused.
   */
  onRemoved: () => void;
  onRestored: () => void;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  function removeFromApp() {
    // The row goes now and the unlink settles behind it.
    onRemoved();
    void (async () => {
      const res = await gqlAction(
        `mutation($varId: String!, $appId: String!, $linked: Boolean!) {
           setSharedVarAppLink(varId: $varId, appId: $appId, linked: $linked)
         }`,
        { varId: row.id, appId, linked: false },
      );
      if (res.ok) {
        toast.success(`Removed ${row.key} from this app`);
        router.refresh();
      } else {
        onRestored();
        toast.error(res.error);
      }
    })();
  }

  return (
    <div className="flex justify-end gap-1">
      <EnvEditButton
        secret={row.type === "secret"}
        disabled={!detail}
        tooltip="Edit value"
        onClick={() => setEditOpen(true)}
      />

      <DropdownMenu>
        <SimpleTooltip content="Delete…">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              aria-label="Delete"
            >
              <Trash2 className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </SimpleTooltip>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem
            className="flex-col items-start gap-0.5"
            onSelect={removeFromApp}
          >
            <span className="flex items-center gap-2">
              <Unlink className="size-4" />
              Remove from this app
            </span>
            <span className="pl-6 text-xs text-muted-foreground">
              Unlinks it here. Every other app keeps it.
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            className="flex-col items-start gap-0.5"
            onSelect={() => setDeleteOpen(true)}
          >
            <span className="flex items-center gap-2">
              <Trash2 className="size-4" />
              Delete for all apps…
            </span>
            <span className="pl-6 text-xs text-muted-foreground">
              Removes it from every app it reaches.
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {detail && (
        <SharedVarEditDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          editing={detail}
          warnShared
        />
      )}
      <ConfirmAction
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete shared variable?"
        description={
          <>
            This deletes <span className="font-mono">{row.key}</span> for the
            whole team. Every app it reaches, not just this one, stops receiving
            it on new deployments.
          </>
        }
        confirmLabel="Delete everywhere"
        successMessage="Shared variable deleted"
        optimistic
        onConfirm={async () => {
          onRemoved();
          const res = await gqlAction<{ deleteSharedVar: boolean }>(
            `mutation($id: String!) { deleteSharedVar(id: $id) }`,
            { id: row.id },
          );
          if (res.ok) router.refresh();
          else onRestored();
          return res;
        }}
      />
    </div>
  );
}
