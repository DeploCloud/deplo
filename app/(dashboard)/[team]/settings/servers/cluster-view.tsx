"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  Activity,
  Boxes,
  ArrowRightFromLine,
  ChevronLeft,
  Crown,
  Network,
  Plus,
  Server as ServerIcon,
  SlidersHorizontal,
  TriangleAlert,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/shared/empty-state";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import {
  JoinClusterConfirm,
  MakeLeaderConfirm,
  joinCluster,
  type LeaderOption,
} from "@/components/servers/cluster-actions";
import {
  ClusterMenu,
  ClusterSettings,
  type ClusterBarData,
} from "@/components/servers/cluster-bar";
import { HealthBadge } from "@/components/servers/cluster-card";
import {
  lineWords,
  serversHref,
  type ClusterJoinOption,
} from "@/components/servers/cluster-join";
import {
  RemoveMemberDialog,
  RemoveMembersDialog,
} from "@/components/servers/cluster-member-actions";
import { ServerSelectionBar } from "@/components/servers/server-bulk";
import { useSelectionShortcuts } from "@/components/shared/card-selection";
import { Checkbox } from "@/components/ui/checkbox";
import { useServerHealth } from "./server-health-provider";
import type { TeamOption } from "@/components/servers/server-team-access";
import { UsageMeters } from "@/components/servers/server-usage";
import { formatBytes } from "@/lib/utils";
import type { ServerUsage } from "@/lib/types/server";
import { AgentVersionBadge } from "./agent-version-badge";
import { ServerStatus, type ServerCardData } from "./server-card";
import { ServerMenu } from "./server-menu";
import { AddServer } from "@/components/servers/add-server";

export type ClusterViewData = ClusterBarData & {
  members: { name: string; online: boolean }[];
  totals: ServerUsage;
  apps: number;
  /** No direct majority: the cluster's own warning, shown again in Add server before anything is added. */
  notForProduction?: { title: string; body: string } | null;
};

const percent = (used: number, total: number) =>
  total > 0 ? (used / total) * 100 : 0;

function UsageCell({ value, pct }: { value: string; pct: number }) {
  return (
    <div className="min-w-28 space-y-1.5">
      <span className="tabular-nums">{value}</span>
      <Progress value={Math.max(pct, 1)} className="h-1" aria-hidden />
    </div>
  );
}

/** What a server in the table needs to say beyond its status: a removal on its way, a network or agent problem. */
function MemberNotes({ server }: { server: ServerCardData }) {
  const m = server.member;
  const notes = [m?.progress, m?.error, m?.network].filter((n): n is string =>
    Boolean(n),
  );
  const outdated =
    server.agentVersion && server.agentVersion !== server.expected;
  if (!notes.length && !outdated) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {outdated && (
        <AgentVersionBadge
          version={server.agentVersion}
          expected={server.expected}
          reach={server.reach}
        />
      )}
      {notes.map((n) => (
        <span
          key={n}
          className="text-xs whitespace-normal text-muted-foreground"
        >
          {n}
        </span>
      ))}
    </div>
  );
}

export function ClusterView({
  cluster,
  servers,
  teams,
  joinOptions,
  leaderChoices,
  notices,
}: {
  cluster: ClusterViewData;
  /** Its servers, in the order they joined. */
  servers: ServerCardData[];
  teams: TeamOption[];
  /** Every server outside a cluster, with what stops it joining this one. */
  joinOptions: ClusterJoinOption[];
  leaderChoices: LeaderOption[];
  notices?: React.ReactNode;
}) {
  const router = useRouter();
  const [removeId, setRemoveId] = React.useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [leaderAsk, setLeaderAsk] = React.useState<LeaderOption | null>(null);
  const [leaderOpen, setLeaderOpen] = React.useState(false);
  const [joinAsk, setJoinAsk] = React.useState<ClusterJoinOption | null>(null);
  const [joinOpen, setJoinOpen] = React.useState(false);
  const [, startJoin] = React.useTransition();
  const [chosen, setChosen] = React.useState<Set<string>>(() => new Set());
  const [bulkRemoveOpen, setBulkRemoveOpen] = React.useState(false);
  const [installOpen, setInstallOpen] = React.useState(false);
  const { checkOne } = useServerHealth();
  const picked = servers.filter((s) => chosen.has(s.id));
  // A server already on its way out has nothing more to be asked.
  const leavable = picked.filter((s) => s.member?.emptying === "idle");
  const selectAll = React.useCallback(
    () => setChosen(new Set(servers.map((s) => s.id))),
    [servers],
  );
  const clear = React.useCallback(() => setChosen(new Set()), []);
  useSelectionShortcuts({ count: chosen.size, selectAll, clear });
  const toggle = (ids: string[], on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const leader = servers.find((s) => s.leader);
  const removing = servers.find((s) => s.id === removeId);
  const deploMachineOutside = !servers.some((s) => s.isDeploHost);

  async function join(option: ClusterJoinOption) {
    const res = await joinCluster(cluster.id, option.serverId);
    if (res.ok) {
      toast.success(res.data ?? `${option.serverName} joined ${cluster.name}`);
      router.refresh();
    }
    return res;
  }

  // A server that runs something only moves once the person says so: its Apps move with it.
  function requestJoin(option: ClusterJoinOption) {
    if (option.blocked) return void toast.error(option.blocked);
    if (option.apps + option.databases > 0) {
      setJoinAsk(option);
      setJoinOpen(true);
      return;
    }
    startJoin(async () => {
      const res = await join(option);
      if (!res.ok) toast.error(res.error);
    });
  }

  const subtitle = [
    `${servers.length} server${servers.length === 1 ? "" : "s"} acting as one`,
    leader && `leader on ${leader.name}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href={serversHref()}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Servers
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
              <Network className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight">
                  {cluster.name}
                </h1>
                <HealthBadge online={cluster.members.map((m) => m.online)} />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <AddServerMenu
              clusterName={cluster.name}
              warning={cluster.notForProduction ?? null}
              options={joinOptions.filter(
                (o) => !servers.some((m) => m.id === o.serverId),
              )}
              onPick={requestJoin}
              onInstall={() => setInstallOpen(true)}
            />
            <AddServer
              joinCluster={cluster}
              joinWarning={cluster.notForProduction ?? null}
              teams={teams}
              open={installOpen}
              onOpenChange={setInstallOpen}
              trigger={false}
            />
            <ClusterMenu cluster={cluster} teams={teams} />
          </div>
        </div>
      </div>

      {notices}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
        <section className="min-w-0 space-y-3">
          <SettingsSection icon={ServerIcon} title="Servers" />
          {servers.length === 0 ? (
            <EmptyState
              icon={Network}
              title="This cluster has no servers"
              description="Use Add server above to move one in."
            />
          ) : (
            <div className="rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label="Select all servers"
                        checked={
                          picked.length === 0
                            ? false
                            : picked.length === servers.length
                              ? true
                              : "indeterminate"
                        }
                        onCheckedChange={(on) =>
                          toggle(
                            servers.map((s) => s.id),
                            on === true,
                          )
                        }
                      />
                    </TableHead>
                    <TableHead>Server</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="max-md:hidden">CPU</TableHead>
                    <TableHead className="max-md:hidden">Memory</TableHead>
                    <TableHead className="max-md:hidden">Apps</TableHead>
                    <TableHead className="w-0">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {servers.map((s) => (
                    <TableRow
                      key={s.id}
                      data-state={chosen.has(s.id) ? "selected" : undefined}
                    >
                      <TableCell className="w-10">
                        <Checkbox
                          aria-label={`Select ${s.name}`}
                          checked={chosen.has(s.id)}
                          onCheckedChange={(on) => toggle([s.id], on === true)}
                        />
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/settings/servers/${s.id}`}
                          className="flex items-center gap-1.5 font-medium hover:underline"
                        >
                          {s.name}
                          {s.leader && (
                            <SimpleTooltip content="The cluster's leader runs here: it decides where each App runs.">
                              <Crown className="size-3.5 text-[var(--warning)]" />
                            </SimpleTooltip>
                          )}
                          {!s.leader &&
                            lineWords(s.member?.nextInLine ?? 0) && (
                              <SimpleTooltip
                                content={lineWords(s.member!.nextInLine)}
                              >
                                <Crown className="size-3.5 text-muted-foreground" />
                              </SimpleTooltip>
                            )}
                          {s.member?.relayWarning && (
                            <SimpleTooltip content={s.member.relayWarning}>
                              <TriangleAlert
                                className="size-3.5 text-[var(--warning)]"
                                aria-label={s.member.relayWarning}
                              />
                            </SimpleTooltip>
                          )}
                        </Link>
                        <div className="font-mono text-xs text-muted-foreground">
                          {s.ip}
                        </div>
                        <MemberNotes server={s} />
                      </TableCell>
                      <TableCell>
                        <ServerStatus server={s} />
                      </TableCell>
                      <TableCell className="max-md:hidden">
                        {s.usage ? (
                          <UsageCell
                            value={`${Math.round(s.usage.cpu)}% of ${s.usage.cores}`}
                            pct={s.usage.cpu}
                          />
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="max-md:hidden">
                        {s.usage ? (
                          <UsageCell
                            value={`${formatBytes(s.usage.memUsed)} of ${formatBytes(s.usage.memTotal)}`}
                            pct={percent(s.usage.memUsed, s.usage.memTotal)}
                          />
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums max-md:hidden">
                        {s.apps}
                      </TableCell>
                      <TableCell className="text-right">
                        <ServerMenu
                          server={s}
                          leaderChoices={leaderChoices}
                          deploMachineOutside={deploMachineOutside}
                          onRemove={() => {
                            setRemoveId(s.id);
                            setRemoveOpen(true);
                          }}
                          onMakeLeader={(choice) => {
                            setLeaderAsk(choice);
                            setLeaderOpen(true);
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <section className="space-y-3">
            <SettingsSection icon={Activity} title="Capacity" />
            <Card className="space-y-4 p-4">
              {cluster.totals.cores > 0 ? (
                <UsageMeters usage={cluster.totals} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No server of this cluster has reported its usage yet.
                </p>
              )}
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="muted" className="gap-1">
                  <Boxes className="size-3" />
                  {cluster.apps} {cluster.apps === 1 ? "app" : "apps"}
                </Badge>
                {leader && (
                  <Badge variant="muted" className="gap-1">
                    <Crown className="size-3" />
                    Leader on {leader.name}
                  </Badge>
                )}
                <Badge variant="muted" className="gap-1">
                  <Users className="size-3" />
                  {cluster.allTeams
                    ? "All teams"
                    : `${cluster.teamIds.length} team${cluster.teamIds.length === 1 ? "" : "s"}`}
                </Badge>
              </div>
            </Card>
          </section>
          <section className="space-y-3">
            <SettingsSection icon={SlidersHorizontal} title="Settings" />
            <ClusterSettings cluster={cluster} />
          </section>
        </aside>
      </div>

      <ServerSelectionBar
        picked={picked}
        onSelectAll={selectAll}
        onClear={clear}
        onCheck={(ids) => ids.forEach(checkOne)}
      >
        <SimpleTooltip
          content={
            leavable.length === 0
              ? "These servers are already leaving the cluster."
              : `Take ${leavable.length === 1 ? leavable[0].name : `${leavable.length} servers`} out of ${cluster.name}`
          }
        >
          <span className="inline-flex">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={leavable.length === 0}
              onClick={() => setBulkRemoveOpen(true)}
            >
              <ArrowRightFromLine className="size-4" />
              Remove from cluster
            </Button>
          </span>
        </SimpleTooltip>
      </ServerSelectionBar>
      {leavable.length > 1 && (
        <RemoveMembersDialog
          key={leavable.map((s) => s.id).join()}
          open={bulkRemoveOpen}
          onOpenChange={setBulkRemoveOpen}
          clusterId={cluster.id}
          clusterName={cluster.name}
          servers={leavable.map((s) => ({
            id: s.id,
            name: s.name,
            held: s.member?.held ?? 0,
          }))}
          memberCount={servers.length}
          onDone={clear}
        />
      )}
      {leavable.length === 1 && (
        <RemoveMemberDialog
          key={leavable[0].id}
          open={bulkRemoveOpen}
          onOpenChange={setBulkRemoveOpen}
          clusterId={cluster.id}
          clusterName={cluster.name}
          serverId={leavable[0].id}
          serverName={leavable[0].name}
          held={leavable[0].member?.held ?? 0}
          memberCount={servers.length}
        />
      )}

      {joinAsk && (
        <JoinClusterConfirm
          key={joinAsk.serverId}
          open={joinOpen}
          onOpenChange={setJoinOpen}
          option={joinAsk}
          cluster={cluster}
          onJoin={() => join(joinAsk)}
        />
      )}
      {leaderAsk && (
        <MakeLeaderConfirm
          key={leaderAsk.serverId}
          clusterId={cluster.id}
          choice={leaderAsk}
          servers={servers.length}
          open={leaderOpen}
          onOpenChange={setLeaderOpen}
        />
      )}
      {removing?.member && (
        <RemoveMemberDialog
          key={removing.id}
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          clusterId={cluster.id}
          clusterName={cluster.name}
          serverId={removing.id}
          serverName={removing.name}
          held={removing.member.held}
          memberCount={servers.length}
        />
      )}
    </div>
  );
}

/** Add server, inside a cluster: one of the servers outside every cluster moves in. */
function AddServerMenu({
  clusterName,
  warning,
  options,
  onPick,
  onInstall,
}: {
  clusterName: string;
  warning: { title: string; body: string } | null;
  options: ClusterJoinOption[];
  onPick: (option: ClusterJoinOption) => void;
  onInstall: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <Plus className="size-4" />
          Add server
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-80 w-64 overflow-y-auto"
      >
        {warning && (
          <>
            <DropdownMenuLabel className="space-y-1 text-xs font-normal">
              <span className="flex items-center gap-1.5 font-medium text-[var(--warning)]">
                <TriangleAlert className="size-3.5 shrink-0" />
                {warning.title}
              </span>
              <span className="block text-muted-foreground">
                {warning.body}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={onInstall}>
          <Plus className="size-4" />
          Install a new server
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Move an existing server into {clusterName}
        </DropdownMenuLabel>
        {options.length === 0 && (
          <DropdownMenuItem disabled>
            Every server is already here
          </DropdownMenuItem>
        )}
        {options.map((o) => (
          <SimpleTooltip
            key={o.serverId}
            content={o.blocked || `Move ${o.serverName} into ${clusterName}`}
            side="left"
          >
            <DropdownMenuItem
              disabled={Boolean(o.blocked)}
              onSelect={() => onPick(o)}
            >
              <ServerIcon className="size-4" />
              {o.serverName}
            </DropdownMenuItem>
          </SimpleTooltip>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
