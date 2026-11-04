import { Suspense } from "react";
import { PageHeader } from "@/components/shared/page-header";
import {
  SaveMetricsMenu,
  SaveMetricsMenuSkeleton,
} from "@/components/monitoring/save-metrics-menu";
import { getMonitoringSettings } from "@/lib/data/monitoring-settings";
import { hasCapability } from "@/lib/membership";

// Sync on purpose: an awaiting layout sits outside its own loading.tsx.
export default function MonitoringLayout(
  props: LayoutProps<"/[team]/monitoring">,
) {
  return (
    <div className="space-y-6">
      <PageHeader
        docs="monitoring.overview"
        title="Monitoring"
        description="Real-time CPU, memory, disk and network across your servers."
        actions={
          <Suspense fallback={<SaveMetricsMenuSkeleton />}>
            <SaveMetrics />
          </Suspense>
        }
      />
      {props.children}
    </div>
  );
}

async function SaveMetrics() {
  const [settings, canManage] = await Promise.all([
    getMonitoringSettings(),
    hasCapability("manage_monitoring"),
  ]);
  return (
    <SaveMetricsMenu
      initialSaveMetrics={settings.saveMetrics}
      canManage={canManage}
    />
  );
}
