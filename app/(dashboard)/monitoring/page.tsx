import { listServers } from "@/lib/data/servers";
import { getAllServerMetrics } from "@/lib/data/monitoring";
import { PageHeader } from "@/components/shared/page-header";
import { MonitoringDashboard } from "./monitoring-dashboard";

export const metadata = { title: "Monitoring" };

export default async function MonitoringPage() {
  const [servers, initialMetrics] = await Promise.all([
    listServers(),
    getAllServerMetrics(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Monitoring"
        description="Real-time CPU, memory, disk and network across your master and remote servers."
      />
      <MonitoringDashboard
        servers={servers.map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          status: s.status,
          ip: s.ip,
          dockerVersion: s.dockerVersion,
        }))}
        initialMetrics={initialMetrics}
      />
    </div>
  );
}
