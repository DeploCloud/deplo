import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps";
import { getAppMetricsHistory } from "@/lib/data/container-metrics";
import { hasCapability } from "@/lib/membership";
import { PageHeader } from "@/components/shared/page-header";
import { ContainerMonitoringDashboard } from "@/components/monitoring/container-monitoring-dashboard";

export const metadata = { title: "Monitoring" };

export default async function AppMonitoringPage(
  props: PageProps<"/apps/[slug]/monitoring">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // History is empty unless this app opted in; the dashboard polls live values
  // every second regardless. `canManageInfra` cosmetically gates the switch —
  // the mutation enforces it server-side.
  const [initialHistory, canManageInfra] = await Promise.all([
    getAppMetricsHistory(project.id),
    hasCapability("manage_infra"),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Monitoring"
        description="Real-time CPU, memory, network and disk I/O for this app's containers."
      />
      <ContainerMonitoringDashboard
        kind="app"
        id={project.id}
        initialSaveMetrics={project.saveMetrics}
        initialHistory={initialHistory}
        canManageInfra={canManageInfra}
        resources={project.resources}
      />
    </div>
  );
}
