import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases";
import { getDatabaseMetricsHistory } from "@/lib/data/container-metrics";
import { PageHeader } from "@/components/shared/page-header";
import { ContainerMonitoringDashboard } from "@/components/monitoring/container-monitoring-dashboard";

export const metadata = { title: "Monitoring" };

export default async function DatabaseMonitoringPage(
  props: PageProps<"/storage/databases/[id]/monitoring">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  // The buffered window, so the charts render full on the first paint. Nothing
  // gates it: the telemetry stream carries this database's container regardless.
  const initialHistory = await getDatabaseMetricsHistory(db.id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Monitoring"
        description="Real-time CPU, memory, network and disk I/O for this database's container."
      />
      <ContainerMonitoringDashboard
        kind="database"
        id={db.id}
        initialHistory={initialHistory}
        resources={db.resources}
      />
    </div>
  );
}
