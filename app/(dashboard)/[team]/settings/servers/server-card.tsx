"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import {
  Crown,
  MoreHorizontal,
  Network,
  Server as ServerIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Bone } from "@/components/ui/skeleton";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { DeploMark } from "@/components/logo";
import { StatusDot } from "@/components/shared/status-badge";
import type { ListView } from "@/components/shared/view-toggle";
import type { LeaderOption } from "@/components/servers/cluster-actions";
import type { ServerMemberState } from "@/components/servers/cluster-join";
import { ServerUseBadge } from "@/components/servers/server-role-badge";
import type { ServerFilterFields } from "@/components/servers/servers-toolbar";
import { cn } from "@/lib/utils";
import { AGENT_VERSION, type AgentReach } from "@/lib/version";
import { AgentVersionBadge } from "./agent-version-badge";
import { ServerHealthChip } from "./server-health-chip";
import type { ServerHealthState } from "./server-health-provider";
import { DocsLink } from "@/components/ui/docs-link";
import { UsageMeters } from "@/components/servers/server-usage";
import type { ServerUsage } from "@/lib/types/server";
import { ServerMenu } from "./server-menu";

export type ServerCardData = ServerFilterFields & {
  id: string;
  name: string;
  ip: string;
  isDeploHost: boolean;
  accessLabel: string;
  agentVersion: string | null;
  expected: string;
  reach: AgentReach;
  health: ServerHealthState;
  advice: string;
  uninstallPending: boolean;
  uninstallError: string | null;
  /** Its newest reading; null while it has none. */
  usage: ServerUsage | null;
  apps: number;
  cluster: { id: string; name: string; servers: number } | null;
  member: ServerMemberState | null;
  /** The cluster's leader runs on this server. */
  leader: boolean;
};

/** A cluster this server could be moved into, with what stops it. */
export type MoveTarget = { id: string; name: string; blocked: string };

const EMPTYING_BADGE = {
  removing: { label: "Removing", variant: "warning" },
  stopped: { label: "Removal stopped", variant: "destructive" },
} as const;

export function ServerStatus({ server }: { server: ServerCardData }) {
  if (server.member?.provisioning && server.cluster)
    return (
      <SimpleTooltip
        content={`Joining ${server.cluster.name}. It takes work once the cluster's leader answers for it.`}
      >
        <Badge variant="warning" className="gap-1.5">
          <StatusDot status="provisioning" />
          Provisioning
        </Badge>
      </SimpleTooltip>
    );
  return (
    <ServerHealthChip
      serverId={server.id}
      fallback={server.health}
      offlineAdvice={server.advice}
    />
  );
}

function ServerBadges({
  server,
  showCluster,
}: {
  server: ServerCardData;
  showCluster: boolean;
}) {
  const m = server.member;
  return (
    <>
      {server.isDeploHost && (
        <Badge
          className="shrink-0 gap-1"
          title="This server also runs Deplo itself. Removing it takes Deplo down."
        >
          <DeploMark size={12} className="text-current" />
          Deplo host
        </Badge>
      )}
      {showCluster && server.cluster && (
        <Badge variant="muted" className="shrink-0 gap-1" title="Its cluster">
          <Network className="size-3" />
          {server.cluster.name}
        </Badge>
      )}
      <ServerUseBadge use={server.use} />
      <Badge variant="muted" title="Which teams can deploy to this server">
        {server.accessLabel}
      </Badge>
      <AgentVersionBadge
        version={server.agentVersion}
        expected={server.expected}
        reach={server.reach}
      />
      {m && m.emptying !== "idle" && (
        <Badge
          variant={EMPTYING_BADGE[m.emptying].variant}
          title={m.error || m.progress || undefined}
        >
          {EMPTYING_BADGE[m.emptying].label}
        </Badge>
      )}
      {m?.network && (
        <SimpleTooltip
          content={
            <>
              {m.network}
              <DocsLink
                topic="clusters.privateNetworkPaths"
                className="mt-1.5 block w-fit"
              />
            </>
          }
        >
          <Badge variant={m.networkDown ? "warning" : "muted"}>
            {m.networkDown ? "Can't reach a server" : "Relayed"}
          </Badge>
        </SimpleTooltip>
      )}
    </>
  );
}

export function ServerCard({
  server,
  view = "grid",
  moveTargets = [],
  showCluster = false,
  dragHandle,
  dragActive = false,
  busy = false,
  leaderChoices = [],
  deploMachineOutside = false,
  onJoin,
  onRemove,
  onMakeLeader,
}: {
  server: ServerCardData;
  view?: ListView;
  /** The clusters its menu offers; none inside a cluster. */
  moveTargets?: MoveTarget[];
  /** Name its cluster on the card: a search lists servers of every cluster together. */
  showCluster?: boolean;
  dragHandle?: React.ReactNode;
  dragActive?: boolean;
  /** A move is on its way: the card waits for it. */
  busy?: boolean;
  /** Where the cluster's leader may run; empty outside a cluster. */
  leaderChoices?: LeaderOption[];
  /** Deplo's own machine is no server of this cluster, so only the leader's menu offers it. */
  deploMachineOutside?: boolean;
  onJoin?: (clusterId: string) => void;
  onRemove?: () => void;
  onMakeLeader?: (choice: LeaderOption) => void;
}) {
  const href = `/settings/servers/${server.id}`;
  const m = server.member;

  const actions = (
    <div className="pointer-events-auto relative z-10 flex items-center gap-1">
      {server.leader && (
        <SimpleTooltip content="The cluster's leader runs here: it decides where each App runs and moves them when a server stops.">
          <Badge variant="muted" className="gap-1">
            <Crown className="size-3" />
            Leader
          </Badge>
        </SimpleTooltip>
      )}
      <ServerStatus server={server} />
      {dragHandle && (
        <span className="hidden animate-in items-center duration-200 fade-in-0 slide-in-from-right-2 group-hover:flex focus-within:flex">
          {dragHandle}
        </span>
      )}
      <ServerMenu
        server={server}
        moveTargets={moveTargets}
        leaderChoices={leaderChoices}
        deploMachineOutside={deploMachineOutside}
        onJoin={onJoin}
        onRemove={onRemove}
        onMakeLeader={onMakeLeader}
      />
    </div>
  );

  const overlayLink = (
    <Link
      href={href}
      aria-label={`Manage ${server.name}`}
      tabIndex={dragActive ? -1 : undefined}
      aria-hidden={dragActive || undefined}
      className={cn(
        "absolute inset-0 z-0 rounded-xl",
        dragActive ? "pointer-events-none cursor-default" : "cursor-pointer",
      )}
    />
  );

  const tile = (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
      {server.isDeploHost ? (
        <DeploMark size={18} className="text-current" />
      ) : (
        <ServerIcon className="size-4.5" />
      )}
    </div>
  );

  const identity = (
    <div className="min-w-0 flex-1">
      <span className="block truncate font-medium">{server.name}</span>
      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
        {server.ip}
      </p>
    </div>
  );

  const notes = [
    server.uninstallPending && "Deplo is removing its agent from this machine.",
    server.uninstallError &&
      `Deplo could not remove its agent: ${server.uninstallError}`,
    m?.progress,
    m?.error,
  ].filter((n): n is string => Boolean(n));

  const card =
    view === "list" ? (
      <Card className="group relative flex items-center gap-4 p-4 transition-colors hover:border-foreground/20">
        {overlayLink}
        <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-4">
          {tile}
          {identity}
          <div className="hidden items-center gap-1.5 lg:flex [&>*]:pointer-events-auto">
            <ServerBadges server={server} showCluster={showCluster} />
          </div>
          {server.usage && (
            <span className="ml-auto hidden text-xs whitespace-nowrap text-muted-foreground tabular-nums xl:inline">
              {Math.round(server.usage.cpu)}% CPU ·{" "}
              {Math.round(
                (server.usage.memUsed / Math.max(server.usage.memTotal, 1)) *
                  100,
              )}
              % memory
            </span>
          )}
        </div>
        {actions}
      </Card>
    ) : (
      <Card className="group relative flex flex-col gap-4 p-5 transition-colors hover:border-foreground/20">
        {overlayLink}
        <div className="pointer-events-none relative z-[1] flex flex-1 flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {tile}
              {identity}
            </div>
            {actions}
          </div>
          <div className="rounded-lg border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-1.5 [&>*]:pointer-events-auto">
              <ServerBadges server={server} showCluster={showCluster} />
            </div>
            {notes.map((note) => (
              <p key={note} className="mt-2 text-xs text-muted-foreground">
                {note}
              </p>
            ))}
          </div>
          {server.usage && <UsageMeters usage={server.usage} />}
        </div>
      </Card>
    );

  if (busy)
    return (
      <div
        inert
        aria-busy
        className="pointer-events-none animate-pulse opacity-70 select-none"
      >
        {card}
      </div>
    );
  return card;
}

/** One server card while the Servers page loads, on the card's own frame. */
export function ServerCardSkeleton() {
  return (
    <Card className="group relative flex flex-col gap-4 p-5">
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Bone box className="shrink-0">
              <div className="size-9" />
            </Bone>
            <div className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                <Bone>server-name</Bone>
              </span>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                <Bone>203.0.113.10</Bone>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* An online server's health is a dot; Checking or Offline is a badge. */}
            <Bone box className="rounded-full">
              <span className="size-3" />
            </Bone>
            <Button variant="ghost" size="icon-sm" disabled aria-hidden>
              <MoreHorizontal className="size-4" />
            </Button>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Bone box>
              <ServerUseBadge use="everything" />
            </Bone>
            <Bone box>
              <Badge variant="muted">All teams</Badge>
            </Bone>
            <Bone box>
              <AgentVersionBadge
                version={AGENT_VERSION}
                expected={AGENT_VERSION}
                reach="usable"
              />
            </Bone>
          </div>
        </div>
        <div className="space-y-3">
          {["CPU", "Memory", "Disk"].map((label) => (
            <Bone key={label} box className="w-full">
              <div className="h-[30px]" />
            </Bone>
          ))}
        </div>
      </div>
    </Card>
  );
}
