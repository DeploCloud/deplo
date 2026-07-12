"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GitBranch, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { StatusBadge } from "@/components/shared/status-badge";
import { CommitLink } from "@/components/services/commit-link";
import { DeploymentActions } from "@/components/services/deployment-actions";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { DeploymentStatus, DeploymentEnvironment } from "@/lib/types";

const DELETE_DEPLOYMENTS = `mutation ($ids: [ID!]!) { deleteDeployments(ids: $ids) }`;
const DELETE_ALL = `mutation ($serviceId: ID) { deleteAllDeployments(serviceId: $serviceId) }`;

/** In-progress deployments (queued/building) are still owned by the queue and the
 *  build job, so they can only be CANCELED — never selected for deletion. */
const IN_PROGRESS = new Set<DeploymentStatus>(["queued", "building"]);

export interface DeploymentRow {
  id: string;
  serviceId: string;
  serviceSlug: string;
  serviceName: string;
  commitMessage: string;
  commitSha: string;
  commitUrl: string | null;
  status: DeploymentStatus;
  environment: DeploymentEnvironment;
  branch: string;
  createdAt: string;
  creator: string;
  url: string;
}

/**
 * The deployments table with multi-select DELETION. Shared by the global
 * Deployments page and a service's own Deployment history. Selection exists only
 * to delete (the request: "multi-select, only for deletion") — every other action
 * (open, visit, redeploy, promote, stop/cancel) stays per-row in `DeploymentActions`.
 *
 * Only FINISHED deployments (ready/error/canceled) are selectable; an in-progress
 * one must be canceled first, so its checkbox is disabled. "Delete all" clears
 * every finished deployment in scope — one service (`scopeServiceId`) or the whole
 * active team (omitted). Deletion is capability-gated server-side; `canManage`
 * only hides the affordances.
 */
export function DeploymentsTable({
  deployments,
  showService = false,
  scopeServiceId,
  canManage,
}: {
  deployments: DeploymentRow[];
  /** Show the owning-service column (the global page). Off on a service's page. */
  showService?: boolean;
  /** Scope "Delete all" to this service; omit to delete across the whole team. */
  scopeServiceId?: string;
  /** Whether to show the delete affordances (cosmetic — server re-checks). */
  canManage: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [deleteSelectedOpen, setDeleteSelectedOpen] = React.useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = React.useState(false);

  const selectableIds = React.useMemo(
    () => deployments.filter((d) => !IN_PROGRESS.has(d.status)).map((d) => d.id),
    [deployments],
  );
  const selectableSet = React.useMemo(
    () => new Set(selectableIds),
    [selectableIds],
  );

  // Keep the selection honest across refreshes: drop ids that are gone or no
  // longer selectable (e.g. a row that started building). Done in render via the
  // previous-value pattern so it never cascades a re-render.
  const effectiveSelected = React.useMemo(
    () => [...selected].filter((id) => selectableSet.has(id)),
    [selected, selectableSet],
  );
  const selectedCount = effectiveSelected.length;

  const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;
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
    const res = await gqlAction<{ deleteDeployments: number }, number>(
      DELETE_DEPLOYMENTS,
      { ids },
      (d) => d.deleteDeployments,
    );
    if (res.ok) {
      toast.success(`Deleted ${res.data} deployment${res.data === 1 ? "" : "s"}`);
      setSelected(new Set());
      router.refresh();
    }
    return res;
  }

  async function deleteAll() {
    const res = await gqlAction<{ deleteAllDeployments: number }, number>(
      DELETE_ALL,
      { serviceId: scopeServiceId ?? null },
      (d) => d.deleteAllDeployments,
    );
    if (res.ok) {
      toast.success(`Deleted ${res.data} deployment${res.data === 1 ? "" : "s"}`);
      setSelected(new Set());
      router.refresh();
    }
    return res;
  }

  const colSpan = showService ? 8 : 7;

  return (
    <div className="space-y-3">
      {/* Toolbar: bulk-delete on the left when a selection exists, "Delete all"
          on the right. Both are hidden when the caller can't manage deletions. */}
      {canManage && (
        <div className="flex min-h-9 items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {selectedCount > 0 && (
              <>
                <span className="text-sm text-muted-foreground">
                  {selectedCount} selected
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteSelectedOpen(true)}
                >
                  <Trash2 className="size-4" />
                  Delete selected
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </Button>
              </>
            )}
          </div>
          {selectableIds.length > 0 && (
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
        </div>
      )}

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
                        allSelected ? true : someSelected ? "indeterminate" : false
                      }
                      disabled={selectableIds.length === 0}
                      onCheckedChange={(v) => toggleAll(v === true)}
                      aria-label="Select all deployments"
                    />
                  </SimpleTooltip>
                </TableHead>
              )}
              <TableHead>Deployment</TableHead>
              {showService && <TableHead>Service</TableHead>}
              <TableHead>Status</TableHead>
              <TableHead>Environment</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-28 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deployments.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={colSpan}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  No deployments.
                </TableCell>
              </TableRow>
            ) : (
              deployments.map((d) => {
                const inProgress = IN_PROGRESS.has(d.status);
                const checked = selectableSet.has(d.id) && selected.has(d.id);
                return (
                  <TableRow key={d.id} data-state={checked ? "selected" : undefined}>
                    {canManage && (
                      <TableCell>
                        <SimpleTooltip
                          content={
                            inProgress
                              ? "Cancel this build before it can be deleted"
                              : "Select for deletion"
                          }
                        >
                          <span className="inline-flex">
                            <Checkbox
                              checked={checked}
                              disabled={inProgress}
                              onCheckedChange={(v) => toggleRow(d.id, v === true)}
                              aria-label={`Select deployment ${d.commitSha}`}
                            />
                          </span>
                        </SimpleTooltip>
                      </TableCell>
                    )}

                    <TableCell className="max-w-[280px]">
                      <p className="truncate font-medium text-foreground">
                        {d.commitMessage}
                      </p>
                      <CommitLink
                        sha={d.commitSha}
                        url={d.commitUrl}
                        className="font-mono text-xs text-muted-foreground"
                      />
                    </TableCell>

                    {showService && (
                      <TableCell>
                        <Link
                          href={`/services/${d.serviceSlug}`}
                          className="cursor-pointer font-medium text-foreground hover:underline"
                        >
                          {d.serviceName}
                        </Link>
                      </TableCell>
                    )}

                    <TableCell>
                      <StatusBadge status={d.status} />
                    </TableCell>

                    <TableCell>
                      <Badge
                        variant={
                          d.environment === "production" ? "default" : "secondary"
                        }
                        className="capitalize"
                      >
                        {d.environment}
                      </Badge>
                    </TableCell>

                    <TableCell>
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <GitBranch className="size-3.5 shrink-0" />
                        <span className="truncate font-mono text-xs">
                          {d.branch}
                        </span>
                      </span>
                    </TableCell>

                    <TableCell>
                      <p className="whitespace-nowrap text-foreground">
                        {timeAgo(d.createdAt)}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        by {d.creator}
                      </p>
                    </TableCell>

                    <TableCell className="text-right">
                      <DeploymentActions
                        id={d.id}
                        serviceId={d.serviceId}
                        serviceSlug={d.serviceSlug}
                        url={d.url}
                        status={d.status}
                        environment={d.environment}
                        canDelete={canManage}
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <ConfirmAction
        open={deleteSelectedOpen}
        onOpenChange={setDeleteSelectedOpen}
        title={`Delete ${selectedCount} deployment${selectedCount === 1 ? "" : "s"}?`}
        description="The selected deployments and their build logs are permanently removed. Running apps are unaffected, but this can't be undone."
        confirmLabel="Delete"
        onConfirm={deleteSelected}
      />
      <ConfirmAction
        open={deleteAllOpen}
        onOpenChange={setDeleteAllOpen}
        title="Delete all deployments?"
        description={
          scopeServiceId
            ? "Every finished deployment for this service (and its build logs) is permanently removed. In-progress builds are left. The running app is unaffected, but this can't be undone."
            : "Every finished deployment across all your services (and its build logs) is permanently removed. In-progress builds are left. Running apps are unaffected, but this can't be undone."
        }
        confirmLabel="Delete all"
        onConfirm={deleteAll}
      />
    </div>
  );
}
