"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  LockOpen,
  Plus,
  Trash2,
  Share2,
  SearchX,
  Settings,
  Unlink,
} from "lucide-react";
import Link from "next/link";
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
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { EnvGraphic } from "@/components/env/env-graphic";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { TimeAgo } from "@/components/shared/time-ago";
import { EnvVarDialog } from "@/components/env/env-var-dialog";
import { MakePlainDialog } from "@/components/env/make-plain-dialog";
import { EnvAuthorCell } from "@/components/env/env-author-cell";
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
import type { EnvVarDTO } from "@/lib/types";
import type { AppSharedVarDTO, SharedVarDTO } from "@/lib/data/shared-vars";
import type { TeamEnvironment } from "@/lib/data/environments";
import type {
  AppRef,
  ProjectRef,
  TeamRef,
} from "@/components/env/shared-var-wizard";

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
  canCreateShared,
  apps,
  projects,
  environments,
  teams,
  composeKeys = [],
}: {
  appId: string;
  vars: EnvVarDTO[];
  sharedVars: AppSharedVarDTO[];
  /**
   * The full shared-var record for every shared var applied to this app - what
   * says whether the variable is OURS to manage. Keyed by id into `detailsById`.
   */
  sharedVarDetails: SharedVarDTO[];
  /** `manage_env` held team-wide - what creating a shared variable needs. */
  canCreateShared: boolean;
  /** Every app of the team - the shared-variable wizard's "Specific apps" picker. */
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
  /** The teams the viewer may share a new variable with. */
  teams: TeamRef[];
  /**
   * Keys this app's own compose file writes itself. Deplo injects a variable into a
   * compose service as a pass-through, so a key the YAML already sets keeps the
   * YAML's value - said on the row, because the setting looks applied otherwise.
   */
  composeKeys?: string[];
}) {
  const [editing, setEditing] = React.useState<EnvVarDTO | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  // The way back from a secret typed by mistake, which nothing else offers.
  const [makePlain, setMakePlain] = React.useState<{
    id: string;
    key: string;
  } | null>(null);
  const router = useRouter();

  // What actually reaches this app: the vars it OPTED INTO (the link, ADR-0012),
  // plus the ones another team or the instance injects with no opt-in at all
  // (ADR-0027) - those are read-only here, but they must be visible, because a
  // value in the container that appears nowhere in the UI is the failure mode.
  const appliedShared = React.useMemo(
    () => sharedVars.filter((v) => v.linked || v.autoInject),
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
                      <TimeAgo at={row.updatedAt} />
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
                        {row.type === "secret" && (
                          <SimpleTooltip content="Make it plain">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground"
                              onClick={() =>
                                setMakePlain({ id: row.id, key: row.key })
                              }
                              aria-label="Make it plain"
                            >
                              <LockOpen className="size-4" />
                            </Button>
                          </SimpleTooltip>
                        )}
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
                          {/* A variable another team owns says WHOSE it is, linked
                              or not: the actions below are theirs, not ours. */}
                          {row.linked &&
                          detailsById.get(row.id)?.editable !== false
                            ? "Shared"
                            : (row.ownerTeamName ?? "Every team")}
                        </Badge>
                        {composeKeys.includes(row.key) && (
                          <SimpleTooltip content="This app's compose file sets this variable itself, so the compose value is what the container gets.">
                            <Badge
                              variant="outline"
                              className="text-[10px] font-normal whitespace-nowrap"
                            >
                              Set in the compose file
                            </Badge>
                          </SimpleTooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <EnvValueCell value={row.value} masked={row.masked} />
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      <TimeAgo at={row.updatedAt} />
                    </TableCell>
                    <TableCell>
                      {/* A shared row carries no creator - it falls back server-side. */}
                      <EnvAuthorCell author={row.updatedBy ?? null} />
                    </TableCell>
                    <TableCell className="text-right">
                      {row.linked ? (
                        <SharedRowActions
                          row={row}
                          appId={appId}
                          manageable={
                            canCreateShared &&
                            detailsById.get(row.id)?.editable !== false
                          }
                          onRemoved={() => remove(rowKey(row))}
                          onRestored={() => restore(rowKey(row))}
                        />
                      ) : (
                        <SimpleTooltip
                          content={`Shared by ${row.ownerTeamName ?? "an instance admin"}. Only they can change it.`}
                        >
                          <span className="text-xs text-muted-foreground">
                            Read-only
                          </span>
                        </SimpleTooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ),
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <MakePlainDialog
        key={makePlain?.id ?? "none"}
        open={makePlain !== null}
        onOpenChange={(o) => !o && setMakePlain(null)}
        id={makePlain?.id ?? ""}
        varKey={makePlain?.key ?? ""}
      />
      <EnvVarDialog
        key={editing?.id ?? "new"}
        open={addOpen}
        onOpenChange={setAddOpen}
        appId={appId}
        editing={editing}
        sharedVars={sharedVars}
        canCreateShared={canCreateShared}
        apps={apps}
        projects={projects}
        environments={environments}
        teams={teams}
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
 * Actions for a SHARED row on one app's table. Neither the value nor the variable
 * itself is edited here: an app opts in and out, the library is managed on the
 * Variables page.
 */
function SharedRowActions({
  row,
  appId,
  manageable,
  onRemoved,
  onRestored,
}: {
  row: AppSharedVarDTO;
  appId: string;
  /** Ours to manage: `manage_env` team-wide, and not another team's variable. */
  manageable: boolean;
  /**
   * Unlinking takes the row off THIS table, so it drops on the click rather than
   * staying clickable until the refresh lands, and comes back if the mutation
   * behind it is refused.
   */
  onRemoved: () => void;
  onRestored: () => void;
}) {
  const router = useRouter();
  // Unlinking one of these does not take it out of the container: it keeps arriving
  // with no link, at the lowest precedence (ADR-0027).
  const keepsArriving = row.autoInject;

  function removeFromApp() {
    // The row goes now and the unlink settles behind it - unless the variable keeps
    // arriving anyway, in which case the row belongs on the table, read-only.
    if (!keepsArriving) onRemoved();
    void (async () => {
      const res = await gqlAction(
        `mutation($varId: String!, $appId: String!, $linked: Boolean!) {
           setSharedVarAppLink(varId: $varId, appId: $appId, linked: $linked)
         }`,
        { varId: row.id, appId, linked: false },
      );
      if (res.ok) {
        toast.success(
          keepsArriving
            ? `${row.key} now arrives from ${row.ownerTeamName ?? "an instance admin"}`
            : `Removed ${row.key} from this app`,
        );
        router.refresh();
      } else {
        if (!keepsArriving) onRestored();
        toast.error(res.error);
      }
    })();
  }

  return (
    <div className="flex justify-end gap-1">
      {manageable && (
        <SimpleTooltip content="Manage this shared variable">
          <Button variant="ghost" size="icon-sm" asChild aria-label="Manage">
            <Link href={`/variables?tab=shared&edit=${row.id}`}>
              <Settings className="size-4" />
            </Link>
          </Button>
        </SimpleTooltip>
      )}
      <SimpleTooltip
        content={
          keepsArriving
            ? "Remove this app's opt-in. It still arrives from the team that shares it."
            : "Remove from this app. Every other app keeps it."
        }
      >
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={removeFromApp}
          aria-label="Remove from this app"
          className="text-muted-foreground hover:text-destructive"
        >
          <Unlink className="size-4" />
        </Button>
      </SimpleTooltip>
    </div>
  );
}
