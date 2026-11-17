"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  ArrowRightFromLine,
  Copy,
  Crown,
  MoreHorizontal,
  Network,
  Play,
  RefreshCw,
  Settings2,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { MenuSubTooltip, SimpleTooltip } from "@/components/ui/tooltip";
import type { LeaderOption } from "@/components/servers/cluster-actions";
import {
  CANCEL_MEMBER_REMOVAL,
  REMOVE_MEMBER,
} from "@/components/servers/cluster-member-actions";
import { gqlAction } from "@/lib/graphql-client";
import { useServerHealth } from "./server-health-provider";
import type { MoveTarget, ServerCardData } from "./server-card";

/** A server's own menu: the same on its card and on its row in a cluster. */
export function ServerMenu({
  server,
  moveTargets = [],
  leaderChoices = [],
  deploMachineOutside = false,
  onJoin,
  onRemove,
  onMakeLeader,
}: {
  server: ServerCardData;
  moveTargets?: MoveTarget[];
  leaderChoices?: LeaderOption[];
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

  return (
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
          {server.joining && (
            <DropdownMenuItem
              disabled={pending}
              onSelect={() =>
                startTransition(async () => {
                  const res = await gqlAction(
                    `mutation($serverId: String!) { cancelClusterJoin(serverId: $serverId) }`,
                    { serverId: server.id },
                  );
                  if (!res.ok) toast.error(res.error);
                  router.refresh();
                })
              }
            >
              <Undo2 className="size-4" />
              Don&apos;t join {server.joining.clusterName}
            </DropdownMenuItem>
          )}
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
  );
}
