"use client";

import * as React from "react";
import {
  AppWindow,
  ChevronRight,
  CircleDot,
  Shapes,
  Users,
} from "lucide-react";

import Link from "@/components/ui/link";
import { EmptyState } from "@/components/shared/empty-state";
import { Bone } from "@/components/ui/skeleton";
import { ListToolbar } from "@/components/shared/list-toolbar";
import { AppLogo } from "@/components/shared/project-logo";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { StatusIndicator } from "@/components/apps/app-status-dot/status-renderer";
import { DB_LOGOS, DB_NAMES } from "@/components/storage/db-engines";
import { FilterFacet, useUrlFacets } from "@/components/shared/filter-facet";
import { countBy, teamFacetOptions } from "@/components/shared/facet-filtering";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { gqlAction } from "@/lib/graphql-client";
import {
  filterWorkloads,
  KIND_OPTIONS,
  STATUS_OPTIONS,
  statusGroup,
} from "@/components/servers/workload-filter";
import { cn, formatBytes } from "@/lib/utils";
import type { DatabaseType } from "@/lib/types/database";
import type {
  ServerWorkload,
  WorkloadContainer,
} from "@/lib/data/servers/workloads";

const WORKLOADS = /* GraphQL */ `
  query ServerWorkloads($id: String!) {
    serverWorkloads(id: $id) {
      id
      kind
      name
      logo
      logoTone
      engine
      teamName
      teamSlug
      teamAvatarUrl
      href
      project
      environment
      status
      cpu
      memUsed
      restarts
      containers {
        name
        state
        health
        cpu
        memUsed
        restartCount
      }
    }
  }
`;

const POLL_MS = 5_000;
const FACETS = ["team", "status", "type"] as const;

// Hidden below md so a phone keeps name, status and team.
const WIDE = "hidden md:table-cell";

export function ServerWorkloads({
  serverId,
  initial,
}: {
  serverId: string;
  initial?: ServerWorkload[];
}) {
  const [rows, setRows] = React.useState(initial ?? null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = useUrlFacets(FACETS);
  const [open, setOpen] = React.useState<Set<string>>(() => new Set());

  React.useEffect(() => {
    let active = true;
    let busy = false;
    const controller = new AbortController();
    async function refresh() {
      if (document.visibilityState !== "visible" || busy) return;
      busy = true;
      const res = await gqlAction<{ serverWorkloads: ServerWorkload[] }>(
        WORKLOADS,
        { id: serverId },
        undefined,
        { signal: controller.signal },
      );
      busy = false;
      if (!active) return;
      if (res.ok && res.data) {
        setRows(res.data.serverWorkloads);
        setError(null);
      } else if (!res.ok) {
        setError(res.error);
      }
    }
    void refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [serverId]);

  if (rows === null && error)
    return (
      <div role="alert">
        <EmptyState
          icon={AppWindow}
          title="Could not load apps"
          description={error}
        />
      </div>
    );

  // Until the first answer, the real toolbar and table over placeholder rows.
  const loading = rows === null;
  const list = rows ?? PLACEHOLDER_WORKLOADS;

  if (list.length === 0)
    return (
      <EmptyState
        icon={AppWindow}
        title="Nothing on this server"
        description="Apps and databases placed here show up with their live status."
      />
    );

  const shown = filterWorkloads(list, {
    query,
    statuses: picked.status,
    kinds: picked.type,
    teams: picked.team,
  });
  const teams = teamFacetOptions(
    list.map((w) => [
      { slug: w.teamSlug, name: w.teamName, avatarUrl: w.teamAvatarUrl },
    ]),
  );

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  return (
    <div
      className="space-y-3"
      inert={loading || undefined}
      aria-busy={loading || undefined}
    >
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ListToolbar
        query={query}
        onQuery={setQuery}
        placeholder="Search apps or teams"
        filters={
          <>
            <FilterFacet
              id="team"
              label="Team"
              allLabel="Any team"
              icon={Users}
              options={teams.options}
              counts={teams.counts}
              values={picked.team}
              onChange={(v) => setPicked("team", v)}
            />
            <FilterFacet
              id="status"
              label="Status"
              allLabel="Any status"
              icon={CircleDot}
              options={STATUS_OPTIONS}
              counts={countBy(list, (w) => statusGroup(w) ?? "")}
              values={picked.status}
              onChange={(v) => setPicked("status", v)}
            />
            <FilterFacet
              id="type"
              label="Type"
              allLabel="Any type"
              icon={Shapes}
              options={KIND_OPTIONS}
              counts={countBy(list, (w) => w.kind)}
              values={picked.type}
              onChange={(v) => setPicked("type", v)}
            />
          </>
        }
      />

      <div className="overflow-x-auto rounded-xl border border-border">
        <Table className="table-fixed whitespace-nowrap">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Name</TableHead>
              <TableHead className="hidden w-28 sm:table-cell">Type</TableHead>
              <TableHead className="hidden sm:table-cell">Team</TableHead>
              <TableHead className={WIDE}>Project</TableHead>
              <TableHead className="w-32">Status</TableHead>
              <TableHead className={cn(WIDE, "w-16 text-right")}>CPU</TableHead>
              <TableHead className={cn(WIDE, "w-20 text-right")}>
                Memory
              </TableHead>
              <TableHead className={cn(WIDE, "w-20 text-right")}>
                Restarts
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="py-8 text-center text-muted-foreground"
                >
                  Nothing matches these filters.
                </TableCell>
              </TableRow>
            )}
            {shown.map((w) => (
              <WorkloadRows
                key={w.id}
                workload={w}
                open={open.has(w.id)}
                onToggle={() => toggle(w.id)}
                loading={loading}
              />
            ))}
          </TableBody>
        </Table>
        {loading && (
          <span role="status" className="sr-only">
            Loading apps
          </span>
        )}
      </div>
    </div>
  );
}

function WorkloadRows({
  workload: w,
  open,
  onToggle,
  loading = false,
}: {
  workload: ServerWorkload;
  open: boolean;
  onToggle: () => void;
  loading?: boolean;
}) {
  const engine = w.engine as DatabaseType | null;
  const logo = w.logo ?? (engine ? DB_LOGOS[engine] : null);
  const name = (
    <span className="flex items-center gap-2.5">
      <Bone box loading={loading} className="shrink-0">
        <AppLogo logo={logo ?? null} tone={w.logoTone} size={24} />
      </Bone>
      <Bone box loading={loading} className="min-w-0">
        <WorkloadText className="font-medium">{w.name}</WorkloadText>
      </Bone>
    </span>
  );
  return (
    <>
      <TableRow>
        <TableCell className="pr-0">
          {w.containers.length > 0 && (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={open ? "Hide containers" : "Show containers"}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-surface-strong hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "size-4 transition-transform",
                  open && "rotate-90",
                )}
              />
            </button>
          )}
        </TableCell>
        <TableCell>
          {w.href ? (
            <Link href={w.href} className="hover:underline">
              {name}
            </Link>
          ) : (
            name
          )}
        </TableCell>
        <TableCell className="hidden text-muted-foreground sm:table-cell">
          <Bone loading={loading}>
            {engine ? (DB_NAMES[engine] ?? engine) : "App"}
          </Bone>
        </TableCell>
        <TableCell className="hidden sm:table-cell">
          <span className="flex items-center gap-2">
            <Bone box loading={loading} className="shrink-0 rounded-full">
              <TeamAvatar
                name={w.teamName}
                avatarUrl={w.teamAvatarUrl}
                size="xs"
              />
            </Bone>
            <Bone box loading={loading} className="min-w-0">
              <WorkloadText>{w.teamName}</WorkloadText>
            </Bone>
          </span>
        </TableCell>
        <TableCell className={cn(WIDE, "text-muted-foreground")}>
          <Bone box loading={loading} className="min-w-0">
            <WorkloadText>
              {[w.project, w.environment].filter(Boolean).join(" / ") || "-"}
            </WorkloadText>
          </Bone>
        </TableCell>
        <TableCell>
          <Bone box loading={loading}>
            <StatusIndicator status={w.status} detail={null} badge />
          </Bone>
        </TableCell>
        <Usage cpu={w.cpu} memUsed={w.memUsed} loading={loading} />
        <TableCell
          className={cn(
            WIDE,
            "text-right tabular-nums",
            w.restarts > 0 ? "text-warning" : "text-muted-foreground",
          )}
        >
          <Bone loading={loading}>{w.restarts}</Bone>
        </TableCell>
      </TableRow>
      {open && w.containers.map((c) => <ContainerRow key={c.name} c={c} />)}
    </>
  );
}

function ContainerRow({ c }: { c: WorkloadContainer }) {
  return (
    <TableRow className="bg-surface hover:bg-surface">
      <TableCell />
      <TableCell className="pl-11 font-mono text-xs">
        <WorkloadText>{c.name}</WorkloadText>
      </TableCell>
      <TableCell className="hidden sm:table-cell" />
      <TableCell className="hidden sm:table-cell" />
      <TableCell className={WIDE} />
      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
        {c.state}
        {c.health && ` · ${c.health}`}
      </TableCell>
      <Usage
        cpu={c.state === "running" ? c.cpu : null}
        memUsed={c.state === "running" ? c.memUsed : null}
      />
      <TableCell
        className={cn(
          WIDE,
          "text-right tabular-nums",
          c.restartCount > 0 ? "text-warning" : "text-muted-foreground",
        )}
      >
        {c.restartCount}
      </TableCell>
    </TableRow>
  );
}

function Usage({
  cpu,
  memUsed,
  loading = false,
}: {
  cpu: number | null;
  memUsed: number | null;
  loading?: boolean;
}) {
  return (
    <>
      <TableCell
        className={cn(WIDE, "text-right whitespace-nowrap tabular-nums")}
      >
        <Bone loading={loading}>
          {cpu == null ? "-" : `${cpu.toFixed(1)}%`}
        </Bone>
      </TableCell>
      <TableCell
        className={cn(WIDE, "text-right whitespace-nowrap tabular-nums")}
      >
        <Bone loading={loading}>
          {memUsed == null ? "-" : formatBytes(memUsed)}
        </Bone>
      </TableCell>
    </>
  );
}

function WorkloadText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <span
      title={children}
      className={cn("block max-w-xs min-w-0 truncate", className)}
    >
      {children}
    </span>
  );
}

const PLACEHOLDER_WORKLOADS: ServerWorkload[] = [
  "app-name",
  "another-app",
  "database-name",
  "web",
  "api-server",
].map((name, i) => ({
  id: `loading-${i}`,
  kind: "app",
  name,
  logo: null,
  logoTone: null,
  engine: null,
  teamName: "Team",
  teamSlug: "team",
  teamAvatarUrl: null,
  href: null,
  project: null,
  environment: null,
  status: "active",
  cpu: null,
  memUsed: null,
  restarts: 0,
  containers: [],
}));
