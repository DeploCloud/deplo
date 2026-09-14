import { notFound } from "next/navigation";
import Link from "@/components/ui/link";
import { Suspense, type ElementType } from "react";
import {
  Server as ServerIcon,
  Cpu,
  MemoryStick,
  HardDrive,
  Boxes,
  Settings2,
} from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { DeploMark } from "@/components/logo";
import { AddServer } from "@/components/servers/add-server";
import {
  ServerUseBadge,
  serverUse,
} from "@/components/servers/server-role-badge";
import {
  ServersList,
  type ServerListItem,
} from "@/components/servers/servers-list";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { CopyButton } from "@/components/shared/copy-button";
import { listAllServers } from "@/lib/data/servers/roster";
import { listAllServerTeamIds } from "@/lib/data/servers/team-access";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "@/lib/deploy/domains";
import { listAllTeamsForAdmin } from "@/lib/data/teams";
import { isInstanceAdmin } from "@/lib/membership";
import { hydrateServerSpecs } from "@/lib/data/monitoring";
import { serverLabel } from "@/lib/utils";
import { reportedAgentVersion } from "@/lib/version";
import type { Server } from "@/lib/types/server";
import type { TeamOption } from "@/components/servers/server-team-access";
import { AgentVersionBadge } from "./agent-version-badge";
import { ServerHealthChip } from "./server-health-chip";
import { ServerTraefikBadge } from "./server-traefik-badge";
import {
  ServerHealthProvider,
  type ServerHealthState,
} from "./server-health-provider";
import { CheckStatusButton, RefreshFleetButton } from "./check-status-button";

export const metadata = { title: "Servers" };

function Spec({
  icon: Icon,
  label,
  value,
  unit,
}: {
  icon: ElementType;
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

// Awaited behind the card's own <Suspense>: `hydrateServerSpecs` dials an unmeasured server and can take four seconds.
async function SpecTiles({ specs }: { specs: Promise<Server> }) {
  const server = await specs;
  // 0 means not-yet-measured or unprovisioned - show an em dash rather than a misleading "0".
  const ramGb = server.memoryMb ? Math.round(server.memoryMb / 1024) : 0;
  const num = (n: number) => (n > 0 ? String(n) : "—");
  return (
    <>
      <Spec
        icon={Cpu}
        label="CPU"
        value={num(server.cpuCores)}
        unit={server.cpuCores === 1 ? "core" : "cores"}
      />
      <Spec
        icon={MemoryStick}
        label="Memory"
        value={num(ramGb)}
        unit="GB RAM"
      />
      <Spec
        icon={HardDrive}
        label="Disk"
        value={num(server.diskGb)}
        unit="GB"
      />
      <Spec
        icon={Boxes}
        label="Docker"
        value={server.dockerVersion || "—"}
        unit="engine"
      />
    </>
  );
}

function SpecTilesSkeleton() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-surface p-3">
          <div className="flex items-center gap-1.5">
            <Skeleton className="size-3.5 rounded" />
            <Skeleton className="h-3 w-12" />
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <Skeleton className="h-5 w-8" />
            <Skeleton className="h-3 w-12" />
          </div>
        </div>
      ))}
    </>
  );
}

function ServerCard({
  server,
  specs,
  accessTeamIds,
  isDeploHost,
}: {
  server: Server;
  // Capacity measured, still in flight - everything else on the card reads `server`.
  specs: Promise<Server>;
  accessTeamIds: string[];
  // True for the ONE host that also runs the Deplo control plane, not just the deploy agent.
  isDeploHost: boolean;
}) {
  const agentVersion = reportedAgentVersion(server);
  const accessLabel = server.allTeams
    ? "All teams"
    : `${accessTeamIds.length} team${accessTeamIds.length === 1 ? "" : "s"}`;
  return (
    <Card className="transition-colors hover:border-foreground/20">
      <CardHeader className="space-y-3">
        {/* The name and its chips give ground, or a long name pushes Refresh and Manage onto their own line. */}
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* The chip owns both the dot and the label: split, a card paints a confident green dot next to an unverified status. */}
            <CardTitle className="min-w-0 truncate" title={serverLabel(server)}>
              {serverLabel(server)}
            </CardTitle>
            {/* Health leads every card, and is the only chip allowed to be green. */}
            <ServerHealthChip
              serverId={server.id}
              fallback={{
                status: server.status,
                checkedAt: server.statusCheckedAt ?? null,
                message: server.statusMessage ?? null,
                traefikEnabled: server.traefikEnabled,
                lastReachedAt: server.lastSeenAt ?? null,
              }}
            />
            {/* Only the control-plane host is badged: a chip every row wears says nothing. */}
            {isDeploHost && (
              <Badge
                className="shrink-0 gap-1"
                title="This host runs the Deplo control plane (the dashboard and API) in addition to your deployments. Removing it takes down Deplo itself."
              >
                {/* currentColor, so the mark takes the badge's primary-foreground. */}
                <DeploMark size={12} className="text-current" />
                Deplo host
              </Badge>
            )}
            {/* What the host is for, in its own colour. */}
            <ServerUseBadge use={serverUse(server)} />
            <Badge
              variant="muted"
              title="Which teams can deploy to this server"
            >
              {accessLabel}
            </Badge>
          </div>
          {/* The card stays a summary: everything you can do to a server lives on its own page. */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <CheckStatusButton
              serverId={server.id}
              serverName={serverLabel(server)}
            />
            <Button variant="outline" size="sm" asChild>
              <Link href={`/settings/servers/${server.id}`}>
                <Settings2 className="size-4" />
                Manage
              </Link>
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <span className="flex items-center gap-0.5">
            <span className="font-mono text-muted-foreground">{server.ip}</span>
            <CopyButton value={server.ip} className="size-6" />
          </span>
          {/* A stored traefikEnabled would keep claiming "on" for a host offline for weeks, so this reads the live
              observation. Only on a host that ROUTES: a build or backup server has no proxy on purpose. */}
          {serverUse(server) === "everything" && (
            <ServerTraefikBadge
              serverId={server.id}
              fallback={{
                status: server.status,
                checkedAt: server.statusCheckedAt ?? null,
                message: server.statusMessage ?? null,
                traefikEnabled: server.traefikEnabled,
                lastReachedAt: server.lastSeenAt ?? null,
              }}
            />
          )}
          <AgentVersionBadge version={agentVersion} />
        </div>
        {/* Deplo removes its own agent by itself, retrying for a few minutes, so the card says which state that is in. */}
        {server.uninstallPending && (
          <p className="text-xs text-muted-foreground">
            Deplo is removing its agent from this machine.
          </p>
        )}
        {server.uninstallError && (
          <p className="text-xs text-[var(--warning)]">
            Deplo could not remove its agent: {server.uninstallError}
          </p>
        )}
      </CardHeader>
      {/* A migration source is never measured, so four "—" tiles would only read as a broken card. */}
      {!server.importOnly && (
        <CardContent>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Suspense fallback={<SpecTilesSkeleton />}>
              <SpecTiles specs={specs} />
            </Suspense>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function ServerListRow({
  server,
  accessTeamIds,
  isDeploHost,
}: {
  server: Server;
  accessTeamIds: string[];
  isDeploHost: boolean;
}) {
  const health = {
    status: server.status,
    checkedAt: server.statusCheckedAt ?? null,
    message: server.statusMessage ?? null,
    traefikEnabled: server.traefikEnabled,
    lastReachedAt: server.lastSeenAt ?? null,
  };
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{serverLabel(server)}</span>
          {isDeploHost && (
            <Badge className="shrink-0 gap-1">
              <DeploMark size={12} className="text-current" />
              Deplo host
            </Badge>
          )}
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {server.ip}
        </span>
      </TableCell>
      <TableCell>
        <ServerHealthChip serverId={server.id} fallback={health} />
      </TableCell>
      <TableCell>
        <ServerUseBadge use={serverUse(server)} />
      </TableCell>
      <TableCell>
        {serverUse(server) === "everything" ? (
          <ServerTraefikBadge serverId={server.id} fallback={health} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <AgentVersionBadge version={reportedAgentVersion(server)} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {server.allTeams
          ? "All teams"
          : `${accessTeamIds.length} team${accessTeamIds.length === 1 ? "" : "s"}`}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <CheckStatusButton
            serverId={server.id}
            serverName={serverLabel(server)}
          />
          <Button variant="outline" size="sm" asChild>
            <Link href={`/settings/servers/${server.id}`}>
              <Settings2 className="size-4" />
              Manage
            </Link>
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export default async function ServersPage(
  props: PageProps<"/[team]/settings/servers">,
) {
  // This view lists EVERY server, including ones restricted to other teams, so it is instance-admin-only, not manage_infra.
  if (!(await isInstanceAdmin())) notFound();

  // The global "New ▸ Add server" action links here with ?new=1 to open the register dialog straight away.
  const { new: newParam } = await props.searchParams;
  const autoOpenServer =
    (Array.isArray(newParam) ? newParam[0] : newParam) === "1";

  const [serversRaw, serverTeamIds, teamsRaw] = await Promise.all([
    // A migration source is another platform's machine, borrowed for one import: the wizard that borrowed it owns it.
    listAllServers().then((all) => all.filter((s) => !s.importOnly)),
    listAllServerTeamIds(),
    // The instance-admin variant: manage_infra-scoped listAllTeams would reject an admin who isn't a manage_infra member of their active team.
    listAllTeamsForAdmin(),
  ]);
  // Deliberately NOT awaited: measuring dials the agent, and an unreachable host spends the full four-second cap.
  const measured = hydrateServerSpecs(serversRaw)
    .catch(() => serversRaw)
    .then((list) => new Map(list.map((s) => [s.id, s])));
  // `hydrateServerSpecs` never re-measures a server that already has capacity stored, so those tiles resolve with no placeholder.
  const specsFor = (server: Server) =>
    server.cpuCores > 0
      ? Promise.resolve(server)
      : measured.then((m) => m.get(server.id) ?? server);
  const teams: TeamOption[] = teamsRaw.map((t) => ({
    id: t.id,
    name: t.name,
    avatarUrl: t.avatarUrl,
  }));

  // The control-plane host sorts first; the remotes keep their creation order.
  const selfAddrs = deploHostSelfAddresses();
  const servers = [...serversRaw].sort(
    (a, b) =>
      Number(isDeploHostServer(b, selfAddrs)) -
      Number(isDeploHostServer(a, selfAddrs)),
  );

  // Cards are rendered HERE and handed to the client list: filtering must not cost them their RSC-ness.
  const items: ServerListItem[] = servers.map((server) => ({
    id: server.id,
    search: [server.name, server.host, server.ip].join(" ").toLowerCase(),
    use: serverUse(server),
    card: (
      <ServerCard
        server={server}
        specs={specsFor(server)}
        accessTeamIds={serverTeamIds.get(server.id) ?? []}
        isDeploHost={isDeploHostServer(server, selfAddrs)}
      />
    ),
    row: (
      <ServerListRow
        server={server}
        accessTeamIds={serverTeamIds.get(server.id) ?? []}
        isDeploHost={isDeploHostServer(server, selfAddrs)}
      />
    ),
  }));

  // A seed, not the answer: the provider re-probes on mount; dialing every agent in the render would make the page as slow as a broken host.
  const healthSeed: Record<string, ServerHealthState> = Object.fromEntries(
    servers.map((s) => [
      s.id,
      {
        status: s.status,
        checkedAt: s.statusCheckedAt ?? null,
        message: s.statusMessage ?? null,
        traefikEnabled: s.traefikEnabled,
        lastReachedAt: s.lastSeenAt ?? null,
      },
    ]),
  );

  return (
    <ServerHealthProvider seed={healthSeed}>
      <div className="space-y-6">
        {/* The install flow is explained once, on the page and not inside the dialog, so it can be read before clicking. */}
        <PageHeader
          docs="servers.overview"
          title={
            <span className="flex items-center gap-2">
              Servers
              <InfoTip
                content={
                  <>
                    Start with <strong>this host</strong>: add it (use its IP),
                    then run the one-time install command it gives you on the
                    box to install the agent. Add more Linux hosts the same way.
                    The agent calls home and provisions itself - Deplo never
                    needs SSH access to your servers.
                  </>
                }
              />
            </span>
          }
          description="Connected Docker hosts running your deployments."
          actions={
            <>
              <RefreshFleetButton />
              {/* The ONE mounted AddServer on this page: a second would also answer ?new=1 and open two dialogs. */}
              <AddServer autoOpen={autoOpenServer} teams={teams} />
            </>
          }
        />

        {items.length === 0 ? (
          <EmptyState
            icon={ServerIcon}
            title="No servers connected"
            docs="servers.add"
            description="Use Add above to register your first Linux host, then run the one-time install command it gives you on the box."
          />
        ) : (
          <ServersList items={items} />
        )}
      </div>
    </ServerHealthProvider>
  );
}
