import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getDatabase, getDatabaseVolumeBytes } from "@/lib/data/databases";
import { getDatabaseBackupSummary } from "@/lib/data/backups";
import { getDatabaseMetrics } from "@/lib/data/container-metrics";
import { getServerById } from "@/lib/data/servers";
import { canExposePorts, currentCapabilities } from "@/lib/membership";
import { listAllEnvironmentsForTeam } from "@/lib/data/environments";
import { DatabaseOverview } from "@/components/storage/database-overview";
import { DataStat } from "@/components/storage/database-stats";
import { DatabaseRelabelNotice } from "@/components/storage/database-health-stat";
import { DataCopyNotice } from "@/components/shared/data-copy-notice";
import type { ContainerMetrics } from "@/lib/data/container-metrics";
import type { DatabaseDTO } from "@/lib/data/databases";

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
  // Which apps the internal address answers for: a database is reachable by name
  // only from its own environment.
  const env = db.environmentId
    ? ((await listAllEnvironmentsForTeam()).find(
        (e) => e.id === db.environmentId,
      ) ?? null)
    : null;
  const environmentLabel = env ? `${env.projectName} / ${env.name}` : null;
  const monitoringHref = `/storage/databases/${db.id}/monitoring`;

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
        environmentLabel={environmentLabel}
        db={db}
        serverName={server?.name ?? db.serverId}
        serverHost={server?.host ?? server?.ip ?? ""}
        canReveal={can.has("reveal_secrets")}
        canConfigure={can.has("configure_databases")}
        canExposePorts={mayExposePorts}
        canViewBackups={can.has("manage_backups")}
        backups={backups}
        dataStat={
          // Measuring a volume WALKS it, so it streams in its own boundary
          // rather than holding the whole page behind a du.
          <Suspense
            fallback={
              <DataStat
                db={db}
                metrics={metrics}
                bytes={undefined}
                href={monitoringHref}
              />
            }
          >
            <DataStatLive db={db} metrics={metrics} href={monitoringHref} />
          </Suspense>
        }
      />
    </div>
  );
}

async function DataStatLive({
  db,
  metrics,
  href,
}: {
  db: DatabaseDTO;
  metrics: ContainerMetrics | null;
  href: string;
}) {
  return (
    <DataStat
      db={db}
      metrics={metrics}
      bytes={await getDatabaseVolumeBytes(db.id)}
      href={href}
    />
  );
}
