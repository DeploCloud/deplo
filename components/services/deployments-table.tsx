"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GitBranch, Trash2, CircleStop, Server, ListFilter } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { StatusBadge } from "@/components/shared/status-badge";
import { CommitLink } from "@/components/services/commit-link";
import { DeploymentActions } from "@/components/services/deployment-actions";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { DeploymentStatus, DeploymentEnvironment } from "@/lib/types";

const DELETE_DEPLOYMENTS = `mutation ($ids: [ID!]!) { deleteDeployments(ids: $ids) }`;
const DELETE_ALL = `mutation ($serviceId: ID, $serverId: ID) { deleteAllDeployments(serviceId: $serviceId, serverId: $serverId) }`;
const CANCEL_ALL = `mutation ($serviceId: ID, $serverId: ID) { cancelAllDeployments(serviceId: $serviceId, serverId: $serverId) }`;

/** In-progress deployments (queued/building) are still owned by the queue and the
 *  build job, so they can only be CANCELED — never selected for deletion. */
const IN_PROGRESS = new Set<DeploymentStatus>(["queued", "building"]);

/** Sentinel for the "no filter" option — shadcn `SelectItem` can't hold "". */
const ALL = "__all__";

export interface DeploymentRow {
  id: string;
  serviceId: string;
  serviceSlug: string;
  serviceName: string;
  /** Owning server id — present on the global page (for the Server filter). */
  serverId?: string | null;
  /** Owning server name — present on the global page (for the Server column). */
  serverName?: string | null;
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
 * to delete — every other action (open, visit, redeploy, promote, stop/cancel)
 * stays per-row in `DeploymentActions`.
 *
 * The global page also gets a Server column and Server/Service filters
 * (`showServer`). Filtering is a VIEW concern — it narrows the rendered rows AND
 * the scope of the bulk "Stop all builds" / "Delete all" sweeps (their serviceId /
 * serverId args follow the active filters), so the buttons always act on what you
 * see. Only FINISHED deployments (ready/error/canceled) are selectable; an
 * in-progress one must be canceled first. Everything is capability-gated
 * server-side; `canManage` only hides the affordances.
 */
export function DeploymentsTable({
  deployments,
  showService = false,
  showServer = false,
  scopeServiceId,
  canManage,
}: {
  deployments: DeploymentRow[];
  /** Show the owning-service column (the global page). Off on a service's page. */
  showService?: boolean;
  /** Show the owning-server column + Server/Service filters (the global page). */
  showServer?: boolean;
  /** Scope the bulk sweeps to this service; omit to scope across the whole team. */
  scopeServiceId?: string;
  /** Whether to show the delete affordances (cosmetic — server re-checks). */
  canManage: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [deleteSelectedOpen, setDeleteSelectedOpen] = React.useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = React.useState(false);
  const [cancelAllOpen, setCancelAllOpen] = React.useState(false);
  const [serverFilter, setServerFilter] = React.useState<string | null>(null);
  const [serviceFilter, setServiceFilter] = React.useState<string | null>(null);

  // Distinct servers / services present in the current rows — the filter options.
  // Derived from ALL rows (not the filtered view) so each dropdown stays stable
  // while the other filter narrows the table.
  const serverOptions = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const d of deployments)
      if (d.serverId && !m.has(d.serverId)) m.set(d.serverId, d.serverName ?? d.serverId);
    return [...m]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [deployments]);
  const serviceOptions = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const d of deployments)
      if (!m.has(d.serviceId)) m.set(d.serviceId, d.serviceName || d.serviceId);
    return [...m]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [deployments]);

  // Reconcile the chosen filters against what's still present (a refresh may have
  // dropped the last row on a server/service). Done in render — no effect — so a
  // now-empty filter simply behaves as "All" without a stale, un-clearable value.
  const effectiveServerFilter =
    serverFilter && serverOptions.some((s) => s.id === serverFilter)
      ? serverFilter
      : null;
  const effectiveServiceFilter =
    serviceFilter && serviceOptions.some((s) => s.id === serviceFilter)
      ? serviceFilter
      : null;
  const hasFilter = effectiveServerFilter != null || effectiveServiceFilter != null;

  // The rows actually shown — everything downstream (selection, counts, bulk
  // scope) keys off this so the buttons act on exactly what's visible.
  const visible = React.useMemo(
    () =>
      deployments.filter(
        (d) =>
          (!effectiveServerFilter || d.serverId === effectiveServerFilter) &&
          (!effectiveServiceFilter || d.serviceId === effectiveServiceFilter),
      ),
    [deployments, effectiveServerFilter, effectiveServiceFilter],
  );

  const selectableIds = React.useMemo(
    () => visible.filter((d) => !IN_PROGRESS.has(d.status)).map((d) => d.id),
    [visible],
  );
  // In-progress (queued/building) deployments in the visible scope — the "Stop all
  // builds" targets. A live count off the current rows; the server re-derives the
  // real set (and honors folder caps) when the mutation runs.
  const inProgressCount = React.useMemo(
    () => visible.filter((d) => IN_PROGRESS.has(d.status)).length,
    [visible],
  );
  const selectableSet = React.useMemo(
    () => new Set(selectableIds),
    [selectableIds],
  );

  // Keep the selection honest across refreshes and filter changes: drop ids that
  // are gone, filtered out, or no longer selectable (e.g. a row that started
  // building). Render-time via the previous-value pattern — never cascades a
  // re-render.
  const effectiveSelected = React.useMemo(
    () => [...selected].filter((id) => selectableSet.has(id)),
    [selected, selectableSet],
  );
  const selectedCount = effectiveSelected.length;

  const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;
  const someSelected = selectedCount > 0 && !allSelected;

  // The scope the bulk sweeps target: the service page pins one service; the
  // global page follows the active filters (both optional).
  const sweepServiceId = scopeServiceId ?? effectiveServiceFilter ?? null;
  const sweepServerId = effectiveServerFilter ?? null;
  const activeServiceName = effectiveServiceFilter
    ? (serviceOptions.find((s) => s.id === effectiveServiceFilter)?.name ?? null)
    : null;
  const activeServerName = effectiveServerFilter
    ? (serverOptions.find((s) => s.id === effectiveServerFilter)?.name ?? null)
    : null;
  // Human-readable scope for the confirm dialogs, mirroring the sweep args.
  const scopeText = scopeServiceId
    ? "this service"
    : activeServiceName && activeServerName
      ? `service ${activeServiceName} on server ${activeServerName}`
      : activeServiceName
        ? `service ${activeServiceName}`
        : activeServerName
          ? `server ${activeServerName}`
          : "all your services";

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
      { serviceId: sweepServiceId, serverId: sweepServerId },
      (d) => d.deleteAllDeployments,
    );
    if (res.ok) {
      toast.success(`Deleted ${res.data} deployment${res.data === 1 ? "" : "s"}`);
      setSelected(new Set());
      router.refresh();
    }
    return res;
  }

  async function cancelAll() {
    const res = await gqlAction<{ cancelAllDeployments: number }, number>(
      CANCEL_ALL,
      { serviceId: sweepServiceId, serverId: sweepServerId },
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
    6 + (showService ? 1 : 0) + (showServer ? 1 : 0) + (canManage ? 1 : 0);
  const showFilters =
    showServer && (serverOptions.length >= 2 || serviceOptions.length >= 2);

  return (
    <div className="space-y-3">
      {/* Filters (global page): narrow the rows AND the bulk-sweep scope. Shown to
          everyone who can see the page — filtering isn't a mutation. */}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-2">
          <ListFilter className="size-4 text-muted-foreground" />
          {serverOptions.length >= 2 && (
            <Select
              value={effectiveServerFilter ?? ALL}
              onValueChange={(v) => setServerFilter(v === ALL ? null : v)}
            >
              <SelectTrigger className="w-[180px]" aria-label="Filter by server">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All servers</SelectItem>
                {serverOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {serviceOptions.length >= 2 && (
            <Select
              value={effectiveServiceFilter ?? ALL}
              onValueChange={(v) => setServiceFilter(v === ALL ? null : v)}
            >
              <SelectTrigger className="w-[200px]" aria-label="Filter by service">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All services</SelectItem>
                {serviceOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {hasFilter && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setServerFilter(null);
                setServiceFilter(null);
              }}
            >
              Clear filters
            </Button>
          )}
          <span className="text-sm text-muted-foreground">
            {visible.length} of {deployments.length}
          </span>
        </div>
      )}

      {/* Toolbar: bulk-delete on the left when a selection exists; on the right,
          "Stop all builds" (when any visible deployment is in progress) and
          "Delete all" (when any is finished). All hidden when the caller can't manage. */}
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
          <div className="flex items-center gap-2">
            {inProgressCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCancelAllOpen(true)}
              >
                <CircleStop className="size-4" />
                Stop all builds
                <span className="text-muted-foreground">({inProgressCount})</span>
              </Button>
            )}
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
              {showServer && <TableHead>Server</TableHead>}
              <TableHead>Status</TableHead>
              <TableHead>Environment</TableHead>
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
                  {hasFilter ? "No deployments match the filters." : "No deployments."}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((d) => {
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

                    {showServer && (
                      <TableCell>
                        {d.serverName ? (
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <Server className="size-3.5 shrink-0" />
                            <span className="truncate">{d.serverName}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
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
        title={`Delete ${selectableIds.length} finished deployment${selectableIds.length === 1 ? "" : "s"}?`}
        description={`Every finished deployment for ${scopeText} (and its build logs) is permanently removed. In-progress builds are left. Running apps are unaffected, but this can't be undone.`}
        confirmLabel="Delete all"
        onConfirm={deleteAll}
      />
      <ConfirmAction
        open={cancelAllOpen}
        onOpenChange={setCancelAllOpen}
        variant="default"
        title={`Stop ${inProgressCount} running build${inProgressCount === 1 ? "" : "s"}?`}
        description={`Every queued or building deployment for ${scopeText} is canceled. A build already running on its host may finish in the background, but its result won't be deployed.`}
        confirmLabel="Stop all builds"
        onConfirm={cancelAll}
      />
    </div>
  );
}
