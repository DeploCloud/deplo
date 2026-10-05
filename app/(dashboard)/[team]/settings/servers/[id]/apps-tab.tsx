"use client";

import * as React from "react";
import { AppWindow, ChevronRight } from "lucide-react";

import Link from "@/components/ui/link";
import { EmptyState } from "@/components/shared/empty-state";
import { ListToolbar } from "@/components/shared/list-toolbar";
import { AppLogo } from "@/components/shared/project-logo";
import { StatusIndicator } from "@/components/apps/app-status-dot/status-renderer";
import { DB_LOGOS, DB_NAMES } from "@/components/storage/db-engines";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  type KindFilter,
  type StatusFilter,
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

// Hidden below md so a phone keeps name, status and team.
const WIDE = "hidden md:table-cell";

export function ServerAppsTab({
  serverId,
  initial,
}: {
  serverId: string;
  initial: ServerWorkload[];
}) {
  const [rows, setRows] = React.useState(initial);
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [kind, setKind] = React.useState<KindFilter>("all");
  const [open, setOpen] = React.useState<Set<string>>(() => new Set());

  React.useEffect(() => {
    const timer = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const res = await gqlAction<{ serverWorkloads: ServerWorkload[] }>(
        WORKLOADS,
        { id: serverId },
      );
      if (res.ok && res.data) setRows(res.data.serverWorkloads);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [serverId]);

  if (rows.length === 0)
    return (
      <EmptyState
        icon={AppWindow}
        title="Nothing on this server"
        description="Apps and databases placed here show up with their live status."
      />
    );

  const shown = filterWorkloads(rows, { query, status, kind });

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <ListToolbar
        query={query}
        onQuery={setQuery}
        placeholder="Search apps or teams"
        filters={
          <>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as StatusFilter)}
            >
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any status</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="stopped">Stopped</SelectItem>
                <SelectItem value="failing">Failing</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as KindFilter)}
            >
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any type</SelectItem>
                <SelectItem value="app">Apps</SelectItem>
                <SelectItem value="database">Databases</SelectItem>
              </SelectContent>
            </Select>
          </>
        }
      />

      <div className="overflow-x-auto rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Name</TableHead>
              <TableHead className="hidden sm:table-cell">Type</TableHead>
              <TableHead className="hidden sm:table-cell">Team</TableHead>
              <TableHead className={WIDE}>Project</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className={cn(WIDE, "text-right")}>CPU</TableHead>
              <TableHead className={cn(WIDE, "text-right")}>Memory</TableHead>
              <TableHead className={cn(WIDE, "text-right")}>Restarts</TableHead>
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
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function WorkloadRows({
  workload: w,
  open,
  onToggle,
}: {
  workload: ServerWorkload;
  open: boolean;
  onToggle: () => void;
}) {
  const engine = w.engine as DatabaseType | null;
  const logo = w.logo ?? (engine ? DB_LOGOS[engine] : null);
  const name = (
    <span className="flex max-w-24 min-w-0 items-center gap-2.5 sm:max-w-36">
      <AppLogo logo={logo ?? null} tone={w.logoTone} size={24} />
      <span className="truncate font-medium">{w.name}</span>
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
          {engine ? (DB_NAMES[engine] ?? engine) : "App"}
        </TableCell>
        <TableCell className="hidden sm:table-cell">
          <Clip className="max-w-24">{w.teamName}</Clip>
        </TableCell>
        <TableCell className={cn(WIDE, "text-muted-foreground")}>
          <Clip className="max-w-24">
            {[w.project, w.environment].filter(Boolean).join(" / ") || "-"}
          </Clip>
        </TableCell>
        <TableCell>
          <StatusIndicator status={w.status} detail={null} badge />
        </TableCell>
        <Usage cpu={w.cpu} memUsed={w.memUsed} />
        <TableCell
          className={cn(
            WIDE,
            "text-right tabular-nums",
            w.restarts > 0 ? "text-warning" : "text-muted-foreground",
          )}
        >
          {w.restarts}
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
        <Clip className="max-w-24 sm:max-w-36">{c.name}</Clip>
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
}: {
  cpu: number | null;
  memUsed: number | null;
}) {
  return (
    <>
      <TableCell
        className={cn(WIDE, "text-right whitespace-nowrap tabular-nums")}
      >
        {cpu == null ? "-" : `${cpu.toFixed(1)}%`}
      </TableCell>
      <TableCell
        className={cn(WIDE, "text-right whitespace-nowrap tabular-nums")}
      >
        {memUsed == null ? "-" : formatBytes(memUsed)}
      </TableCell>
    </>
  );
}

// A td ignores max-width in an auto-layout table, so the cap lives on a block inside it.
function Clip({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  return <span className={cn("block truncate", className)}>{children}</span>;
}
