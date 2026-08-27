import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases";
import { getDatabaseBackupSummary } from "@/lib/data/backups";
import { getDatabaseMetrics } from "@/lib/data/container-metrics";
import { getServerById } from "@/lib/data/servers";
import { canExposePorts, currentCapabilities } from "@/lib/membership";
import { DatabaseOverview } from "@/components/storage/database-overview";
import { DataStat } from "@/components/storage/database-stats";
import { DatabaseRelabelNotice } from "@/components/storage/database-health-stat";
import { DataCopyNotice } from "@/components/shared/data-copy-notice";

export default async function DatabaseOverviewPage(
  props: PageProps<"/storage/databases/[id]">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  const [server, caps, mayExposePorts, backups, metrics] = await Promise.all([
    getServerById(db.serverId),
    // One membership read instead of four hasCapability() calls.
    currentCapabilities(),
    canExposePorts(),
    getDatabaseBackupSummary(db.id),
    // null when the viewer lacks view_metrics - that null IS the gate.
    getDatabaseMetrics(db.id),
  ]);
  const can = new Set(caps);

  return (
    <div className="space-y-6">
      {/* The data a migration could not bring. Above the overview because it is
          why Restart and Redeploy are refused, and because an engine started on
          the emptied volume does not fail - it initialises a new database. */}
      <DataCopyNotice
        kind="database"
        id={db.id}
        name={db.name}
        error={db.dataCopyError}
        canAccept={can.has("control_databases")}
      />
      <DatabaseRelabelNotice id={db.id} status={db.status} />
      <DatabaseOverview
        db={db}
        serverName={server?.name ?? db.serverId}
        serverHost={server?.host ?? server?.ip ?? ""}
        canReveal={can.has("reveal_secrets")}
        canConfigure={can.has("configure_databases")}
        canExposePorts={mayExposePorts}
        canViewBackups={can.has("manage_backups")}
        backups={backups}
        dataStat={
          <DataStat
            db={db}
            metrics={metrics}
            bytes={null}
            href={`/storage/databases/${db.id}/monitoring`}
          />
        }
      />
    </div>
  );
}
