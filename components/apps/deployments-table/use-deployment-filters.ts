"use client";

import * as React from "react";
import { STATUS_ORDER, STATUS_LABELS } from "./deployment-status";
import type { DeploymentRow } from "./deployment-row";
import type { DeploymentStatus } from "@/lib/types/deployment";

// ALL is the sentinel for the "no filter" option - shadcn `SelectItem` can't hold "".
export const ALL = "__all__";

// PAGE_SIZE is how many rows the table renders up front, and how many more each
// time the sentinel scrolls into view. The whole set is already in memory.
export const PAGE_SIZE = 25;

const DAY = 86_400_000;
const DATE_WINDOWS: { value: string; label: string; within: number }[] = [
  { value: "24h", label: "Last 24 hours", within: DAY },
  { value: "7d", label: "Last 7 days", within: 7 * DAY },
  { value: "30d", label: "Last 30 days", within: 30 * DAY },
];
const OLDER = "older";
const OLDER_LABEL = "More than 30 days ago";

// matchesDateWindow answers whether a row falls in the chosen Created window.
// `now` is passed in so every option of one pass measures against one instant.
export function matchesDateWindow(
  createdAt: string,
  value: string,
  now: number,
): boolean {
  const age = now - new Date(createdAt).getTime();
  const w = DATE_WINDOWS.find((x) => x.value === value);
  return w ? age <= w.within : age > 30 * DAY;
}

// searchHaystack is everything a row can be found by, as one lowercased string:
// its id, app, server, commit, pull request and who ran it.
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
    d.creatorProvider,
    d.status,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// Newest-first matches the server's ordering (the default); oldest-first is the
// exact reverse of the fully-ordered set.
type SortDir = "newest" | "oldest";

// DeploymentFilters is what the filter bar reads and what the table renders from.
export type DeploymentFilters = ReturnType<typeof useDeploymentFilters>;

// useDeploymentFilters owns the search, the narrowers, the Created sort and the
// endless-scroll window, and derives the rows the table actually shows.
export function useDeploymentFilters({
  deployments,
  remaining,
  scopeAppId,
  showServer,
}: {
  deployments: DeploymentRow[];
  remaining: DeploymentRow[];
  scopeAppId?: string;
  showServer: boolean;
}) {
  const [serverFilter, setServerFilter] = React.useState<string | null>(null);
  const [appFilter, setAppFilter] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] =
    React.useState<DeploymentStatus | null>(null);
  const [dateFilter, setDateFilter] = React.useState<string | null>(null);
  // One "now" for the whole mount: reading the clock during render is impure, and
  // a Created window whose edge slides between two renders would reshuffle the
  // table under the reader for no reason.
  const [now] = React.useState(() => Date.now());
  const [query, setQuery] = React.useState("");
  const [sortDir, setSortDir] = React.useState<SortDir>("newest");
  const [shown, setShown] = React.useState(PAGE_SIZE);

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
  const statusOptions = React.useMemo(() => {
    const present = new Set(deployments.map((d) => d.status));
    return STATUS_ORDER.filter((s) => present.has(s));
  }, [deployments]);
  // Options and matching share the one `now`, so the edges can't drift between
  // the menu and the rows it filters.
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
  // Every word of the needle has to appear somewhere in the row, in any order.
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
  const effectiveDateFilter =
    dateFilter && dateOptions.some((o) => o.value === dateFilter)
      ? dateFilter
      : null;
  // Search and Created are CLIENT-only narrowers: unlike the four above they have
  // no equivalent in the server-side sweep args, which is what makes the bulk
  // buttons switch to an explicit id list while either is active.
  const hasClientNarrower = terms.length > 0 || effectiveDateFilter != null;
  const hasFilter =
    effectiveServerFilter != null ||
    effectiveAppFilter != null ||
    effectiveStatusFilter != null ||
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
          (!effectiveDateFilter || dateMatches(d, effectiveDateFilter)) &&
          terms.every((t) => haystacks.get(d.id)?.includes(t)),
      ),
    [
      remaining,
      effectiveServerFilter,
      effectiveAppFilter,
      effectiveStatusFilter,
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

  // The scope the bulk sweeps target: the app page pins one app; the global page
  // follows the active filters.
  const sweepAppId = scopeAppId ?? effectiveAppFilter ?? null;
  const sweepServerId = effectiveServerFilter ?? null;
  const sweepStatus = effectiveStatusFilter ?? null;
  const activeAppName = effectiveAppFilter
    ? (appOptions.find((s) => s.id === effectiveAppFilter)?.name ?? null)
    : null;
  const activeServerName = effectiveServerFilter
    ? (serverOptions.find((s) => s.id === effectiveServerFilter)?.name ?? null)
    : null;
  // Human-readable scope for the confirm dialogs, mirroring the sweep args.
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
    setDateFilter(null);
    setQuery("");
    setShown(PAGE_SIZE);
  }

  // Server/App narrowers only exist on the global page (showServer); Status and
  // Sort surface wherever the rows warrant them - the app's own history included.
  const showServerFilter = showServer && serverOptions.length >= 1;
  const showAppFilter = showServer && appOptions.length >= 2;
  const showStatusFilter = statusOptions.length >= 2;
  const showDateFilter = dateOptions.length >= 2;
  // Search earns its place the moment there is more than one row to tell apart.
  const showSearch = deployments.length > 1;
  const showSort = deployments.length > 1;
  // Any actual narrower present? The funnel glyph rides on this, not on the whole
  // bar, so a sort-only row doesn't display a filter icon over a control that
  // only sorts.
  const showNarrowers =
    showServerFilter || showAppFilter || showStatusFilter || showDateFilter;
  const showFilters = showNarrowers || showSearch || showSort;

  return {
    query,
    sortDir,
    serverOptions,
    appOptions,
    statusOptions,
    dateOptions,
    effectiveServerFilter,
    effectiveAppFilter,
    effectiveStatusFilter,
    effectiveDateFilter,
    hasClientNarrower,
    hasFilter,
    visible,
    paged,
    hasMore,
    sentinelRef,
    sweepAppId,
    sweepServerId,
    sweepStatus,
    scopeText,
    applyServerFilter,
    applyAppFilter,
    applyStatusFilter,
    applyDateFilter,
    applyQuery,
    applySort,
    clearFilters,
    showServerFilter,
    showAppFilter,
    showStatusFilter,
    showDateFilter,
    showSearch,
    showSort,
    showNarrowers,
    showFilters,
  };
}
