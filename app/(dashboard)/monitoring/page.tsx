import { listServers } from "@/lib/data/servers";
import { getInitialServerMetrics } from "@/lib/data/monitoring";
import { getMonitoringSettings } from "@/lib/data/monitoring-settings";
import { Lock } from "lucide-react";
import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { MonitoringDashboard } from "./monitoring-dashboard";

export const metadata = { title: "Monitoring" };

export default async function MonitoringPage() {
  // Cheap last-known metrics so the page renders instantly. MonitoringDashboard
  // replaces these on its first read of the control plane's ring buffer — which
  // the telemetry-stream supervisor keeps filled whether or not anyone is here,
  // so the charts usually arrive already full rather than drawing themselves in.
  // The fleet is team-level and has no per-project meaning, so a member limited
  // to part of the team reaches none of it — and this page IS the fleet. Saying
  // so beats handing them the error boundary the team-wide read would throw.
  if (!(await reachesWholeTeam()))
    return (
      <div className="space-y-6">
        <PageHeader
          title="Monitoring"
          description="Live CPU, memory, disk and network for every host."
        />
        <EmptyState
          icon={Lock}
          title="Outside your access"
          description="Your role reaches part of this team. The hosts belong to the whole of it."
        />
      </div>
    );

  const [servers, initialMetrics, settings, canManageInfra] = await Promise.all(
    [
      listServers(),
      getInitialServerMetrics(),
      getMonitoringSettings(),
      // Cosmetic gate for the "save metrics" switch; the mutation enforces it.
      hasCapability("manage_monitoring"),
    ],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Monitoring"
        description="Real-time CPU, memory, disk and network across your servers."
      />
      <MonitoringDashboard
        // Migration sources are not the fleet: no telemetry stream is opened to
        // them, so a row here could only ever read "No data".
        servers={servers
          .filter((s) => !s.importOnly)
          .map((s) => ({
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
