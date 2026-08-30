import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Server as ServerIcon } from "lucide-react";

import { DeploMark } from "@/components/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getServerById,
  getServerTeamIds,
  serverRole,
} from "@/lib/data/servers";
import { listAllTeamsForAdmin } from "@/lib/data/teams";
import { getCleanupPolicy, listCleanupRuns } from "@/lib/data/docker-cleanup";
import { isInstanceAdmin } from "@/lib/membership";
import { hydrateServerSpecs } from "@/lib/data/monitoring";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
  isLoopbackIp,
  nipDomain,
  randomWords,
  resolveServerIp,
} from "@/lib/deploy/domains";
import { serverLabel } from "@/lib/utils";
import {
  resolveExpectedAgentVersion,
  reportedAgentVersion,
  agentUpdateAvailable,
} from "@/lib/version";
import type { TeamOption } from "@/components/servers/server-team-access";
import {
  ServerHealthProvider,
  type ServerHealthState,
} from "../server-health-provider";
import { ServerHealthChip } from "../server-health-chip";
import { CheckStatusButton } from "../check-status-button";
import { ServerDetailTabs } from "./server-detail-tabs";
import { titleClass } from "@/components/shared/page-header";

export async function generateMetadata(
  props: PageProps<"/settings/servers/[id]">,
) {
  const { id } = await props.params;
  const server = await getServerById(id).catch(() => null);
  return { title: server ? `${serverLabel(server)} · Servers` : "Server" };
}

/**
 * One server's management page.
 */
export default async function ServerDetailPage(
  props: PageProps<"/settings/servers/[id]">,
) {
  // Instance-admin, like the list page and for the same reason: this view spans
  // servers restricted to other teams, and every action on it is host-wide.
  if (!(await isInstanceAdmin())) notFound();

  const { id } = await props.params;
  const server = await getServerById(id);
  if (!server) notFound();
  // A migration source has no management page.
  if (server.importOnly) notFound();

  const [expectedAgentVersion, teamIds, teamsRaw, policy, runs] =
    await Promise.all([
      resolveExpectedAgentVersion(),
      getServerTeamIds(id),
      listAllTeamsForAdmin(),
      getCleanupPolicy(),
      listCleanupRuns({ serverId: id }),
    ]);

  // Fills in capacity specs for a server that has never been measured, reusing
  // the same helper the list page uses; no per-second polling.
  const [hydrated] = await hydrateServerSpecs([server]);
  const isDeploHost = isDeploHostServer(server, deploHostSelfAddresses());
  const teams: TeamOption[] = teamsRaw.map((t) => ({ id: t.id, name: t.name }));
  const agentVersion = reportedAgentVersion(hydrated);

  // A working hostname for the Traefik panel that needs no DNS at all, the same
  // zero-config nip.io host an App's domains are offered. Null on a loopback-only
  // host, where such a name would resolve for nobody.
  // ponytail: suggested without knowing the host's ACME challenge - a proxy the
  // operator switched to DNS-01 only cannot validate a nip.io name and would serve a
  // self-signed cert for it.
  const serverIp = resolveServerIp(hydrated);
  const suggestedTraefikDomain = isLoopbackIp(serverIp)
    ? null
    : nipDomain("traefik", randomWords(), serverIp);

  const seed: Record<string, ServerHealthState> = {
    [server.id]: {
      status: server.status,
      checkedAt: server.statusCheckedAt ?? null,
      message: server.statusMessage ?? null,
      traefikEnabled: server.traefikEnabled,
      lastReachedAt: server.lastSeenAt ?? null,
    },
  };

  return (
    <ServerHealthProvider seed={seed}>
      {/* A settings detail page is forms and readouts, not a grid - it stays at a
          readable width like the App pages do, rather than the wide list shell. */}
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <div className="space-y-3">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 text-muted-foreground"
            asChild
          >
            <Link href="/settings/servers">
              <ArrowLeft className="size-4" />
              Servers
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className={titleClass.page}>{serverLabel(hydrated)}</h1>
            {isDeploHost ? (
              <Badge className="shrink-0 gap-1">
                <DeploMark size={12} className="text-current" />
                Deplo host
              </Badge>
            ) : (
              <Badge variant="muted" className="shrink-0 gap-1">
                <ServerIcon className="size-3" />
                Remote
              </Badge>
            )}
            <ServerHealthChip serverId={server.id} fallback={seed[server.id]} />
            <div className="ml-auto">
              <CheckStatusButton
                serverId={server.id}
                serverName={serverLabel(hydrated)}
              />
            </div>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {hydrated.ip}
          </p>
        </div>

        <ServerDetailTabs
          server={{
            id: hydrated.id,
            name: serverLabel(hydrated),
            ip: hydrated.ip,
            host: hydrated.host,
            agentPort: hydrated.agent?.port ?? null,
            status: hydrated.status,
            cpuCores: hydrated.cpuCores,
            memoryMb: hydrated.memoryMb,
            diskGb: hydrated.diskGb,
            dockerVersion: hydrated.dockerVersion,
            allTeams: hydrated.allTeams,
            deployConcurrency: hydrated.deployConcurrency,
            // Never "import": a migration source 404s above, so the summary's
            // three-role union still holds here.
            role: serverRole(hydrated) as "everything" | "build" | "storage",
            traefikDashboard: hydrated.traefikDashboard ?? null,
            suggestedTraefikDomain,
            isDeploHost,
            provisioning: hydrated.status === "provisioning",
            agentVersion,
            expectedAgentVersion,
            agentUpdateAvailable: agentUpdateAvailable(
              agentVersion,
              expectedAgentVersion,
            ),
          }}
          teams={teams}
          accessTeamIds={teamIds}
          cleanup={{
            policy,
            // This server's own sweeps. The policy stays instance-wide (it is one
            // row for the whole fleet); the tab says so where it is edited, and
            // only this host's membership, button and history are per-server.
            runs,
          }}
        />
      </div>
    </ServerHealthProvider>
  );
}
