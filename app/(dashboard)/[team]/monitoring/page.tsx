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
    isInstanceAdmin(),
  ]);

  const shown = servers.filter((s) => !s.importOnly);
  const selfAddrs = deploHostSelfAddresses();
  const initialHistory = shown[0]
    ? await getServerMetricsHistory(shown[0].id)
    : [];

  return (
    <MonitoringDashboard
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
