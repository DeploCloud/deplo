import { PageHeader } from "@/components/shared/page-header";
import { SaveMetricsMenu } from "@/components/monitoring/save-metrics-menu";
import { getMonitoringSettings } from "@/lib/data/monitoring-settings";
import { hasCapability } from "@/lib/membership";

export default async function MonitoringLayout(
  props: LayoutProps<"/[team]/monitoring">,
) {
  const [settings, canManage] = await Promise.all([
    getMonitoringSettings(),
    hasCapability("manage_monitoring"),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        docs="monitoring.overview"
        title="Monitoring"
        description="Real-time CPU, memory, disk and network across your servers."
        actions={
          <SaveMetricsMenu
            initialSaveMetrics={settings.saveMetrics}
            canManage={canManage}
          />
        }
      />
      {props.children}
    </div>
  );
}
