import { listServers } from "@/lib/data/servers";
import { getInitialServerMetrics } from "@/lib/data/monitoring";
import { getMonitoringSettings } from "@/lib/data/monitoring-settings";
import { hasCapability } from "@/lib/membership";
import { PageHeader } from "@/components/shared/page-header";
import { MonitoringDashboard } from "./monitoring-dashboard";

export const metadata = { title: "Monitoring" };

export default async function MonitoringPage() {
  // Cheap last-known metrics so the page renders instantly; the dashboard polls
  // live values every second and replaces these (see ServerMetricsProvider).
  const [servers, initialMetrics, settings, canManageInfra] = await Promise.all([
    listServers(),
    getInitialServerMetrics(),
    getMonitoringSettings(),
    // Cosmetic gate for the "save metrics" switch; the mutation enforces it.
    hasCapability("manage_infra"),
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
        initialSaveMetrics={settings.saveMetrics}
        canManageInfra={canManageInfra}
      />
    </div>
  );
}
