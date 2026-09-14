"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Plus, Trash2, Share2, SearchX, Settings, Unlink } from "lucide-react";
import Link from "@/components/ui/link";
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
import { EnvAuthorCell } from "@/components/env/env-author-cell";
import { EnvEditButton } from "@/components/env/env-edit-button";
import { EnvFilters } from "@/components/env/env-filters/env-filters-toolbar";
import {
  editorFacet,
  sourceFacet,
  typeFacet,
  updatedFacet,
} from "@/components/env/env-filters/facets";
import { useEnvFilters } from "@/components/env/env-filters/use-env-filters";
import { gqlAction } from "@/lib/graphql-client";
import { envNameLooksSensitive } from "@/lib/env-secret-name";
import type { EnvVarDTO } from "@/lib/types/env";
import type { AppSharedVarDTO } from "@/lib/data/shared-vars/app-view";
import type { SharedVarDTO } from "@/lib/data/shared-vars/team-view";
import type { TeamEnvironment } from "@/lib/data/environments";
import type {
  AppRef,
  ProjectRef,
  TeamRef,
} from "@/components/env/shared-var-wizard/types";

type EnvRow =
  ({ kind: "standalone" } & EnvVarDTO) | ({ kind: "shared" } & AppSharedVarDTO);

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
  sharedVarDetails: SharedVarDTO[];
  canCreateShared: boolean;
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
  teams: TeamRef[];
  composeKeys?: string[];
}) {
  const [editing, setEditing] = React.useState<EnvVarDTO | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const router = useRouter();

  // The vars this app opted into (ADR-0012) plus the ones injected with no opt-in (ADR-0027).
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

  const {
    visible: rows,
    remove,
    restore,
  } = useOptimisticRemove(serverRows, rowKey);

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
                      <div className="flex items-center gap-2">
                        {row.key}
                        {row.type === "plain" &&
                          envNameLooksSensitive(row.key) && (
                            <LooksLikeSecretBadge />
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
                          {/* Another team's variable says whose it is. */}
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
                        {row.type === "plain" &&
                          row.linked &&
                          detailsById.get(row.id)?.editable !== false &&
                          envNameLooksSensitive(row.key) && (
                            <LooksLikeSecretBadge />
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
                      {/* A shared row carries no creator. */}
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

// SharedRowActions - the opt-in / opt-out actions for a shared row on one app's table.
function SharedRowActions({
  row,
  appId,
  manageable,
  onRemoved,
  onRestored,
}: {
  row: AppSharedVarDTO;
  appId: string;
  manageable: boolean;
  onRemoved: () => void;
  onRestored: () => void;
}) {
  const router = useRouter();
  // Unlinking does not take it out of the container: it keeps arriving with no link (ADR-0027).
  const keepsArriving = row.autoInject;

  function removeFromApp() {
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

// LooksLikeSecretBadge - a plain variable whose name reads like a credential.
function LooksLikeSecretBadge() {
  return (
    <SimpleTooltip content="This name usually holds a credential. Edit it and turn on Secret: the value is then write-only and nothing shows it again.">
      <Badge
        variant="outline"
        className="text-[10px] font-normal whitespace-nowrap"
      >
        Secret?
      </Badge>
    </SimpleTooltip>
  );
}
