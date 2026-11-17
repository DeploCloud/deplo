"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import {
  ArrowRight,
  Copy,
  CopyX,
  MoreHorizontal,
  Network,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Bone } from "@/components/ui/skeleton";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { ListView } from "@/components/shared/view-toggle";
import { cn } from "@/lib/utils";
import { ClusterActions } from "./cluster-actions";
import { useFailoverSwitch, useReplicationSwitch } from "./cluster-bar";
import { DeleteClusterButton } from "./cluster-delete";
import { serversHref, type ClusterJoinOption } from "./cluster-join";
import type { ClusterWarning } from "@/lib/clusters/warnings";
import type { TeamOption } from "./server-team-access";
import type { ServerUsage } from "@/lib/types/server";
import { formatBytes } from "@/lib/utils";

export type ClusterCardData = {
  id: string;
  name: string;
  allTeams: boolean;
  teamIds: string[];
  servers: number;
  failoverEnabled: boolean;
  replicationEnabled: boolean;
  /** How many of its servers are still joining. */
  provisioning: number;
  /** Every server that is not in a cluster, with what stops it joining this one. */
  joinOptions: ClusterJoinOption[];
  /** What the background check stored, plus the Apps waiting: the card never waits on a leader. */
  warnings?: Promise<ClusterWarning[]>;
  /** Its servers in the order they joined, and whether each answers. */
  members: { name: string; online: boolean }[];
  /** The servers that answered, added up. */
  totals: ServerUsage;
  apps: number;
};

/** What a cluster card says under its name: the count is in its numbers. */
export function clusterSummary(c: { provisioning: number }): string {
  return c.provisioning > 0
    ? `Cluster · ${c.provisioning} provisioning`
    : "Cluster";
}

/** A chip stays short ("2/3"); `full` says it in words, for the tooltip and screen readers. */
export function clusterHealth(online: boolean[]): {
  label: string;
  full: string;
  variant: "success" | "warning" | "destructive" | "muted";
} {
  const up = online.filter(Boolean).length;
  const n = online.length;
  if (n === 0)
    return { label: "Empty", full: "No servers yet", variant: "muted" };
  return {
    label: `${up}/${n}`,
    full: `${up} of ${n} server${n === 1 ? "" : "s"} online`,
    variant: up === n ? "success" : up === 0 ? "destructive" : "warning",
  };
}

export function HealthBadge({ online }: { online: boolean[] }) {
  const health = clusterHealth(online);
  return (
    <SimpleTooltip content={health.full}>
      <Badge
        variant={health.variant}
        aria-label={health.full}
        className="whitespace-nowrap tabular-nums"
      >
        {health.variant === "warning" && <TriangleAlert className="size-3" />}
        {health.label}
      </Badge>
    </SimpleTooltip>
  );
}

function Warned({ warnings }: { warnings: Promise<ClusterWarning[]> }) {
  const list = React.use(warnings);
  if (list.length === 0) return null;
  return (
    <SimpleTooltip content={[...new Set(list.map((w) => w.title))].join(" · ")}>
      <TriangleAlert
        aria-label="This cluster needs attention"
        className="pointer-events-auto size-3.5 shrink-0 text-[var(--warning)]"
      />
    </SimpleTooltip>
  );
}

export function ClusterCard({
  cluster,
  teams,
  view = "grid",
  dragActive = false,
  dropActive = false,
  dragHandle,
}: {
  cluster: ClusterCardData;
  teams: TeamOption[];
  view?: ListView;
  dragActive?: boolean;
  dropActive?: boolean;
  dragHandle?: React.ReactNode;
}) {
  const [manage, setManage] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const failover = useFailoverSwitch(cluster);
  const replication = useReplicationSwitch(cluster);
  const href = serversHref({ cluster: cluster.id, view });

  const actions = (
    <div className="pointer-events-auto relative z-10 flex items-center gap-1 self-center [&_button:hover]:bg-card-hover">
      <HealthBadge online={cluster.members.map((m) => m.online)} />
      {dragHandle && (
        <span className="hidden animate-in items-center duration-200 fade-in-0 slide-in-from-right-2 group-hover:flex focus-within:flex">
          {dragHandle}
        </span>
      )}
      <div
        data-card-actions
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Cluster menu">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <SimpleTooltip content="Open this cluster" side="left">
              <DropdownMenuItem asChild>
                <Link href={href} className="cursor-pointer">
                  <ArrowRight className="size-4" />
                  Open
                </Link>
              </DropdownMenuItem>
            </SimpleTooltip>
            <SimpleTooltip
              content="Rename it, or choose which teams may use it"
              side="left"
            >
              <DropdownMenuItem onSelect={() => setManage(true)}>
                <Settings2 className="size-4" />
                Manage
              </DropdownMenuItem>
            </SimpleTooltip>
            <DropdownMenuItem
              disabled={failover.pending}
              onSelect={() => failover.set(!failover.on)}
            >
              {failover.on ? (
                <ShieldOff className="size-4" />
              ) : (
                <ShieldCheck className="size-4" />
              )}
              {failover.on ? "Turn failover off" : "Turn failover on"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={replication.pending}
              onSelect={() => replication.set(!replication.on)}
            >
              {replication.on ? (
                <CopyX className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
              {replication.on ? "Turn replication off" : "Turn replication on"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDeleting(true)}
            >
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  const identity = (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Network className="size-4.5" />
      </div>
      <div className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{cluster.name}</span>
          {cluster.warnings && (
            <React.Suspense fallback={null}>
              <Warned warnings={cluster.warnings} />
            </React.Suspense>
          )}
        </span>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {clusterSummary(cluster)}
        </p>
      </div>
    </div>
  );

  return (
    <>
      <Card
        className={cn(
          "group relative flex gap-4 transition-colors hover:border-foreground/20",
          view === "list" ? "items-center p-4" : "flex-col p-5",
          dropActive && "border-primary ring-2 ring-primary/40",
        )}
      >
        <Link
          href={href}
          aria-label={`Open cluster ${cluster.name}`}
          tabIndex={dragActive ? -1 : undefined}
          aria-hidden={dragActive || undefined}
          className={cn(
            "absolute inset-0 z-0 rounded-xl",
            dragActive
              ? "pointer-events-none cursor-default"
              : "cursor-pointer",
          )}
        />
        <div
          className={cn(
            "pointer-events-none relative z-[1] flex min-w-0 flex-1 justify-between gap-3",
            view === "list" ? "items-center" : "items-start",
          )}
        >
          {identity}
          {view === "list" && <ClusterNumbers cluster={cluster} compact />}
          {actions}
        </div>
        {view === "grid" && (
          <div className="pointer-events-none relative z-[1] space-y-3.5 rounded-lg border border-border bg-surface p-3.5">
            <ClusterNumbers cluster={cluster} />
            <HealthStrip members={cluster.members} />
          </div>
        )}
      </Card>
      <ClusterActions
        cluster={cluster}
        teams={teams}
        open={manage}
        onOpenChange={setManage}
        trigger={false}
      />
      <DeleteClusterButton
        cluster={cluster}
        open={deleting}
        onOpenChange={setDeleting}
        trigger={false}
      />
    </>
  );
}

function ClusterNumbers({
  cluster,
  compact = false,
}: {
  cluster: ClusterCardData;
  compact?: boolean;
}) {
  // The unit rides in the label, so a quarter of a card still fits the number.
  const [mem, unit] = cluster.totals.memTotal
    ? formatBytes(cluster.totals.memTotal).split(" ")
    : ["-", ""];
  const numbers = [
    [
      String(cluster.members.length),
      cluster.members.length === 1 ? "server" : "servers",
    ],
    // No server has reported yet (a fresh restart): a dash, never a zero it does not have.
    [cluster.totals.cores ? String(cluster.totals.cores) : "-", "cores"],
    [mem, unit ? `${unit} memory` : "memory"],
    [String(cluster.apps), cluster.apps === 1 ? "app" : "apps"],
  ];
  if (compact)
    return (
      <span className="ml-auto hidden text-xs whitespace-nowrap text-muted-foreground tabular-nums lg:inline">
        {numbers.map(([v, l]) => `${v} ${l}`).join(" · ")}
      </span>
    );
  return (
    <div className="grid grid-cols-4 gap-2">
      {numbers.map(([value, label]) => (
        <div key={label} className="min-w-0">
          <div className="truncate text-lg font-semibold tabular-nums">
            {value}
          </div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      ))}
    </div>
  );
}

/** One segment per server, in the order they joined: green while it answers. */
function HealthStrip({ members }: { members: ClusterCardData["members"] }) {
  if (members.length === 0) return null;
  const up = members.filter((m) => m.online).length;
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1" aria-hidden>
        {members.map((m) => (
          <SimpleTooltip
            key={m.name}
            content={`${m.name}: ${m.online ? "online" : "not answering"}`}
          >
            <span
              className={cn(
                "pointer-events-auto h-2 flex-1 rounded-sm",
                m.online ? "bg-success" : "bg-muted",
              )}
            />
          </SimpleTooltip>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {up} of {members.length} servers online
      </p>
    </div>
  );
}

/** One cluster card while the Servers page loads, on the card's own frame. */
export function ClusterCardSkeleton() {
  return (
    <Card className="group relative flex flex-col gap-4 p-5">
      <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Bone box className="shrink-0">
            <div className="size-9" />
          </Bone>
          <div className="min-w-0">
            <span className="block truncate font-medium">
              <Bone>cluster-name</Bone>
            </span>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              <Bone>Cluster</Bone>
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" disabled aria-hidden>
          <MoreHorizontal className="size-4" />
        </Button>
      </div>
      <Bone box className="w-full">
        <div className="h-[88px]" />
      </Bone>
    </Card>
  );
}
