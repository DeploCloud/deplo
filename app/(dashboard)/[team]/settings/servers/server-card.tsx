"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  ArrowRightFromLine,
  Crown,
  MoreHorizontal,
  Network,
  Play,
  Copy,
  RefreshCw,
  Server as ServerIcon,
  Settings2,
  Undo2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Bone } from "@/components/ui/skeleton";
import { MenuSubTooltip, SimpleTooltip } from "@/components/ui/tooltip";
import { DeploMark } from "@/components/logo";
import { StatusDot } from "@/components/shared/status-badge";
import type { ListView } from "@/components/shared/view-toggle";
import type { LeaderOption } from "@/components/servers/cluster-actions";
import type { ServerMemberState } from "@/components/servers/cluster-join";
import {
  CANCEL_MEMBER_REMOVAL,
  REMOVE_MEMBER,
} from "@/components/servers/cluster-member-actions";
import { ServerUseBadge } from "@/components/servers/server-role-badge";
import type { ServerFilterFields } from "@/components/servers/servers-toolbar";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { AGENT_VERSION, type AgentReach } from "@/lib/version";
import { AgentVersionBadge } from "./agent-version-badge";
import { ServerHealthChip } from "./server-health-chip";
import {
  useServerHealth,
  type ServerHealthState,
} from "./server-health-provider";

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

function ServerStatus({ server }: { server: ServerCardData }) {
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
  const router = useRouter();
  const { checkOne, isChecking } = useServerHealth();
  const [pending, startTransition] = React.useTransition();
  const href = `/settings/servers/${server.id}`;
  const m = server.member;
  const makeLeader = server.leader
    ? undefined
    : leaderChoices.find((c) => c.serverId === server.id && !c.current);
  const leaderBack =
    server.leader && deploMachineOutside
      ? leaderChoices.find((c) => c.onDeploHost && !c.current)
      : undefined;

  const member = (query: string, extra: Record<string, unknown> = {}) =>
    startTransition(async () => {
      const res = await gqlAction(query, {
        clusterId: server.cluster?.id,
        serverId: server.id,
        ...extra,
      });
      if (!res.ok) toast.error(res.error);
      router.refresh();
    });

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
      <div
        data-card-actions
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Server menu">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              onSelect={() => checkOne(server.id)}
              disabled={isChecking(server.id)}
            >
              <RefreshCw className="size-4" />
              Check status
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={href} className="cursor-pointer">
                <Settings2 className="size-4" />
                Manage
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void navigator.clipboard
                  .writeText(server.ip)
                  .then(() => toast.success("Copied"))
              }
            >
              <Copy className="size-4" />
              Copy address
            </DropdownMenuItem>
            {!server.cluster && moveTargets.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <MenuSubTooltip
                  Sub={DropdownMenuSub}
                  SubTrigger={DropdownMenuSubTrigger}
                  SubContent={DropdownMenuSubContent}
                  content="Make this server one of a cluster's servers"
                  subContentClassName="max-h-72 overflow-y-auto"
                  trigger={
                    <>
                      <Network className="size-4" />
                      Move to cluster
                    </>
                  }
                >
                  {moveTargets.map((c) => (
                    <SimpleTooltip
                      key={c.id}
                      content={c.blocked || `Move into ${c.name}`}
                      side="left"
                    >
                      <DropdownMenuItem
                        onSelect={() => onJoin?.(c.id)}
                        disabled={Boolean(c.blocked)}
                      >
                        {c.name}
                      </DropdownMenuItem>
                    </SimpleTooltip>
                  ))}
                </MenuSubTooltip>
              </>
            )}
            {m && server.cluster && (
              <>
                <DropdownMenuSeparator />
                {makeLeader && (
                  <SimpleTooltip
                    content={
                      makeLeader.blocked ||
                      "Run the cluster's leader on this server"
                    }
                    side="left"
                  >
                    <DropdownMenuItem
                      disabled={Boolean(makeLeader.blocked)}
                      onSelect={() => onMakeLeader?.(makeLeader)}
                    >
                      <Crown className="size-4" />
                      Make leader
                    </DropdownMenuItem>
                  </SimpleTooltip>
                )}
                {leaderBack && (
                  <SimpleTooltip
                    content={
                      leaderBack.blocked ||
                      "Run the cluster's leader on Deplo's own machine again"
                    }
                    side="left"
                  >
                    <DropdownMenuItem
                      disabled={Boolean(leaderBack.blocked)}
                      onSelect={() => onMakeLeader?.(leaderBack)}
                    >
                      <Crown className="size-4" />
                      Move leader to Deplo&apos;s machine
                    </DropdownMenuItem>
                  </SimpleTooltip>
                )}
                {m.emptying === "stopped" && (
                  <DropdownMenuItem
                    disabled={pending}
                    onSelect={() =>
                      member(REMOVE_MEMBER, { keepWorkloads: false })
                    }
                  >
                    <Play className="size-4" />
                    Continue removal
                  </DropdownMenuItem>
                )}
                {m.emptying !== "idle" && (
                  <DropdownMenuItem
                    disabled={pending}
                    onSelect={() => member(CANCEL_MEMBER_REMOVAL)}
                  >
                    <Undo2 className="size-4" />
                    Cancel removal
                  </DropdownMenuItem>
                )}
                {m.emptying === "idle" && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => onRemove?.()}
                  >
                    <ArrowRightFromLine className="size-4" />
                    Remove from cluster
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
      </div>
    </Card>
  );
}
