"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import {
  Folder,
  FolderOpen,
  MoreHorizontal,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Trash2,
  TriangleAlert,
} from "lucide-react";

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
import { useFailoverSwitch } from "./cluster-bar";
import { DeleteClusterButton } from "./cluster-delete";
import { serversHref, type ClusterJoinOption } from "./cluster-join";
import type { ClusterWarning } from "@/lib/clusters/warnings";
import type { TeamOption } from "./server-team-access";

export type ClusterCardData = {
  id: string;
  name: string;
  allTeams: boolean;
  teamIds: string[];
  servers: number;
  failoverEnabled: boolean;
  /** How many of its servers are still joining. */
  provisioning: number;
  /** Every server that is not in a cluster, with what stops it joining this one. */
  joinOptions: ClusterJoinOption[];
  /** What the background check stored, plus the Apps waiting: the card never waits on a leader. */
  warnings?: Promise<ClusterWarning[]>;
};

/** "2 servers · 1 provisioning": what a cluster card says under its name, as a folder counts its Apps. */
export function clusterSummary(c: {
  servers: number;
  provisioning: number;
}): string {
  if (c.servers === 0) return "No servers yet";
  return [
    `${c.servers} server${c.servers === 1 ? "" : "s"}`,
    c.provisioning > 0 ? `${c.provisioning} provisioning` : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
}: {
  cluster: ClusterCardData;
  teams: TeamOption[];
  view?: ListView;
  dragActive?: boolean;
  dropActive?: boolean;
}) {
  const [manage, setManage] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const failover = useFailoverSwitch(cluster);
  const href = serversHref({ cluster: cluster.id, view });

  const actions = (
    <div className="pointer-events-auto relative z-10 flex items-center gap-1 self-center [&_button:hover]:bg-card-hover">
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
                  <FolderOpen className="size-4" />
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
        <Folder className="size-4.5" />
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
          {actions}
        </div>
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
              <Bone>2 servers</Bone>
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" disabled aria-hidden>
          <MoreHorizontal className="size-4" />
        </Button>
      </div>
    </Card>
  );
}
