import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { getAppMetricsHistory } from "@/lib/data/container-metrics";
import { hasAppCapability } from "@/lib/data/node-access";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SettingsShortcut } from "@/components/shared/settings-shortcut";
import { ContainerMonitoringDashboard } from "@/components/monitoring/container-monitoring-dashboard";

export const metadata = { title: "Monitoring" };

export default async function AppMonitoringPage(
  props: PageProps<"/apps/[slug]/monitoring">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // Held per app (ADR-0016), so ask at the app. The tab is hidden without it;
  // this is what a direct link lands on.
  if (!(await hasAppCapability(project.id, "view_metrics"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to monitoring"
        docs="roles.floorCeiling"
        description="You don't have permission to see this app's resource usage. Ask a team admin for the “View metrics” permission."
      />
    );
  }

  // The buffered window, so the charts render full on the first paint instead of
  // rebuilding themselves client-side.
  const initialHistory = await getAppMetricsHistory(project.id);

  return (
    <div className="space-y-5">
      <PageHeader
        level="section"
        docs="monitoring.overview"
        title="Monitoring"
        description="Real-time CPU, memory, network and disk I/O for this app's containers."
        actions={
          <SettingsShortcut
            href={`/apps/${slug}/settings/resources`}
            label="Resource limits"
          />
        }
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
