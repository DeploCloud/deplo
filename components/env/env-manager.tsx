"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, Share2, SearchX, Unlink } from "lucide-react";
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
import { EnvValueCell } from "@/components/env/env-value-cell";
import { EnvVarDialog } from "@/components/env/env-var-dialog";
import { EnvAuthorCell } from "@/components/env/env-author-cell";
import { SharedVarEditDialog } from "@/components/env/shared-var-edit-dialog";
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
import type { AppSharedVarDTO, SharedVarDTO } from "@/lib/data/shared-vars";

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

  // Shared vars that currently inject into this app. Their VALUES read like any
  // other row's (plain revealed on demand, secret masked) — the app's table is
  // what its next deploy will get, so a row it can't read at all is a hole in
  // that picture. They can be edited and deleted straight from here too (see
  // SharedRowActions) — a change just isn't local, so the UI says so.
  const appliedShared = React.useMemo(
    () => sharedVars.filter((v) => v.applied),
    [sharedVars],
  );

  const detailsById = React.useMemo(
    () => new Map(sharedVarDetails.map((v) => [v.id, v] as const)),
    [sharedVarDetails],
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
                <TableHead className="whitespace-nowrap">Key</TableHead>
                <TableHead className="w-full">Value</TableHead>
                <TableHead className="whitespace-nowrap">Last modified</TableHead>
                <TableHead className="whitespace-nowrap">Modified by</TableHead>
                <TableHead className="whitespace-nowrap text-right">Actions</TableHead>
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
                          className="gap-1 whitespace-nowrap text-[10px] font-normal"
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
                      <SharedRowActions
                        row={row}
                        appId={appId}
                        detail={detailsById.get(row.id)}
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

/**
 * How an INHERITED (mode-based) shared var reaches this app, for the note that
 * explains why it can't be peeled off one app. `link` is here only for
 * completeness — a linked var takes the removable path instead.
 */
const VIA_PHRASE: Record<string, string> = {
  teamWide: "with the whole team",
  project: "with this app's project",
  environment: "with this app's environment",
  link: "with this app",
};

/**
 * Actions for a SHARED row on one app's table: edit its value, and a delete
 * menu that separates the two very different removals a shared var has.
 *
 * A per-app LINK is the only removal that touches just this app, so
 * "Remove from this app" appears only when the var reaches the app SOLELY
 * through its link (`linked && !inherited`) — unlinking a var that also arrives
 * through a team/project/environment mode wouldn't stop it injecting, so we don't
 * offer a no-op. Every shared var can still be deleted for the whole team, which
 * is the destructive item guarded by a confirm.
 */
function SharedRowActions({
  row,
  appId,
  detail,
}: {
  row: AppSharedVarDTO;
  appId: string;
  detail: SharedVarDTO | undefined;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const canRemoveFromApp = row.linked && !row.inherited;

  function removeFromApp() {
    startTransition(async () => {
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
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="flex justify-end gap-1">
      <SimpleTooltip content="Edit value">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!detail || pending}
          onClick={() => setEditOpen(true)}
          aria-label="Edit"
        >
          <Pencil className="size-4" />
        </Button>
      </SimpleTooltip>

      <DropdownMenu>
        <SimpleTooltip content="Delete…">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              disabled={pending}
              aria-label="Delete"
            >
              <Trash2 className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </SimpleTooltip>
        <DropdownMenuContent align="end" className="w-72">
          {canRemoveFromApp ? (
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
          ) : (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Shared {VIA_PHRASE[row.via] ?? "beyond this app"}. It can&apos;t be
              removed from only this app — change its sharing on the{" "}
              <Link
                href="/variables?tab=shared"
                className="font-medium text-foreground underline underline-offset-2"
              >
                Variables page
              </Link>
              .
            </p>
          )}
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
            whole team. Every app it reaches — not just this one — stops receiving
            it on new deployments.
          </>
        }
        confirmLabel="Delete everywhere"
        successMessage="Shared variable deleted"
        onConfirm={async () => {
          const res = await gqlAction<{ deleteSharedVar: boolean }>(
            `mutation($id: String!) { deleteSharedVar(id: $id) }`,
            { id: row.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}
