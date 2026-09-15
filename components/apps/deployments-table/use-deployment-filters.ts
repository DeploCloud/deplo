"use client";

import * as React from "react";
import { STATUS_ORDER, STATUS_LABELS } from "./deployment-status";
import type { DeploymentRow } from "./deployment-row";
import type { DeploymentStatus } from "@/lib/types/deployment";

export const ALL = "__all__";

export const PAGE_SIZE = 25;

const DAY = 86_400_000;
const DATE_WINDOWS: { value: string; label: string; within: number }[] = [
  { value: "24h", label: "Last 24 hours", within: DAY },
  { value: "7d", label: "Last 7 days", within: 7 * DAY },
  { value: "30d", label: "Last 30 days", within: 30 * DAY },
];
const OLDER = "older";
const OLDER_LABEL = "More than 30 days ago";

export function matchesDateWindow(
  createdAt: string,
  value: string,
  now: number,
): boolean {
  const age = now - new Date(createdAt).getTime();
  const w = DATE_WINDOWS.find((x) => x.value === value);
  return w ? age <= w.within : age > 30 * DAY;
}

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

type SortDir = "newest" | "oldest";

export type DeploymentFilters = ReturnType<typeof useDeploymentFilters>;

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
  const [now] = React.useState(() => Date.now());
  const [query, setQuery] = React.useState("");
  const [sortDir, setSortDir] = React.useState<SortDir>("newest");
  const [shown, setShown] = React.useState(PAGE_SIZE);

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
  const { dateOptions, dateMatches } = React.useMemo(() => {
    const matches = (d: DeploymentRow, value: string) =>
      matchesDateWindow(d.createdAt, value, now);
    const options = [
      ...DATE_WINDOWS.map((w) => ({ value: w.value, label: w.label })),
      { value: OLDER, label: OLDER_LABEL },
    ].filter((o) => deployments.some((d) => matches(d, o.value)));
    return { dateOptions: options, dateMatches: matches };
  }, [deployments, now]);

  const haystacks = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const d of remaining) m.set(d.id, searchHaystack(d));
    return m;
  }, [remaining]);
  const terms = React.useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

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
  const hasClientNarrower = terms.length > 0 || effectiveDateFilter != null;
  const hasFilter =
    effectiveServerFilter != null ||
    effectiveAppFilter != null ||
    effectiveStatusFilter != null ||
    hasClientNarrower;

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
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setShown((n) => n + PAGE_SIZE);
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // `shown` is a dep on purpose: a sentinel still in view never crosses the threshold again.
  }, [hasMore, shown]);

  const sweepAppId = scopeAppId ?? effectiveAppFilter ?? null;
  const sweepServerId = effectiveServerFilter ?? null;
  const sweepStatus = effectiveStatusFilter ?? null;
  const activeAppName = effectiveAppFilter
    ? (appOptions.find((s) => s.id === effectiveAppFilter)?.name ?? null)
    : null;
  const activeServerName = effectiveServerFilter
    ? (serverOptions.find((s) => s.id === effectiveServerFilter)?.name ?? null)
    : null;
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
  function applySort(v: string) {
    setSortDir(v as SortDir);
    setShown(PAGE_SIZE);
  }
  function clearFilters() {
    setServerFilter(null);
    setAppFilter(null);
    setStatusFilter(null);
    setDateFilter(null);
    setQuery("");
    setShown(PAGE_SIZE);
  }

  const showServerFilter = showServer && serverOptions.length >= 1;
  const showAppFilter = showServer && appOptions.length >= 2;
  const showStatusFilter = statusOptions.length >= 2;
  const showDateFilter = dateOptions.length >= 2;
  const showSearch = deployments.length > 1;
  const showSort = deployments.length > 1;
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
