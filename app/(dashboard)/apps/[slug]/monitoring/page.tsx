import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps";
import { getAppMetricsHistory } from "@/lib/data/container-metrics";
import { PageHeader } from "@/components/shared/page-header";
import { ContainerMonitoringDashboard } from "@/components/monitoring/container-monitoring-dashboard";

export const metadata = { title: "Monitoring" };

export default async function AppMonitoringPage(
  props: PageProps<"/apps/[slug]/monitoring">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // The buffered window, so the charts render full on the first paint instead of
  // rebuilding themselves client-side. No opt-in gates it: the telemetry stream
  // carries every container on the host, so history exists for this app whether
  // or not anyone asked for it.
  const initialHistory = await getAppMetricsHistory(project.id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Monitoring"
        description="Real-time CPU, memory, network and disk I/O for this app's containers."
      />
      <ContainerMonitoringDashboard
        kind="app"
        id={project.id}
        initialHistory={initialHistory}
        resources={project.resources}
      />
    </div>
  );
}
