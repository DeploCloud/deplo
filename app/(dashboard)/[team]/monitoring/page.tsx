import { listServers } from "@/lib/data/servers/roster";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "@/lib/deploy/domains";
import {
  getFleetMetrics,
  getServerMetricsHistory,
} from "@/lib/data/monitoring";
import { Lock } from "lucide-react";
import { isInstanceAdmin, reachesWholeTeam } from "@/lib/membership";
import { EmptyState } from "@/components/shared/empty-state";
import { MonitoringDashboard } from "./monitoring-dashboard";

export const metadata = { title: "Monitoring" };

export default async function MonitoringPage() {
  // A narrowed role would otherwise get the error boundary the team-wide read throws.
  if (!(await reachesWholeTeam()))
    return (
      <EmptyState
        icon={Lock}
        title="Outside your access"
        docs="roles.floorCeiling"
        description="Your role reaches part of this team. The hosts belong to the whole of it."
      />
    );

  const [servers, fleet, canManageServers] = await Promise.all([
    listServers(),
    getFleetMetrics(),
    // The server pages are instance-admin only; without it the link would 404.
    isInstanceAdmin(),
  ]);

  // A synthetic snapshot from columns nothing writes rendered an online host as 0% CPU.
  const shown = servers.filter((s) => !s.importOnly);
  const selfAddrs = deploHostSelfAddresses();
  const initialHistory = shown[0]
    ? await getServerMetricsHistory(shown[0].id)
    : [];

  return (
    <MonitoringDashboard
      // No telemetry stream is opened to migration sources, so a row would read "No data".
      servers={shown.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        ip: s.ip,
        dockerVersion: s.dockerVersion,
        isDeploHost: isDeploHostServer(s, selfAddrs),
      }))}
      initialHistory={initialHistory}
      initialFleet={fleet}
      canManageServers={canManageServers}
    />
  );
}
