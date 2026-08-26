"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  GitBranch,
  Trash2,
  CircleStop,
  Hammer,
  Undo2,
  ListFilter,
  ArrowUpDown,
  CalendarClock,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/shared/user-avatar";
import { AppLogo } from "@/components/shared/project-logo";
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
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
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
const CANCEL_ONE = `mutation ($id: String!) { cancelDeployment(id: $id) }`;

/** In-progress deployments (queued/building) are still owned by the queue and the
 *  build job, so they can only be CANCELED, never selected for deletion. */
const IN_PROGRESS = new Set<DeploymentStatus>(["queued", "building"]);

/** Sentinel for the "no filter" option - shadcn `SelectItem` can't hold "". */
const ALL = "__all__";

/**
 * Anything inside a row that owns its own click: links (commit sha, the App name,
 * the row's action buttons), the selection checkbox (`role=checkbox`), and any
 * cell explicitly opted out with `data-no-row-nav` (the checkbox cell, whose
 * padding is aimed at while selecting).
 */
const ROW_NAV_EXEMPT =
  'a, button, input, label, select, textarea, [role="checkbox"], [role="menuitem"], [data-no-row-nav]';

/** Rows rendered up front, and how many more each time the sentinel at the end of
 *  the table scrolls into view. The whole (filtered) set is already in memory -
 *  this only bounds how much of it the DOM holds. */
const PAGE_SIZE = 25;

/** Canonical order + labels for the Created filter. Windows are measured against
 *  one "now" per render, so every option of a pass agrees on where the edges are. */
const DAY = 86_400_000;
const DATE_WINDOWS: { value: string; label: string; within: number }[] = [
  { value: "24h", label: "Last 24 hours", within: DAY },
  { value: "7d", label: "Last 7 days", within: 7 * DAY },
  { value: "30d", label: "Last 30 days", within: 30 * DAY },
];
const OLDER = "older";
const OLDER_LABEL = "More than 30 days ago";

/** Does this row fall in the chosen Created window? `now` is passed in, not read
 *  here, so every option of one pass measures against the same instant. */
export function matchesDateWindow(
  createdAt: string,
  value: string,
  now: number,
): boolean {
  const age = now - new Date(createdAt).getTime();
  const w = DATE_WINDOWS.find((x) => x.value === value);
  return w ? age <= w.within : age > 30 * DAY;
}

/** Everything a row can be found by: its own id, the app and server it belongs
 *  to, the commit (sha, message, branch, PR number, GitHub URLs) and who ran it.
 *  One lowercased string per row; the needle's words all have to appear in it. */
export function searchHaystack(d: DeploymentRow): string {
  return [
    d.id,
    d.appSlug,
    d.serviceName,
    d.serverName,
    d.buildServerName,
    d.commitMessage,
    d.commitSha,
    d.commitUrl,
    d.branch,
    d.prNumber != null ? `#${d.prNumber}` : null,
    d.pullRequestUrl,
    d.creator,
    d.creatorUser?.name,
    d.creatorUser?.username,
    d.environment,
    d.status,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Created-column sort. Newest-first matches the server's ordering (the default);
 *  oldest-first is the exact reverse of the fully-ordered set. */
type SortDir = "newest" | "oldest";

/** Canonical dropdown order + labels for the Status filter - a fixed lifecycle
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
 *  header/tabs already ride) - its `latestDeployment` carries the in-flight
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
 * an app's own history.
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

  // Distinct app slugs with an in-progress row, by EFFECTIVE status - the only apps
  // whose deployment status can still change.
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
          // A settled build flips its actions/selectability too - pull fresh
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
  /** The app's logo, shown beside its name in the App column. Only the global
   *  page passes it, since that is the only place the column exists. */
  appLogo?: string | null;
  /** Owning server id - present on the global page (for the Server filter). */
  serverId?: string | null;
  /** Owning server name - present on the global page (for the Server column). */
  serverName?: string | null;
  /** The server this deploy BUILT on, when that was not the owning one. Null for
   *  the ordinary "built where it runs", which is what almost every row is. */
  buildServerName?: string | null;
  commitMessage: string;
  commitSha: string;
  commitUrl: string | null;
  /** The pull request this preview build came from, or null for production. */
  pullRequestUrl?: string | null;
  /** Denormalized pull request number - shown next to the Preview badge. */
  prNumber?: number | null;
  status: DeploymentStatus;
  environment: DeploymentEnvironment;
  branch: string;
  createdAt: string;
  creator: string;
  /** The account behind `creator`, when there is one. Null for a webhook push
   *  (a GitHub login, not a deplo user) - that row keeps the bare name. */
  creatorUser?: {
    name: string;
    username: string;
    avatarColor: string;
    avatarUrl: string | null;
  } | null;
  url: string;
  /** The app can be put back on this deployment - the SERVER's answer (whether
   *  its image is still on the host), never re-derived in the browser. */
  canRollback?: boolean;
  /** This deployment WAS a rollback: it re-ran an older build's image rather than
   *  producing one. Shown as a badge so the history says what happened. */
  rollbackOf?: string | null;
}

/**
 * The deployments table with multi-select DELETION. Sorting is pure ordering - it
 * never changes the swept set. Only FINISHED deployments (ready/error/canceled)
 * are selectable; an in-progress one must be canceled first.
 */
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
  /** Rendered first in the header row's right-hand cluster, before the bulk
   *  actions - an app's page puts its settings shortcut there. */
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
   *  own prop: the Rollback item greys out rather than vanishing, and the data
   *  layer re-checks it either way. */
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
  const [serverFilter, setServerFilter] = React.useState<string | null>(null);
  const [appFilter, setAppFilter] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] =
    React.useState<DeploymentStatus | null>(null);
  const [envFilter, setEnvFilter] =
    React.useState<DeploymentEnvironment | null>(null);
  const [dateFilter, setDateFilter] = React.useState<string | null>(null);
  // One "now" for the whole mount: reading the clock during render is impure, and
  // a Created window whose edge slides between two renders would reshuffle the
  // table under the reader for no reason.
  const [now] = React.useState(() => Date.now());
  const [query, setQuery] = React.useState("");
  const [sortDir, setSortDir] = React.useState<SortDir>("newest");
  // How many of the filtered rows the table currently renders. Grows in PAGE_SIZE
  // steps as the sentinel below the last row scrolls into view (endless scroll),
  // and resets whenever the filtered set itself changes.
  const [shown, setShown] = React.useState(PAGE_SIZE);

  // Live Status chips: overlays the in-flight build's status onto its row so the
  // badge tracks queued → building → ready/error without a reload (both pages).
  const liveStatusOf = useLiveDeploymentStatuses(deployments);

  // Distinct servers / apps present in the current rows - the filter options.
  // Derived from ALL rows (not the filtered view) so each dropdown stays stable
  // while the other filter narrows the table.
  const serverOptions = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const d of deployments)
      if (d.serverId && !m.has(d.serverId))
        m.set(d.serverId, d.serverName ?? d.serverId);
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
  // Which Created windows actually hold rows - same "auto-hide until it offers a
  // real choice" rule as the other narrowers. Options and matching share the one
  // `now`, so the edges can't drift between the menu and the rows it filters.
  const { dateOptions, dateMatches } = React.useMemo(() => {
    const matches = (d: DeploymentRow, value: string) =>
      matchesDateWindow(d.createdAt, value, now);
    const options = [
      ...DATE_WINDOWS.map((w) => ({ value: w.value, label: w.label })),
      { value: OLDER, label: OLDER_LABEL },
    ].filter((o) => deployments.some((d) => matches(d, o.value)));
    return { dateOptions: options, dateMatches: matches };
  }, [deployments, now]);

  // One lowercased haystack per row, rebuilt only when the rows do, so typing
  // re-runs a substring test, not a re-serialization of the whole history.
  const haystacks = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const d of remaining) m.set(d.id, searchHaystack(d));
    return m;
  }, [remaining]);
  // Every word of the needle has to appear somewhere in the row, in any order:
  // "github deploy" and "abc123 preview" both narrow the way you'd expect.
  const terms = React.useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

  // Reconcile the chosen filters against what's still present (a refresh may have
  // dropped the last row on a server/app). Done in render, no effect, so a
  // now-empty filter simply behaves as "All" without a stale, un-clearable value.
  const effectiveServerFilter =
    serverFilter && serverOptions.some((s) => s.id === serverFilter)
      ? serverFilter
      : null;
  const effectiveAppFilter =
    appFilter && appOptions.some((s) => s.id === appFilter) ? appFilter : null;
  const effectiveStatusFilter =
    statusFilter && statusOptions.includes(statusFilter) ? statusFilter : null;
  const effectiveEnvFilter =
    envFilter && envOptions.includes(envFilter) ? envFilter : null;
  const effectiveDateFilter =
    dateFilter && dateOptions.some((o) => o.value === dateFilter)
      ? dateFilter
      : null;
  // Search and Created are CLIENT-only narrowers: unlike the four above they have
  // no equivalent in the server-side sweep args, which is what makes the bulk
  // buttons switch to an explicit id list while either is active (see `deleteAll`).
  const hasClientNarrower = terms.length > 0 || effectiveDateFilter != null;
  const hasFilter =
    effectiveServerFilter != null ||
    effectiveAppFilter != null ||
    effectiveStatusFilter != null ||
    effectiveEnvFilter != null ||
    hasClientNarrower;

  // The rows matching the filters - everything downstream (selection, counts, bulk
  // scope) keys off this so the buttons act on exactly what's in scope.
  const visible = React.useMemo(
    () =>
      remaining.filter(
        (d) =>
          (!effectiveServerFilter || d.serverId === effectiveServerFilter) &&
          (!effectiveAppFilter || d.appId === effectiveAppFilter) &&
          (!effectiveStatusFilter || d.status === effectiveStatusFilter) &&
          (!effectiveEnvFilter || d.environment === effectiveEnvFilter) &&
          (!effectiveDateFilter || dateMatches(d, effectiveDateFilter)) &&
          terms.every((t) => haystacks.get(d.id)?.includes(t)),
      ),
    [
      remaining,
      effectiveServerFilter,
      effectiveAppFilter,
      effectiveStatusFilter,
      effectiveEnvFilter,
      effectiveDateFilter,
      dateMatches,
      terms,
      haystacks,
    ],
  );

  // The Created sort is a VIEW concern over the already-filtered set.
  // Selection/counts key off `visible` (order-free), so only the rendered page reads
  // from `sorted`.
  const sorted = React.useMemo(
    () => (sortDir === "oldest" ? [...visible].reverse() : visible),
    [visible, sortDir],
  );

  // Endless scroll over the filtered+sorted set: the table renders the first `shown`
  // rows and the sentinel below it asks for the next batch as it comes into view.
  const paged = sorted.slice(0, Math.min(shown, sorted.length));
  const hasMore = sorted.length > paged.length;
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    // rootMargin so the next batch is already in the DOM by the time the last row
    // reaches the fold - the scroll never actually stops at the bottom.
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setShown((n) => n + PAGE_SIZE);
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // `shown` is in the deps on purpose: an observer whose target is STILL in view
    // after a batch lands never fires again (no threshold crossing), so a tall
    // viewport would stall one batch in. Re-observing re-fires immediately.
  }, [hasMore, shown]);

  const selectableIds = React.useMemo(
    () => visible.filter((d) => !IN_PROGRESS.has(d.status)).map((d) => d.id),
    [visible],
  );
  // In-progress (queued/building) deployments in the visible scope - the "Stop all
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

  // Keep the selection honest across refreshes and filter changes: drop ids that are
  // gone, filtered out, or no longer selectable (e.g. a row that started building).
  // Render-time via the previous-value pattern, never cascades a re-render.
  const effectiveSelected = React.useMemo(
    () => [...selected].filter((id) => selectableSet.has(id)),
    [selected, selectableSet],
  );
  const selectedCount = effectiveSelected.length;

  const allSelected =
    selectableIds.length > 0 && selectedCount === selectableIds.length;
  const someSelected = selectedCount > 0 && !allSelected;

  // The scope the bulk sweeps target: the app page pins one app; the global page
  // follows the active filters.
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
    effectiveDateFilter
      ? (dateOptions.find((o) => o.value === effectiveDateFilter)?.label ??
        null)
      : null,
    terms.length > 0 ? `matching "${query.trim()}"` : null,
  ].filter(Boolean);
  const scopeText =
    scopeQualifiers.length > 0
      ? `${scopeWho} (${scopeQualifiers.join(", ")})`
      : scopeWho;

  // Every filter change collapses the endless scroll back to one batch, otherwise
  // a narrowed list would keep rendering however deep the previous scroll had got.
  function applyServerFilter(v: string) {
    setServerFilter(v === ALL ? null : v);
    setShown(PAGE_SIZE);
  }
  function applyAppFilter(v: string) {
    setAppFilter(v === ALL ? null : v);
    setShown(PAGE_SIZE);
  }
  function applyStatusFilter(v: string) {
    setStatusFilter(v === ALL ? null : (v as DeploymentStatus));
    setShown(PAGE_SIZE);
  }
  function applyEnvFilter(v: string) {
    setEnvFilter(v === ALL ? null : (v as DeploymentEnvironment));
    setShown(PAGE_SIZE);
  }
  function applyDateFilter(v: string) {
    setDateFilter(v === ALL ? null : v);
    setShown(PAGE_SIZE);
  }
  function applyQuery(v: string) {
    setQuery(v);
    setShown(PAGE_SIZE);
  }
  // Re-sorting starts the scroll over so the newly-first rows are the ones in view.
  function applySort(v: string) {
    setSortDir(v as SortDir);
    setShown(PAGE_SIZE);
  }
  // "Clear filters" resets the narrowing filters only; the Created sort is an
  // ordering, not a filter, so it deliberately stays put.
  function clearFilters() {
    setServerFilter(null);
    setAppFilter(null);
    setStatusFilter(null);
    setEnvFilter(null);
    setDateFilter(null);
    setQuery("");
    setShown(PAGE_SIZE);
  }

  // Whole-row navigation: clicking a row anywhere that isn't a dedicated control
  // opens that deployment (its build logs & details) - the same destination as the
  // row's ScrollText button and its commit-message link.
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
            environment: sweepEnv,
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
    // args can't express the view, so each build in view is stopped by id. There
    // are only ever a handful in flight, so the fan-out stays small.
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
  // Environment and Sort surface wherever the rows warrant them - the app's own
  // history included.
  const showServerFilter = showServer && serverOptions.length >= 1;
  const showAppFilter = showServer && appOptions.length >= 2;
  const showStatusFilter = statusOptions.length >= 2;
  const showEnvFilter = envOptions.length >= 2;
  const showDateFilter = dateOptions.length >= 2;
  // Search earns its place the moment there is more than one row to tell apart.
  const showSearch = deployments.length > 1;
  const showSort = deployments.length > 1;
  // Any actual narrower present? The funnel glyph rides on this, not on the whole
  // bar, so a sort-only row (e.g. an app whose history is all one status+env)
  // doesn't display a filter icon over a control that only sorts.
  const showNarrowers =
    showServerFilter ||
    showAppFilter ||
    showStatusFilter ||
    showEnvFilter ||
    showDateFilter;
  const showStopAll = canManage && inProgressCount > 0;
  // Bulk delete sits with the sort, not in the header: it acts on what the row
  // above it narrowed down to.
  const showDeleteAll = canManage && selectableIds.length > 0;
  const showFilters = showNarrowers || showSearch || showSort || showDeleteAll;

  return (
    <div className="space-y-4">
      {/* Header: title/subtitle on the left, `actions` then the bulk-action
          buttons on the right. The buttons are hidden when the caller can't manage. */}
      {(header || actions || showStopAll) && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">{header}</div>
          {(actions || showStopAll) && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {actions}
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
            </div>
          )}
        </div>
      )}

      {/**
       * Filters + Created sort on one wrapping row.
       */}
      {showFilters && (
        <div className="flex min-h-9 flex-wrap items-center gap-2">
          {showSearch && (
            <div className="relative w-full min-w-0 sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => applyQuery(e.target.value)}
                placeholder="Search deployments"
                aria-label="Search deployments"
                className="h-9 pl-9"
              />
            </div>
          )}
          {showNarrowers && (
            <ListFilter className="size-4 text-muted-foreground" />
          )}
          {showServerFilter && (
            <Select
              value={effectiveServerFilter ?? ALL}
              onValueChange={applyServerFilter}
            >
              <SelectTrigger
                className="w-[170px]"
                aria-label="Filter by server"
              >
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
              <SelectTrigger
                className="w-[150px]"
                aria-label="Filter by status"
              >
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
          {showDateFilter && (
            <Select
              value={effectiveDateFilter ?? ALL}
              onValueChange={applyDateFilter}
            >
              <SelectTrigger
                className="w-[205px]"
                aria-label="Filter by created date"
              >
                {/* Same `flex!` trick as the sort trigger below - see the note
                    there for why the plain class loses to `line-clamp-1`. */}
                <span className="flex! items-center gap-2">
                  <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any time</SelectItem>
                {dateOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {hasFilter && (
            <Button variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
          {/* Delete all + the sort travel together to the right edge. */}
          {(showDeleteAll || showSort) && (
            <div
              className={cn(
                "flex items-center gap-2",
                showNarrowers && "sm:ml-auto",
              )}
            >
              {showDeleteAll && (
                <Button
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteAllOpen(true)}
                >
                  <Trash2 className="size-4" />
                  Delete all
                </Button>
              )}
              {showSort && (
                <Select value={sortDir} onValueChange={applySort}>
                  <SelectTrigger
                    className="w-[150px]"
                    aria-label="Sort by created date"
                  >
                    {/**
                     * `flex!` is load-bearing: SelectTrigger applies `[&>span]:line-clamp-1` to its
                     * direct-child spans, whose `display:-webkit-box` outranks a plain `flex` class
                     * (the `>span` selector is more specific) and would stack the icon above the value.
                     */}
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
                  {hasFilter
                    ? "No deployments match the filters."
                    : "No deployments."}
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
                      /* The checkbox cell opts out of row navigation entirely -
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
                              onCheckedChange={(v) =>
                                toggleRow(d.id, v === true)
                              }
                              aria-label={`Select deployment ${d.commitSha}`}
                            />
                          </span>
                        </SimpleTooltip>
                      </TableCell>
                    )}

                    <TableCell className="max-w-[280px]">
                      {/* The commit message is a real link to the deployment -
                          the keyboard/screen-reader path to what the whole row
                          does on click (a <tr> can't be a link itself). */}
                      <Link
                        href={`/apps/${d.appSlug}/deployments/${d.id}`}
                        className="block truncate font-medium text-foreground hover:underline focus-visible:underline"
                      >
                        {d.commitMessage}
                      </Link>
                      <span className="flex items-center gap-1.5">
                        <CommitLink
                          sha={d.commitSha}
                          url={d.commitUrl}
                          className="font-mono text-xs text-muted-foreground"
                        />
                        {/**
                         * This build did not produce its code - it went BACK to it.
                         */}
                        {d.rollbackOf ? (
                          <SimpleTooltip content="This deployment put the app back on an earlier build">
                            <Badge
                              variant="outline"
                              className="gap-1 px-1.5 py-0 text-xs font-normal"
                            >
                              <Undo2 className="size-3" />
                              Rollback
                            </Badge>
                          </SimpleTooltip>
                        ) : null}
                      </span>
                    </TableCell>

                    {showApp && (
                      <TableCell>
                        {/* On the global page the App name opens THIS row's build
                            logs (its deployment detail), not the app overview -
                            the fastest path from "which build is this?" to its logs. */}
                        <SimpleTooltip content="Open this deployment's build logs">
                          <Link
                            href={`/apps/${d.appSlug}/deployments/${d.id}`}
                            className="flex cursor-pointer items-center gap-2 font-medium text-foreground hover:underline"
                          >
                            <AppLogo logo={d.appLogo ?? null} size={20} />
                            <span className="truncate">{d.serviceName}</span>
                          </Link>
                        </SimpleTooltip>
                      </TableCell>
                    )}

                    {showServer && (
                      <TableCell>
                        {d.serverName ? (
                          // The BUILD server rides in the tooltip rather than a column of its own: it is null
                          // for almost every row, and a mostly-empty column is a worse way to say "this one
                          // is different" than a mark on the one cell that already names a host.
                          <SimpleTooltip
                            content={
                              d.buildServerName
                                ? `Built on ${d.buildServerName}, then released here`
                                : `Built and released on ${d.serverName}`
                            }
                          >
                            <span className="flex items-center gap-1.5 text-muted-foreground">
                              {/* Only the build-server mark is drawn. A server
                                  glyph on every ordinary row repeated what the
                                  column header already says. */}
                              {d.buildServerName && (
                                <Hammer className="size-3.5 shrink-0" />
                              )}
                              <span className="truncate">{d.serverName}</span>
                            </span>
                          </SimpleTooltip>
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
                          d.environment === "production"
                            ? "default"
                            : "secondary"
                        }
                        className="capitalize"
                      >
                        {d.environment}
                      </Badge>
                      {/* Which pull request this preview came from. Read off the
                          deployment's own denormalized number, so it survives
                          the preview being reaped. */}
                      {d.prNumber ? (
                        <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                          #{d.prNumber}
                        </span>
                      ) : null}
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
                      <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                        {d.creatorUser && (
                          <UserAvatar
                            name={d.creatorUser.name}
                            username={d.creatorUser.username}
                            avatarColor={d.creatorUser.avatarColor}
                            avatarUrl={d.creatorUser.avatarUrl}
                            size="xs"
                          />
                        )}
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
                        pullRequestUrl={d.pullRequestUrl}
                        canDelete={canManage}
                        canDeploy={canManage}
                        canRollback={d.canRollback}
                        canRollbackApps={canRollbackApps}
                        commitSha={d.commitSha}
                        commitMessage={d.commitMessage}
                        onRemoved={() => remove(d.id)}
                        onRestored={() => restore(d.id)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Endless scroll: the sentinel loads the next batch as it nears the fold,
          and the count says where you are in the filtered set. Both only exist
          while there is more than one batch to show. */}
      {(hasMore || paged.length > PAGE_SIZE) && (
        <div className="flex items-center justify-center">
          <div ref={sentinelRef} aria-hidden className="h-px w-px" />
          <span className="text-sm text-muted-foreground">
            Showing {paged.length} of {visible.length}
          </span>
        </div>
      )}

      {/**
       * Multi-select action bar - floats at the bottom-center of the viewport whenever
       * one or more finished deployments are checked.
       */}
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
        description="The selected deployments and their build logs are permanently removed. Running apps are unaffected, but this can't be undone."
        confirmLabel="Delete"
        optimistic
        onConfirm={deleteSelected}
      />
      <ConfirmAction
        open={deleteAllOpen}
        onOpenChange={setDeleteAllOpen}
        title={`Delete ${selectableIds.length} finished deployment${selectableIds.length === 1 ? "" : "s"}?`}
        description={`Every finished deployment for ${scopeText} (and its build logs) is permanently removed. In-progress builds are left. Running apps are unaffected, but this can't be undone.`}
        confirmLabel="Delete all"
        optimistic
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
