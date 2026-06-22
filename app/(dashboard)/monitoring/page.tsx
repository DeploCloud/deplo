import { listServers } from "@/lib/data/servers";
import { getInitialServerMetrics } from "@/lib/data/monitoring";
import { PageHeader } from "@/components/shared/page-header";
import { MonitoringDashboard } from "./monitoring-dashboard";

export const metadata = { title: "Monitoring" };

export default async function MonitoringPage() {
  // Cheap last-known metrics so the page renders instantly; the dashboard polls
  // live values every second and replaces these (see ServerMetricsProvider).
  const [servers, initialMetrics] = await Promise.all([
    listServers(),
    getInitialServerMetrics(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Monitoring"
        description="Real-time CPU, memory, disk and network across your servers."
      />
      <MonitoringDashboard
        servers={servers.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          ip: s.ip,
          dockerVersion: s.dockerVersion,
        }))}
        initialMetrics={initialMetrics}
      />
    </div>
  );
}
