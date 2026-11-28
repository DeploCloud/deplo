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
const DATE_OPTIONS = [
  ...DATE_WINDOWS.map((w) => ({ value: w.value, label: w.label })),
  { value: OLDER, label: "More than 30 days ago" },
];

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

export type DeploymentFacet = "server" | "app" | "status" | "date";
type Picked = Record<DeploymentFacet, string[]>;
const NONE: Picked = { server: [], app: [], status: [], date: [] };

// The server sweeps one app, server and status at most; more than one of any goes by ids.
export function serverSweep(
  picked: Pick<Picked, "app" | "server" | "status">,
  scopeAppId?: string,
): {
  appId: string | null;
  serverId: string | null;
  status: string | null;
} | null {
  if (
    picked.app.length > 1 ||
    picked.server.length > 1 ||
    picked.status.length > 1
  )
    return null;
  return {
    appId: scopeAppId ?? picked.app[0] ?? null,
    serverId: picked.server[0] ?? null,
    status: picked.status[0] ?? null,
  };
}

const plural = (n: number, noun: string) => (n === 1 ? noun : `${noun}s`);

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
  const [picked, setPicked] = React.useState<Picked>(NONE);
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
    const m = new Map<string, { name: string; logo?: string | null }>();
    for (const d of deployments)
      if (!m.has(d.appId))
        m.set(d.appId, { name: d.serviceName || d.appId, logo: d.appLogo });
    return [...m]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [deployments]);
  const dateMatches = React.useCallback(
    (d: DeploymentRow, value: string) =>
      matchesDateWindow(d.createdAt, value, now),
    [now],
  );

  const counts = React.useMemo(() => {
    const out: Record<DeploymentFacet, Record<string, number>> = {
      server: {},
      app: {},
      status: {},
      date: {},
    };
    const bump = (k: DeploymentFacet, v: string) =>
      (out[k][v] = (out[k][v] ?? 0) + 1);
    for (const d of deployments) {
      if (d.serverId) bump("server", d.serverId);
      bump("app", d.appId);
      bump("status", d.status);
      for (const o of DATE_OPTIONS)
        if (dateMatches(d, o.value)) bump("date", o.value);
    }
    return out;
  }, [deployments, dateMatches]);

  const haystacks = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const d of remaining) m.set(d.id, searchHaystack(d));
    return m;
  }, [remaining]);
  const terms = React.useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

  // A server or app whose rows are all gone leaves the list, so it filters nothing either.
  const effective = React.useMemo<Picked>(
    () => ({
      ...picked,
      server: picked.server.filter((v) =>
        serverOptions.some((s) => s.id === v),
      ),
      app: picked.app.filter((v) => appOptions.some((s) => s.id === v)),
    }),
    [picked, serverOptions, appOptions],
  );
  const sweep = serverSweep(effective, scopeAppId);
  const hasClientNarrower =
    terms.length > 0 || effective.date.length > 0 || sweep === null;
  const hasFilter =
    terms.length > 0 || Object.values(effective).some((v) => v.length > 0);

  const visible = React.useMemo(
    () =>
      remaining.filter(
        (d) =>
          (effective.server.length === 0 ||
            effective.server.includes(d.serverId ?? "")) &&
          (effective.app.length === 0 || effective.app.includes(d.appId)) &&
          (effective.status.length === 0 ||
            effective.status.includes(d.status)) &&
          (effective.date.length === 0 ||
            effective.date.some((v) => dateMatches(d, v))) &&
          terms.every((t) => haystacks.get(d.id)?.includes(t)),
      ),
    [remaining, effective, dateMatches, terms, haystacks],
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

  const nameOf = (opts: { id: string; name: string }[], id: string) =>
    opts.find((o) => o.id === id)?.name ?? id;
  const appNames = effective.app.map((id) => nameOf(appOptions, id));
  const serverNames = effective.server.map((id) => nameOf(serverOptions, id));
  const appPart = appNames.length
    ? `${plural(appNames.length, "app")} ${appNames.join(", ")}`
    : null;
  const serverPart = serverNames.length
    ? `${plural(serverNames.length, "server")} ${serverNames.join(", ")}`
    : null;
  const scopeWho = scopeAppId
    ? "this app"
    : appPart && serverPart
      ? `${appPart} on ${serverPart}`
      : (appPart ?? serverPart ?? "all your apps");
  const scopeQualifiers = [
    effective.status.length
      ? effective.status
          .map((s) => STATUS_LABELS[s as DeploymentStatus])
          .join(" or ")
      : null,
    effective.date.length
      ? effective.date
          .map((v) => DATE_OPTIONS.find((o) => o.value === v)?.label ?? v)
          .join(" or ")
      : null,
    terms.length > 0 ? `matching "${query.trim()}"` : null,
  ].filter(Boolean);
  const scopeText =
    scopeQualifiers.length > 0
      ? `${scopeWho} (${scopeQualifiers.join(", ")})`
      : scopeWho;

  function applyFacet(key: DeploymentFacet, values: string[]) {
    setPicked((p) => ({ ...p, [key]: values }));
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
  function clearFacets() {
    setPicked(NONE);
    setShown(PAGE_SIZE);
  }

  return {
    query,
    sortDir,
    statusOptions: STATUS_ORDER,
    dateOptions: DATE_OPTIONS,
    serverOptions: showServer ? serverOptions : [],
    appOptions: showServer ? appOptions : [],
    counts,
    picked: effective,
    hasClientNarrower,
    hasFilter,
    visible,
    sorted,
    paged,
    hasMore,
    sentinelRef,
    sweepAppId: sweep?.appId ?? null,
    sweepServerId: sweep?.serverId ?? null,
    sweepStatus: sweep?.status ?? null,
    scopeText,
    applyFacet,
    applyQuery,
    applySort,
    clearFacets,
  };
}
