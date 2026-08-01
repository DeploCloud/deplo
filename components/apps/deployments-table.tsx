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
  ArrowUpDown,
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
import { gqlAction, gqlSubscribe } from "@/lib/graphql-client";
import { cn, timeAgo } from "@/lib/utils";
import type { DeploymentStatus, DeploymentEnvironment } from "@/lib/types";

const DELETE_DEPLOYMENTS = `mutation ($ids: [ID!]!) { deleteDeployments(ids: $ids) }`;
const DELETE_ALL = `mutation ($appId: ID, $serverId: ID, $environment: String, $status: String) { deleteAllDeployments(appId: $appId, serverId: $serverId, environment: $environment, status: $status) }`;
const CANCEL_ALL = `mutation ($appId: ID, $serverId: ID, $environment: String, $status: String) { cancelAllDeployments(appId: $appId, serverId: $serverId, environment: $environment, status: $status) }`;

/** In-progress deployments (queued/building) are still owned by the queue and the
 *  build job, so they can only be CANCELED — never selected for deletion. */
const IN_PROGRESS = new Set<DeploymentStatus>(["queued", "building"]);

/** Sentinel for the "no filter" option — shadcn `SelectItem` can't hold "". */
const ALL = "__all__";

/** Anything inside a row that owns its own click: links (commit sha, the App
 *  name, the row's action buttons), the selection checkbox (`role=checkbox`),
 *  and any cell explicitly opted out with `data-no-row-nav` (the checkbox cell,
 *  whose padding is aimed at while selecting). A click landing on one of these
 *  never falls through to the row's "open this deployment" navigation. */
const ROW_NAV_EXEMPT =
  'a, button, input, label, select, textarea, [role="checkbox"], [role="menuitem"], [data-no-row-nav]';

/** Rows shown per page (client-side pagination over the filtered set). */
const PAGE_SIZE = 10;

/** Created-column sort. Newest-first matches the server's ordering (the default);
 *  oldest-first is the exact reverse of the fully-ordered set. */
type SortDir = "newest" | "oldest";

/** Canonical dropdown order + labels for the Status filter — a fixed lifecycle
 *  order (not row/insertion order) so the menu reads the same on every page. */
const STATUS_ORDER: DeploymentStatus[] = [
  "queued",
  "building",
  "ready",
  "error",
  "canceled",
];
const STATUS_LABELS: Record<DeploymentStatus, string> = {
  queued: "Queued",
  building: "Building",
  ready: "Ready",
  error: "Error",
  canceled: "Canceled",
};

/** Canonical dropdown order + labels for the Environment filter. */
const ENV_ORDER: DeploymentEnvironment[] = ["production", "preview"];
const ENV_LABELS: Record<DeploymentEnvironment, string> = {
  production: "Production",
  preview: "Preview",
};

/** Live status feed. Reuses the app-keyed `appStatus` stream (the one the app
 *  header/tabs already ride) — its `latestDeployment` carries the in-flight
 *  build's current status. */
const DEPLOYMENT_STATUS_SUB = /* GraphQL */ `
  subscription DeploymentRowStatus($slug: String!) {
    appStatus(slug: $slug) {
      id
      latestDeployment {
        id
        status
      }
    }
  }
`;
type StatusSub = {
  appStatus: {
    id: string;
    latestDeployment: { id: string; status: DeploymentStatus } | null;
  } | null;
};

/**
 * Keeps the deployment Status chips live without a reload, on BOTH the global and
 * an app's own history. A deployment's status only moves while it's queued/building
 * → ready/error/canceled, and an app's in-flight build is (bar the rare concurrent
 * -preview case) its LATEST deployment — exactly what the `appStatus` subscription
 * streams. So we open one SSE per app that currently has an in-progress row and
 * overlay each pushed status onto the matching deployment id. When a tracked build
 * settles we also refresh the RSC read so the rest of the row (actions,
 * selectability, any newly-appeared build) reconciles from the authoritative data.
 *
 * Returns `statusOf(id, serverStatus)` → the row's effective (live) status. The
 * overlay only ever holds a status pushed by the authoritative stream, so it can
 * never show something the server would contradict (ids are never reused).
 */
function useLiveDeploymentStatuses(
  rows: { id: string; appSlug: string; status: DeploymentStatus }[],
): (id: string, serverStatus: DeploymentStatus) => DeploymentStatus {
  const router = useRouter();
  const [overlay, setOverlay] = React.useState<
    ReadonlyMap<string, DeploymentStatus>
  >(() => new Map());

  const statusOf = React.useCallback(
    (id: string, serverStatus: DeploymentStatus) =>
      overlay.get(id) ?? serverStatus,
    [overlay],
  );

  // Distinct app slugs with an in-progress row, by EFFECTIVE status — the only
  // apps whose deployment status can still change. Sorted + comma-joined into a
  // stable key so the effect re-subscribes only when the SET changes, not on
  // every render.
  const slugKey = React.useMemo(() => {
    const s = new Set<string>();
    for (const r of rows)
      if (IN_PROGRESS.has(overlay.get(r.id) ?? r.status)) s.add(r.appSlug);
    return [...s].sort().join(",");
  }, [rows, overlay]);

  React.useEffect(() => {
    if (!slugKey) return;
    const unsubs = slugKey.split(",").map((slug) =>
      gqlSubscribe<StatusSub>(
        DEPLOYMENT_STATUS_SUB,
        { slug },
        (data) => {
          const dep = data.appStatus?.latestDeployment;
          if (!dep) return;
          setOverlay((prev) => {
            if (prev.get(dep.id) === dep.status) return prev;
            const next = new Map(prev);
            next.set(dep.id, dep.status);
            return next;
          });
          // A settled build flips its actions/selectability too — pull fresh
          // server data. Bounded: fires once, on the in-progress→terminal edge.
          if (!IN_PROGRESS.has(dep.status)) router.refresh();
        },
        // A slug we can no longer watch (deleted/renamed app) must not spam.
        () => {},
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [slugKey, router]);

  return statusOf;
}

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
 * The global page also gets a Server column and Server/App filters (`showServer`);
 * Status, Environment and a Created sort surface on EITHER page whenever the rows
 * warrant them (≥2 distinct values, or >1 row for the sort). Filtering is a VIEW
 * concern — it narrows the rendered rows AND the scope of the bulk "Stop all builds"
 * / "Delete all" sweeps (their appId/serverId/environment/status args all follow the
 * active filters), so the buttons always act on exactly what you see. Sorting is
 * pure ordering — it never changes the swept set. Only FINISHED deployments
 * (ready/error/canceled) are selectable; an in-progress one must be canceled first.
 * Everything is capability-gated server-side; `canManage` only hides the affordances.
 *
 * A row is clickable as a whole: clicking anywhere that isn't a dedicated control
 * (a link, an action button, the selection checkbox and its cell) opens that
 * deployment's page — see `openDeployment` / `ROW_NAV_EXEMPT`.
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
  const [statusFilter, setStatusFilter] =
    React.useState<DeploymentStatus | null>(null);
  const [envFilter, setEnvFilter] =
    React.useState<DeploymentEnvironment | null>(null);
  const [sortDir, setSortDir] = React.useState<SortDir>("newest");
  const [page, setPage] = React.useState(0);

  // Live Status chips: overlays the in-flight build's status onto its row so the
  // badge tracks queued → building → ready/error without a reload (both pages).
  const liveStatusOf = useLiveDeploymentStatuses(deployments);

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
  // Distinct statuses / environments present, each in its canonical lifecycle order
  // (not insertion order). Also derived from ALL rows so an option never vanishes
  // just because another filter narrowed the table.
  const statusOptions = React.useMemo(() => {
    const present = new Set(deployments.map((d) => d.status));
    return STATUS_ORDER.filter((s) => present.has(s));
  }, [deployments]);
  const envOptions = React.useMemo(() => {
    const present = new Set(deployments.map((d) => d.environment));
    return ENV_ORDER.filter((e) => present.has(e));
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
  const effectiveStatusFilter =
    statusFilter && statusOptions.includes(statusFilter) ? statusFilter : null;
  const effectiveEnvFilter =
    envFilter && envOptions.includes(envFilter) ? envFilter : null;
  const hasFilter =
    effectiveServerFilter != null ||
    effectiveAppFilter != null ||
    effectiveStatusFilter != null ||
    effectiveEnvFilter != null;

  // The rows matching the filters — everything downstream (selection, counts, bulk
  // scope) keys off this so the buttons act on exactly what's in scope.
  const visible = React.useMemo(
    () =>
      deployments.filter(
        (d) =>
          (!effectiveServerFilter || d.serverId === effectiveServerFilter) &&
          (!effectiveAppFilter || d.appId === effectiveAppFilter) &&
          (!effectiveStatusFilter || d.status === effectiveStatusFilter) &&
          (!effectiveEnvFilter || d.environment === effectiveEnvFilter),
      ),
    [
      deployments,
      effectiveServerFilter,
      effectiveAppFilter,
      effectiveStatusFilter,
      effectiveEnvFilter,
    ],
  );

  // The Created sort is a VIEW concern over the already-filtered set. The incoming
  // rows are a total order (createdAt DESC, seq DESC), so "newest" is the set as-is
  // and "oldest" is its exact reverse — preserving the seq tie-break without a lossy
  // string compare. Selection/counts key off `visible` (order-free), so only the
  // rendered page reads from `sorted`.
  const sorted = React.useMemo(
    () => (sortDir === "oldest" ? [...visible].reverse() : visible),
    [visible, sortDir],
  );

  // Client-side pagination over the filtered+sorted set. Clamp in render (no effect)
  // so a filter change or a post-delete refresh that shrinks the list never strands
  // the view on a page that no longer exists.
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * PAGE_SIZE;
  const paged = sorted.slice(pageStart, pageStart + PAGE_SIZE);

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

  // The scope the bulk sweeps target: the app page pins one app; the global page
  // follows the active filters. ALL active view filters flow into the sweep args
  // (app/server/environment/status) so "Delete all" / "Stop all builds" act on
  // exactly the rows the filters leave visible.
  const sweepAppId = scopeAppId ?? effectiveAppFilter ?? null;
  const sweepServerId = effectiveServerFilter ?? null;
  const sweepEnv = effectiveEnvFilter ?? null;
  const sweepStatus = effectiveStatusFilter ?? null;
  const activeAppName = effectiveAppFilter
    ? (appOptions.find((s) => s.id === effectiveAppFilter)?.name ?? null)
    : null;
  const activeServerName = effectiveServerFilter
    ? (serverOptions.find((s) => s.id === effectiveServerFilter)?.name ?? null)
    : null;
  // Human-readable scope for the confirm dialogs, mirroring the sweep args. The
  // who (app/server) reads as a phrase; the environment/status narrowers ride along
  // in parentheses so the dialog names exactly what's about to be swept.
  const scopeWho = scopeAppId
    ? "this app"
    : activeAppName && activeServerName
      ? `app ${activeAppName} on server ${activeServerName}`
      : activeAppName
        ? `app ${activeAppName}`
        : activeServerName
          ? `server ${activeServerName}`
          : "all your apps";
  const scopeQualifiers = [
    effectiveEnvFilter ? ENV_LABELS[effectiveEnvFilter] : null,
    effectiveStatusFilter ? STATUS_LABELS[effectiveStatusFilter] : null,
  ].filter(Boolean);
  const scopeText =
    scopeQualifiers.length > 0
      ? `${scopeWho} (${scopeQualifiers.join(", ")})`
      : scopeWho;

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
  function applyStatusFilter(v: string) {
    setStatusFilter(v === ALL ? null : (v as DeploymentStatus));
    setPage(0);
  }
  function applyEnvFilter(v: string) {
    setEnvFilter(v === ALL ? null : (v as DeploymentEnvironment));
    setPage(0);
  }
  // Re-sorting jumps back to the first page so the newly-first rows are in view.
  function applySort(v: string) {
    setSortDir(v as SortDir);
    setPage(0);
  }
  // "Clear filters" resets the narrowing filters only; the Created sort is an
  // ordering, not a filter, so it deliberately stays put.
  function clearFilters() {
    setServerFilter(null);
    setAppFilter(null);
    setStatusFilter(null);
    setEnvFilter(null);
    setPage(0);
  }

  // Whole-row navigation: clicking a row anywhere that isn't a dedicated control
  // opens that deployment (its build logs & details) — the same destination as the
  // row's ScrollText button and its commit-message link. Bails on a click that
  // landed on an own-click element, and on a click that merely ended a text
  // selection (drag-to-select inside the row must not navigate). A modified or
  // middle click opens a new tab, matching what an anchor would do.
  function openDeployment(
    d: DeploymentRow,
    e: React.MouseEvent<HTMLTableRowElement>,
  ) {
    if ((e.target as HTMLElement | null)?.closest(ROW_NAV_EXEMPT)) return;
    if (window.getSelection()?.toString()) return;
    const href = `/apps/${d.appSlug}/deployments/${d.id}`;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    router.push(href);
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
      {
        appId: sweepAppId,
        serverId: sweepServerId,
        environment: sweepEnv,
        status: sweepStatus,
      },
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
      {
        appId: sweepAppId,
        serverId: sweepServerId,
        environment: sweepEnv,
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
    6 + (showApp ? 1 : 0) + (showServer ? 1 : 0) + (canManage ? 1 : 0);
  // Server/App narrowers only exist on the global page (showServer); Status,
  // Environment and Sort surface wherever the rows warrant them — the app's own
  // history included. The Server selector is the PRIMARY scoping axis of this
  // "across all of your apps and servers" view, so it stays visible whenever any
  // server is resolvable — even a single one (it names where the builds ran and is
  // ready the instant a second server appears). The rest auto-hide until they'd
  // offer a real choice (≥2 distinct values).
  const showServerFilter = showServer && serverOptions.length >= 1;
  const showAppFilter = showServer && appOptions.length >= 2;
  const showStatusFilter = statusOptions.length >= 2;
  const showEnvFilter = envOptions.length >= 2;
  const showSort = deployments.length > 1;
  // Any actual narrower present? The funnel glyph rides on this, not on the whole
  // bar, so a sort-only row (e.g. an app whose history is all one status+env)
  // doesn't display a filter icon over a control that only sorts.
  const showNarrowers =
    showServerFilter || showAppFilter || showStatusFilter || showEnvFilter;
  const showFilters = showNarrowers || showSort;

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

      {/* Filters + Created sort on one wrapping row. Server/App exist only on the
          global page (showServer); Status/Environment/Sort appear wherever the rows
          warrant them (the app's own history included). The multi-select delete
          controls live in a floating bottom-center pill near the end of this
          component. */}
      {showFilters && (
        <div className="flex min-h-9 flex-wrap items-center gap-2">
          {showNarrowers && (
            <ListFilter className="size-4 text-muted-foreground" />
          )}
          {showServerFilter && (
            <Select
              value={effectiveServerFilter ?? ALL}
              onValueChange={applyServerFilter}
            >
              <SelectTrigger className="w-[170px]" aria-label="Filter by server">
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
          {showAppFilter && (
            <Select
              value={effectiveAppFilter ?? ALL}
              onValueChange={applyAppFilter}
            >
              <SelectTrigger className="w-[180px]" aria-label="Filter by app">
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
          {showStatusFilter && (
            <Select
              value={effectiveStatusFilter ?? ALL}
              onValueChange={applyStatusFilter}
            >
              <SelectTrigger className="w-[150px]" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {statusOptions.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {showEnvFilter && (
            <Select
              value={effectiveEnvFilter ?? ALL}
              onValueChange={applyEnvFilter}
            >
              <SelectTrigger
                className="w-[160px]"
                aria-label="Filter by environment"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All environments</SelectItem>
                {envOptions.map((e) => (
                  <SelectItem key={e} value={e}>
                    {ENV_LABELS[e]}
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
          {showSort && (
            <Select value={sortDir} onValueChange={applySort}>
              <SelectTrigger
                className={cn("w-[150px]", showNarrowers && "sm:ml-auto")}
                aria-label="Sort by created date"
              >
                {/* `flex!` is load-bearing: SelectTrigger applies
                    `[&>span]:line-clamp-1` to its direct-child spans, whose
                    `display:-webkit-box` outranks a plain `flex` class (the
                    `>span` selector is more specific) and would stack the icon
                    above the value. The important modifier keeps them on one row. */}
                <span className="flex! items-center gap-2">
                  <ArrowUpDown className="size-3.5 shrink-0 text-muted-foreground" />
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
              </SelectContent>
            </Select>
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
                  <TableRow
                    key={d.id}
                    data-state={checked ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={(e) => openDeployment(d, e)}
                    onAuxClick={(e) => {
                      if (e.button === 1) openDeployment(d, e);
                    }}
                  >
                    {canManage && (
                      /* The checkbox cell opts out of row navigation entirely —
                         its padding is aimed at while selecting, and a near-miss
                         must not navigate away from the selection. */
                      <TableCell data-no-row-nav>
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
                      {/* The commit message is a real link to the deployment —
                          the keyboard/screen-reader path to what the whole row
                          does on click (a <tr> can't be a link itself). */}
                      <Link
                        href={`/apps/${d.appSlug}/deployments/${d.id}`}
                        className="block truncate font-medium text-foreground hover:underline focus-visible:underline"
                      >
                        {d.commitMessage}
                      </Link>
                      <CommitLink
                        sha={d.commitSha}
                        url={d.commitUrl}
                        className="font-mono text-xs text-muted-foreground"
                      />
                    </TableCell>

                    {showApp && (
                      <TableCell>
                        {/* On the global page the App name opens THIS row's build
                            logs (its deployment detail), not the app overview —
                            the fastest path from "which build is this?" to its logs. */}
                        <SimpleTooltip content="Open this deployment's build logs">
                          <Link
                            href={`/apps/${d.appSlug}/deployments/${d.id}`}
                            className="cursor-pointer font-medium text-foreground hover:underline"
                          >
                            {d.serviceName}
                          </Link>
                        </SimpleTooltip>
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
                      <StatusBadge status={liveStatusOf(d.id, d.status)} />
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
