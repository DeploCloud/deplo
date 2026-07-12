"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  GitBranch,
  Trash2,
  CircleStop,
  Server,
  ListFilter,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";
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
import { CommitLink } from "@/components/apps/commit-link";
import { DeploymentActions } from "@/components/apps/deployment-actions";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { DeploymentStatus, DeploymentEnvironment } from "@/lib/types";

const DELETE_DEPLOYMENTS = `mutation ($ids: [ID!]!) { deleteDeployments(ids: $ids) }`;
const DELETE_ALL = `mutation ($appId: ID, $serverId: ID) { deleteAllDeployments(appId: $appId, serverId: $serverId) }`;
const CANCEL_ALL = `mutation ($appId: ID, $serverId: ID) { cancelAllDeployments(appId: $appId, serverId: $serverId) }`;

/** In-progress deployments (queued/building) are still owned by the queue and the
 *  build job, so they can only be CANCELED — never selected for deletion. */
const IN_PROGRESS = new Set<DeploymentStatus>(["queued", "building"]);

/** Sentinel for the "no filter" option — shadcn `SelectItem` can't hold "". */
const ALL = "__all__";

/** Rows shown per page (client-side pagination over the filtered set). */
const PAGE_SIZE = 10;

export interface DeploymentRow {
  id: string;
  appId: string;
  appSlug: string;
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
 * Deployments page and an app's own Deployment history. It owns the page header
 * row (`header` on the left, the bulk-action buttons on the right — a
 * `justify-between` layout), the filters, the table, and client-side pagination
 * (10 rows/page over the filtered set).
 *
 * The global page also gets a Server column and Server/App filters
 * (`showServer`). Filtering is a VIEW concern — it narrows the rendered rows AND
 * the scope of the bulk "Stop all builds" / "Delete all" sweeps (their appId /
 * serverId args follow the active filters), so the buttons always act on what you
 * see. Only FINISHED deployments (ready/error/canceled) are selectable; an
 * in-progress one must be canceled first. Everything is capability-gated
 * server-side; `canManage` only hides the affordances.
 */
export function DeploymentsTable({
  deployments,
  header,
  showApp = false,
  showServer = false,
  scopeAppId,
  canManage,
}: {
  deployments: DeploymentRow[];
  /** Title/subtitle block rendered on the left of the header row, opposite the
   *  bulk-action buttons. Plain markup — passed straight through from the RSC page. */
  header?: React.ReactNode;
  /** Show the owning-app column (the global page). Off on an app's page. */
  showApp?: boolean;
  /** Show the owning-server column + Server/App filters (the global page). */
  showServer?: boolean;
  /** Scope the bulk sweeps to this app; omit to scope across the whole team. */
  scopeAppId?: string;
  /** Whether to show the delete affordances (cosmetic — server re-checks). */
  canManage: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [deleteSelectedOpen, setDeleteSelectedOpen] = React.useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = React.useState(false);
  const [cancelAllOpen, setCancelAllOpen] = React.useState(false);
  const [serverFilter, setServerFilter] = React.useState<string | null>(null);
  const [appFilter, setAppFilter] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(0);

  // Distinct servers / apps present in the current rows — the filter options.
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
  const appOptions = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const d of deployments)
      if (!m.has(d.appId)) m.set(d.appId, d.serviceName || d.appId);
    return [...m]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [deployments]);

  // Reconcile the chosen filters against what's still present (a refresh may have
  // dropped the last row on a server/app). Done in render — no effect — so a
  // now-empty filter simply behaves as "All" without a stale, un-clearable value.
  const effectiveServerFilter =
    serverFilter && serverOptions.some((s) => s.id === serverFilter)
      ? serverFilter
      : null;
  const effectiveAppFilter =
    appFilter && appOptions.some((s) => s.id === appFilter)
      ? appFilter
      : null;
  const hasFilter = effectiveServerFilter != null || effectiveAppFilter != null;

  // The rows matching the filters — everything downstream (selection, counts, bulk
  // scope) keys off this so the buttons act on exactly what's in scope.
  const visible = React.useMemo(
    () =>
      deployments.filter(
        (d) =>
          (!effectiveServerFilter || d.serverId === effectiveServerFilter) &&
          (!effectiveAppFilter || d.appId === effectiveAppFilter),
      ),
    [deployments, effectiveServerFilter, effectiveAppFilter],
  );

  // Client-side pagination over the filtered set. Clamp in render (no effect) so a
  // filter change or a post-delete refresh that shrinks the list never strands the
  // view on a page that no longer exists.
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * PAGE_SIZE;
  const paged = visible.slice(pageStart, pageStart + PAGE_SIZE);

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

  // The scope the bulk sweeps target: the app page pins one app; the
  // global page follows the active filters (both optional).
  const sweepAppId = scopeAppId ?? effectiveAppFilter ?? null;
  const sweepServerId = effectiveServerFilter ?? null;
  const activeAppName = effectiveAppFilter
    ? (appOptions.find((s) => s.id === effectiveAppFilter)?.name ?? null)
    : null;
  const activeServerName = effectiveServerFilter
    ? (serverOptions.find((s) => s.id === effectiveServerFilter)?.name ?? null)
    : null;
  // Human-readable scope for the confirm dialogs, mirroring the sweep args.
  const scopeText = scopeAppId
    ? "this app"
    : activeAppName && activeServerName
      ? `app ${activeAppName} on server ${activeServerName}`
      : activeAppName
        ? `app ${activeAppName}`
        : activeServerName
          ? `server ${activeServerName}`
          : "all your apps";

  // Reset to the first page whenever the filter set changes — otherwise a narrowed
  // list could open on a now-empty tail page.
  function applyServerFilter(v: string) {
    setServerFilter(v === ALL ? null : v);
    setPage(0);
  }
  function applyAppFilter(v: string) {
    setAppFilter(v === ALL ? null : v);
    setPage(0);
  }
  function clearFilters() {
    setServerFilter(null);
    setAppFilter(null);
    setPage(0);
  }

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
      { appId: sweepAppId, serverId: sweepServerId },
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
      { appId: sweepAppId, serverId: sweepServerId },
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
    6 + (showApp ? 1 : 0) + (showServer ? 1 : 0) + (canManage ? 1 : 0);
  const showFilters =
    showServer && (serverOptions.length >= 2 || appOptions.length >= 2);

  return (
    <div className="space-y-4">
      {/* Header: title/subtitle on the left, bulk-action buttons on the right
          (justify-between). The buttons are hidden when the caller can't manage. */}
      {(header || canManage) && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">{header}</div>
          {canManage && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
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
          )}
        </div>
      )}

      {/* Filters (global page only), left-aligned on one row. The multi-select
          delete controls have moved into a floating bottom-center pill (rendered
          near the end of this component). */}
      {showFilters && (
        <div className="flex min-h-9 flex-wrap items-center gap-2">
          <ListFilter className="size-4 text-muted-foreground" />
          {serverOptions.length >= 2 && (
            <Select
              value={effectiveServerFilter ?? ALL}
              onValueChange={applyServerFilter}
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
          {appOptions.length >= 2 && (
            <Select
              value={effectiveAppFilter ?? ALL}
              onValueChange={applyAppFilter}
            >
              <SelectTrigger className="w-[200px]" aria-label="Filter by app">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All apps</SelectItem>
                {appOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {hasFilter && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
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
              {showApp && <TableHead>App</TableHead>}
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
              paged.map((d) => {
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

                    {showApp && (
                      <TableCell>
                        <Link
                          href={`/apps/${d.appSlug}`}
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
                        appId={d.appId}
                        appSlug={d.appSlug}
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

      {/* Pagination — only when the filtered set spills past one page. */}
      {pageCount > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            Showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, visible.length)} of{" "}
            {visible.length}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            >
              <ChevronLeft className="size-4" />
              Previous
            </Button>
            <span className="px-1 text-sm text-muted-foreground">
              Page {safePage + 1} of {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
            >
              Next
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Multi-select action bar — floats at the bottom-center of the viewport
          whenever one or more finished deployments are checked. Mirrors the
          Overview selection pill (counter + Delete + Clear), scoped to this
          table's delete flow. Shared component, so both the global Deployments
          page and an app's own history get it. */}
      {selectedCount > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-6">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-popover/95 py-1.5 pl-4 pr-1.5 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-popover/80">
            <span className="whitespace-nowrap text-sm font-medium">
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
