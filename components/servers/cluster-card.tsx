"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import {
  FolderOpen,
  MoreHorizontal,
  Network,
  Settings2,
  Trash2,
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
import type { ListView } from "@/components/shared/view-toggle";
import { cn } from "@/lib/utils";
import { ClusterActions } from "./cluster-actions";
import { DeleteClusterButton } from "./cluster-delete";
import { serversHref, type ClusterJoinOption } from "./cluster-join";
import type { TeamOption } from "./server-team-access";

export type ClusterCardData = {
  id: string;
  name: string;
  allTeams: boolean;
  teamIds: string[];
  servers: number;
  failoverOn: boolean;
  /** How many of its servers are still joining. */
  provisioning: number;
  /** Every server that is not in a cluster, with what stops it joining this one. */
  joinOptions: ClusterJoinOption[];
};

/** "2 servers · Failover on": what a cluster card says under its name. */
export function clusterSummary(c: {
  servers: number;
  failoverOn: boolean;
  provisioning: number;
}): string {
  if (c.servers === 0) return "No servers yet";
  return [
    `${c.servers} server${c.servers === 1 ? "" : "s"}`,
    c.provisioning > 0 ? `${c.provisioning} provisioning` : null,
    c.failoverOn ? "Failover on" : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem asChild>
              <Link href={href} className="cursor-pointer">
                <FolderOpen className="size-4" />
                Open
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setManage(true)}>
              <Settings2 className="size-4" />
              Manage
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
    <>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Network className="size-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        <span className="block truncate font-medium">{cluster.name}</span>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {clusterSummary(cluster)}
        </p>
      </div>
    </>
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
            "pointer-events-none relative z-[1] flex min-w-0 flex-1 gap-3",
            view === "list" ? "items-center" : "items-start justify-between",
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {identity}
          </div>
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
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Bone box className="shrink-0">
            <div className="size-9" />
          </Bone>
          <div className="min-w-0 flex-1">
            <span className="block truncate font-medium">
              <Bone>cluster-name</Bone>
            </span>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              <Bone>2 servers · Failover on</Bone>
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
