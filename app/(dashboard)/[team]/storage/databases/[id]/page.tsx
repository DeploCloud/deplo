import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases/rows";
import { getDatabaseVolumeBytes } from "@/lib/data/databases/stack";
import { getDatabaseBackupSummary } from "@/lib/data/backups/run-listing";
import { getDatabaseMetrics } from "@/lib/data/container-metrics";
import { getServerById } from "@/lib/data/servers/roster";
import { canExposePorts, currentCapabilities } from "@/lib/membership";
import { listAllEnvironmentsForTeam } from "@/lib/data/environments";
import { DatabaseOverview } from "@/components/storage/database-overview";
import { DataStat } from "@/components/storage/database-stats";
import { DatabaseRelabelNotice } from "@/components/storage/database-health-stat";
import { DataCopyNotice } from "@/components/shared/data-copy-notice";
import type { ContainerMetrics } from "@/lib/data/container-metrics";
import type { DatabaseDTO } from "@/lib/data/databases/rows";

export default async function DatabaseOverviewPage(
  props: PageProps<"/[team]/storage/databases/[id]">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  const [server, caps, mayExposePorts, backups, metrics] = await Promise.all([
    getServerById(db.serverId),
    currentCapabilities(),
    canExposePorts(),
    getDatabaseBackupSummary(db.id),
    getDatabaseMetrics(db.id),
  ]);
  const can = new Set(caps);
  const allEnvs = await listAllEnvironmentsForTeam();
  const env = db.environmentId
    ? (allEnvs.find((e) => e.id === db.environmentId) ?? null)
    : null;
  const environmentLabel = env ? `${env.projectName} / ${env.name}` : null;
  const environments = allEnvs.map((e) => ({
    id: e.id,
    label: `${e.projectName} / ${e.name}`,
  }));
  const monitoringHref = `/storage/databases/${db.id}/monitoring`;

  return (
    <div className="space-y-6">
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
        environments={environments}
        db={db}
        serverName={server?.name ?? db.serverId}
        serverHost={server?.host ?? server?.ip ?? ""}
        canReveal={can.has("reveal_secrets")}
        canConfigure={can.has("configure_databases")}
        canExposePorts={mayExposePorts}
        canViewBackups={can.has("manage_backups")}
        backups={backups}
        dataStat={
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
