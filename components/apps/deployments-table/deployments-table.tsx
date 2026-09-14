"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Trash2, CircleStop, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import { IN_PROGRESS, useLiveDeploymentStatuses } from "./deployment-status";
import {
  DeploymentTableRow,
  useOpenDeployment,
  type DeploymentRow,
} from "./deployment-row";
import { DeploymentFilterBar } from "./deployment-filter-bar";
import { PAGE_SIZE, useDeploymentFilters } from "./use-deployment-filters";

const DELETE_DEPLOYMENTS = `mutation ($ids: [ID!]!) { deleteDeployments(ids: $ids) }`;
const DELETE_ALL = `mutation ($appId: ID, $serverId: ID, $status: String) { deleteAllDeployments(appId: $appId, serverId: $serverId, status: $status) }`;
const CANCEL_ALL = `mutation ($appId: ID, $serverId: ID, $status: String) { cancelAllDeployments(appId: $appId, serverId: $serverId, status: $status) }`;
const CANCEL_ONE = `mutation ($id: String!) { cancelDeployment(id: $id) }`;

// DeploymentsTable is the deployments history with multi-select DELETION. Only
// FINISHED deployments are selectable; an in-progress one must be canceled first.
export function DeploymentsTable({
  deployments,
  header,
  actions,
  showApp = false,
  showServer = false,
  scopeAppId,
  canManage,
  canRollbackApps = false,
}: {
  deployments: DeploymentRow[];
  /** Title/subtitle block rendered on the left of the header row, opposite the
   *  bulk-action buttons. Plain markup - passed straight through from the RSC page. */
  header?: React.ReactNode;
  /** Rendered LAST in the header row's right-hand cluster, after the bulk
   *  actions - a way to the settings page belongs past the buttons that act on
   *  this one. */
  actions?: React.ReactNode;
  /** Show the owning-app column (the global page). Off on an app's page. */
  showApp?: boolean;
  /** Show the owning-server column + Server/App filters (the global page). */
  showServer?: boolean;
  /** Scope the bulk sweeps to this app; omit to scope across the whole team. */
  scopeAppId?: string;
  /** Whether to show the delete affordances (cosmetic - server re-checks). */
  canManage: boolean;
  /** Whether the viewer holds `rollback_apps`. Its own permission, so it is its
   *  own prop: the Rollback item greys out rather than vanishing. */
  canRollbackApps?: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  // Deleted deployments leave the table on the click - one row, the selection, or a
  // whole filtered sweep.
  const {
    visible: remaining,
    remove,
    restore,
  } = useOptimisticRemove(deployments, (d) => d.id);
  const [deleteSelectedOpen, setDeleteSelectedOpen] = React.useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = React.useState(false);
  const [cancelAllOpen, setCancelAllOpen] = React.useState(false);

  // Live Status chips: overlays the in-flight build's status onto its row so the
  // badge tracks queued → building → ready/error without a reload (both pages).
  const liveStatusOf = useLiveDeploymentStatuses(deployments);
  const filters = useDeploymentFilters({
    deployments,
    remaining,
    scopeAppId,
    showServer,
  });
  const {
    visible,
    paged,
    hasMore,
    sentinelRef,
    hasFilter,
    hasClientNarrower,
    scopeText,
    sweepAppId,
    sweepServerId,
    sweepStatus,
    showFilters,
  } = filters;
  const openDeployment = useOpenDeployment();

  const selectableIds = React.useMemo(
    () =>
      visible
        .filter((d) => !IN_PROGRESS.has(d.status) && !d.appMigrating)
        .map((d) => d.id),
    [visible],
  );
  // In-progress (queued/building) deployments in the visible scope - the "Stop all
  // builds" targets. The server re-derives the real set (and honors folder caps).
  const inProgressCount = React.useMemo(
    () => visible.filter((d) => IN_PROGRESS.has(d.status)).length,
    [visible],
  );
  const selectableSet = React.useMemo(
    () => new Set(selectableIds),
    [selectableIds],
  );

  // Keep the selection honest across refreshes and filter changes: drop ids that are
  // gone, filtered out, or no longer selectable (e.g. a row that started building).
  const effectiveSelected = React.useMemo(
    () => [...selected].filter((id) => selectableSet.has(id)),
    [selected, selectableSet],
  );
  const selectedCount = effectiveSelected.length;

  const allSelected =
    selectableIds.length > 0 && selectedCount === selectableIds.length;
  const someSelected = selectedCount > 0 && !allSelected;

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(selectableIds) : new Set());
  }
  function toggleRow(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function deleteSelected() {
    const ids = effectiveSelected;
    ids.forEach(remove);
    setSelected(new Set());
    const res = await gqlAction<{ deleteDeployments: number }, number>(
      DELETE_DEPLOYMENTS,
      { ids },
      (d) => d.deleteDeployments,
    );
    if (res.ok) {
      toast.success(
        `Deleted ${res.data} deployment${res.data === 1 ? "" : "s"}`,
      );
    } else {
      ids.forEach(restore);
    }
    router.refresh();
    return res;
  }

  async function deleteAll() {
    // The sweep's scope IS the selectable rows in view, so they all go now; a
    // refusal puts them back and the refresh settles anything in between.
    const swept = selectableIds;
    swept.forEach(remove);
    setSelected(new Set());
    // Search and Created narrow the view but have no sweep argument, so with
    // either active the button deletes the ids in view instead - "Delete all"
    // must never reach a row the filters are hiding.
    const res = hasClientNarrower
      ? await gqlAction<{ deleteDeployments: number }, number>(
          DELETE_DEPLOYMENTS,
          { ids: swept },
          (d) => d.deleteDeployments,
        )
      : await gqlAction<{ deleteAllDeployments: number }, number>(
          DELETE_ALL,
          {
            appId: sweepAppId,
            serverId: sweepServerId,
            status: sweepStatus,
          },
          (d) => d.deleteAllDeployments,
        );
    if (res.ok) {
      toast.success(
        `Deleted ${res.data} deployment${res.data === 1 ? "" : "s"}`,
      );
    } else {
      swept.forEach(restore);
    }
    router.refresh();
    return res;
  }

  async function cancelAll() {
    // Same reason as `deleteAll`: with a client-only narrower active the sweep
    // args can't express the view, so each build in view is stopped by id.
    if (hasClientNarrower) {
      const ids = visible
        .filter((d) => IN_PROGRESS.has(d.status))
        .map((d) => d.id);
      const results = await Promise.all(
        ids.map((id) =>
          gqlAction<{ cancelDeployment: boolean }, boolean>(
            CANCEL_ONE,
            { id },
            (d) => d.cancelDeployment,
          ),
        ),
      );
      const failed = results.find((r) => !r.ok);
      if (failed) return failed;
      const stopped = results.filter((r) => r.ok && r.data).length;
      toast.success(`Stopped ${stopped} build${stopped === 1 ? "" : "s"}`);
      router.refresh();
      return { ok: true as const, data: stopped };
    }
    const res = await gqlAction<{ cancelAllDeployments: number }, number>(
      CANCEL_ALL,
      {
        appId: sweepAppId,
        serverId: sweepServerId,
        status: sweepStatus,
      },
      (d) => d.cancelAllDeployments,
    );
    if (res.ok) {
      // Outcome-only copy: the server returns how many were ACTUALLY stopped, which
      // can be 0 either because they finished in the gap or because they sit in
      // folders the caller can't manage (silently skipped). Don't assert none existed.
      toast.success(`Stopped ${res.data} build${res.data === 1 ? "" : "s"}`);
      router.refresh();
    }
    return res;
  }

  const colSpan =
    5 + (showApp ? 1 : 0) + (showServer ? 1 : 0) + (canManage ? 1 : 0);
  const showStopAll = canManage && inProgressCount > 0;
  const showDeleteAll = canManage && selectableIds.length > 0;

  return (
    <div className="space-y-4">
      {(header || actions || showStopAll || showDeleteAll) && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">{header}</div>
          {(actions || showStopAll || showDeleteAll) && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {showStopAll && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCancelAllOpen(true)}
                >
                  <CircleStop className="size-4" />
                  Stop all builds
                  <span className="text-muted-foreground">
                    ({inProgressCount})
                  </span>
                </Button>
              )}
              {showDeleteAll && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteAllOpen(true)}
                >
                  <Trash2 className="size-4" />
                  Delete all
                </Button>
              )}
              {actions}
            </div>
          )}
        </div>
      )}

      {showFilters && <DeploymentFilterBar filters={filters} />}

      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {canManage && (
                <TableHead className="w-10">
                  <SimpleTooltip
                    content={
                      selectableIds.length === 0
                        ? "No finished deployments to select"
                        : allSelected
                          ? "Deselect all"
                          : "Select all finished deployments"
                    }
                  >
                    <Checkbox
                      checked={
                        allSelected
                          ? true
                          : someSelected
                            ? "indeterminate"
                            : false
                      }
                      disabled={selectableIds.length === 0}
                      onCheckedChange={(v) => toggleAll(v === true)}
                      aria-label="Select all deployments"
                    />
                  </SimpleTooltip>
                </TableHead>
              )}
              <TableHead>Deployment</TableHead>
              {showApp && <TableHead>App</TableHead>}
              {showServer && <TableHead>Server</TableHead>}
              <TableHead>Status</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-28 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={colSpan}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  {hasFilter
                    ? "No deployments match the filters."
                    : "No deployments."}
                </TableCell>
              </TableRow>
            ) : (
              paged.map((d) => (
                <DeploymentTableRow
                  key={d.id}
                  d={d}
                  showApp={showApp}
                  showServer={showServer}
                  canManage={canManage}
                  canRollbackApps={canRollbackApps}
                  checked={selectableSet.has(d.id) && selected.has(d.id)}
                  liveStatus={liveStatusOf(d.id, d.status)}
                  onOpen={openDeployment}
                  onToggle={(v) => toggleRow(d.id, v)}
                  onRemoved={() => remove(d.id)}
                  onRestored={() => restore(d.id)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Endless scroll: the sentinel loads the next batch as it nears the fold,
          and the count says where you are in the filtered set. */}
      {(hasMore || paged.length > PAGE_SIZE) && (
        <div className="flex items-center justify-center">
          <div ref={sentinelRef} aria-hidden className="h-px w-px" />
          <span className="text-sm text-muted-foreground">
            Showing {paged.length} of {visible.length}
          </span>
        </div>
      )}

      {selectedCount > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-6">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-popover/95 py-1.5 pr-1.5 pl-4 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-popover/80">
            <span className="text-sm font-medium whitespace-nowrap">
              {selectedCount} selected
            </span>
            <span className="mx-1.5 h-5 w-px bg-border" />
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleteSelectedOpen(true)}
            >
              <Trash2 className="size-4" />
              Delete {selectedCount} deployment{selectedCount === 1 ? "" : "s"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
            >
              <X className="size-4" />
              Clear
            </Button>
          </div>
        </div>
      )}

      <ConfirmAction
        open={deleteSelectedOpen}
        onOpenChange={setDeleteSelectedOpen}
        title={`Delete ${selectedCount} deployment${selectedCount === 1 ? "" : "s"}?`}
        description="The selected deployments and their build logs are removed."
        consequence="Running apps are unaffected, but this can't be undone."
        confirmLabel="Delete"
        optimistic
        onConfirm={deleteSelected}
      />
      <ConfirmAction
        open={deleteAllOpen}
        onOpenChange={setDeleteAllOpen}
        title={`Delete ${selectableIds.length} finished deployment${selectableIds.length === 1 ? "" : "s"}?`}
        description={
          <>
            Every finished deployment for <strong>{scopeText}</strong> is
            removed, with its build logs. In-progress builds are left.
          </>
        }
        consequence="Running apps are unaffected, but this can't be undone."
        confirmLabel="Delete all"
        optimistic
        onConfirm={deleteAll}
      />
      <ConfirmAction
        open={cancelAllOpen}
        onOpenChange={setCancelAllOpen}
        variant="default"
        title={`Stop ${inProgressCount} running build${inProgressCount === 1 ? "" : "s"}?`}
        description={
          <>
            Every queued or building deployment for <strong>{scopeText}</strong>{" "}
            is canceled.
          </>
        }
        consequence="A build already running on its host may finish in the background, but its result won't be deployed."
        confirmLabel="Stop all builds"
        onConfirm={cancelAll}
      />
    </div>
  );
}
