import { notFound } from "next/navigation";
import type { ElementType } from "react";
import {
  Server as ServerIcon,
  Cpu,
  MemoryStick,
  HardDrive,
  Boxes,
  Network,
} from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { AddServer } from "@/components/servers/add-server";
import { ServerActions } from "@/components/servers/server-actions";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/ui/info-tip";
import { listAllServers, listAllServerTeamIds } from "@/lib/data/servers";
import { listAllTeamsForAdmin } from "@/lib/data/teams";
import { isInstanceAdmin } from "@/lib/membership";
import { hydrateServerSpecs } from "@/lib/data/monitoring";
import { serverLabel } from "@/lib/utils";
import {
  isAgentOutdated,
  reportedAgentVersion,
  resolveExpectedAgentVersion,
} from "@/lib/version";
import type { Server } from "@/lib/types";
import type { TeamOption } from "@/components/servers/server-team-access";
import { CheckUpdatesButton } from "./check-updates-button";
import { AgentVersionBadge } from "./agent-version-badge";
import { ServerHealthChip } from "./server-health-chip";
import {
  ServerHealthProvider,
  type ServerHealthState,
} from "./server-health-provider";
import { CheckStatusButton, CheckAllStatusButton } from "./check-status-button";

export const metadata = { title: "Servers" };

/** One hardware-spec tile: an icon + label over a big value + unit. */
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
    <div className="rounded-lg border border-border bg-muted/30 p-3">
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

function ServerCard({
  server,
  expectedAgentVersion,
  teams,
  accessTeamIds,
}: {
  server: Server;
  expectedAgentVersion: string;
  teams: TeamOption[];
  accessTeamIds: string[];
}) {
  const agentVersion = reportedAgentVersion(server);
  const outdated = isAgentOutdated(agentVersion, expectedAgentVersion);
  const accessLabel = server.allTeams
    ? "All teams"
    : `${accessTeamIds.length} team${accessTeamIds.length === 1 ? "" : "s"}`;
  // Specs are stored capacity (persisted from the agent); 0 means not-yet-measured
  // or unprovisioned — show an em dash rather than a misleading "0".
  const ramGb = server.memoryMb ? Math.round(server.memoryMb / 1024) : 0;
  const num = (n: number) => (n > 0 ? String(n) : "—");
  return (
    <Card className="transition-colors hover:border-foreground/20">
      <CardHeader className="space-y-3">
        <div className="flex items-center gap-2">
          {/* The chip owns BOTH the dot and the label: the status and its age are one
              fact, and splitting them across two elements is how a page ends up
              rendering a confident green dot next to a status nobody has verified. */}
          <CardTitle className="truncate">{serverLabel(server)}</CardTitle>
          <ServerHealthChip
            serverId={server.id}
            fallback={{
              status: server.status,
              checkedAt: server.statusCheckedAt ?? null,
              message: server.statusMessage ?? null,
            }}
          />
          <Badge variant="muted" title="Which teams can deploy to this server">
            {accessLabel}
          </Badge>
          {/* Every server is a bootstrapped agent now (the host running Deplo
              included), so the management actions apply to all of them. */}
          <div className="ml-auto flex items-center gap-1">
            <CheckStatusButton
              serverId={server.id}
              serverName={serverLabel(server)}
            />
            <ServerActions
              serverId={server.id}
              serverName={serverLabel(server)}
              provisioning={server.status === "provisioning"}
              outdated={outdated}
              expectedVersion={expectedAgentVersion}
              canManageInfra
              teams={teams}
              accessAllTeams={server.allTeams}
              accessTeamIds={accessTeamIds}
              deployConcurrency={server.deployConcurrency}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <span className="font-mono text-muted-foreground">{server.ip}</span>
          <Badge variant={server.traefikEnabled ? "success" : "muted"}>
            <Network className="size-3" />
            Traefik {server.traefikEnabled ? "on" : "off"}
          </Badge>
          <AgentVersionBadge
            version={agentVersion}
            expected={expectedAgentVersion}
            outdated={outdated}
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
        </div>
      </CardContent>
    </Card>
  );
}

export default async function ServersPage(
  props: PageProps<"/settings/servers">,
) {
  // Server administration is an instance-wide concern, and the management view
  // lists EVERY server (including ones restricted to other teams) — so it is
  // instance-admin-only, not the per-team manage_infra capability. Members reach
  // servers only through the team-scoped deploy pickers, never this page.
  if (!(await isInstanceAdmin())) notFound();

  // The global "New ▸ Add server" action links here with ?new=1 to open the
  // register dialog straight away.
  const { new: newParam } = await props.searchParams;
  const autoOpenServer =
    (Array.isArray(newParam) ? newParam[0] : newParam) === "1";

  const [serversRaw, expectedAgentVersion, serverTeamIds, teamsRaw] =
    await Promise.all([
      listAllServers(),
      resolveExpectedAgentVersion(),
      listAllServerTeamIds(),
      // The team list feeds the per-server "Team access" editor. Read it via the
      // instance-admin variant so it matches this page's admin-only gate — the
      // manage_infra-scoped listAllTeams would reject an admin who isn't a
      // manage_infra member of their active team.
      listAllTeamsForAdmin(),
    ]);
  // Fill in capacity specs for the static cards (measures an unmeasured server
  // once, then reuses the persisted values). No per-second polling anymore.
  const servers = await hydrateServerSpecs(serversRaw);
  const teams: TeamOption[] = teamsRaw.map((t) => ({ id: t.id, name: t.name }));

  // The LAST OBSERVED health of each server, handed to the client so the cards paint
  // immediately. It is a seed, not the answer: <ServerHealthProvider> re-probes every
  // agent on mount, and the chip refuses to paint any of this once it is stale. The
  // probe deliberately does NOT run here — dialing every agent inside the render would
  // make the one page an operator opens *because* a host is broken as slow as that
  // broken host, on every single load.
  const healthSeed: Record<string, ServerHealthState> = Object.fromEntries(
    servers.map((s) => [
      s.id,
      {
        status: s.status,
        checkedAt: s.statusCheckedAt ?? null,
        message: s.statusMessage ?? null,
      },
    ]),
  );

  return (
    <ServerHealthProvider seed={healthSeed}>
      <div className="space-y-6">
        {/* The install flow is explained ONCE, in the title's InfoTip — it used to live on
            the "Add a server" card, which is gone now that Add is a header action. It stays
            on the page (not inside the dialog) so an operator can read it before they click. */}
        <PageHeader
          title={
            <span className="flex items-center gap-2">
              Servers
              <InfoTip
                content={
                  <>
                    Start with <strong>this host</strong>: add it (use its IP),
                    then run the one-time install command it gives you on the box
                    to install the agent. Add more Linux hosts the same way. The
                    agent calls home and provisions itself — Deplo never needs
                    SSH access to your servers.
                  </>
                }
              />
            </span>
          }
          description="Connected Docker hosts running your deployments."
          actions={
            <>
              <CheckAllStatusButton />
              <CheckUpdatesButton />
              {/* The ONE mounted AddServer on this page: a second instance would also
                  answer ?new=1 and open two dialogs at once. */}
              <AddServer autoOpen={autoOpenServer} teams={teams} />
            </>
          }
        />

        {servers.length === 0 ? (
          <EmptyState
            icon={ServerIcon}
            title="No servers connected"
            description="Use Add above to register your first Linux host, then run the one-time install command it gives you on the box."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {servers.map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                expectedAgentVersion={expectedAgentVersion}
                teams={teams}
                accessTeamIds={serverTeamIds.get(server.id) ?? []}
              />
            ))}
          </div>
        )}
      </div>
    </ServerHealthProvider>
  );
}
