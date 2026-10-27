import * as React from "react";
import { DatabaseConnectionCard } from "@/components/storage/database-connection-card";
import { DatabaseConnectedApps } from "@/components/storage/database-connected-apps";
import { DatabaseHealthStat } from "@/components/storage/database-health-stat";
import { BackupsStat } from "@/components/storage/database-stats";
import type { DatabaseBackupSummary } from "@/lib/data/backups/run-listing";
import type { DatabaseDTO } from "@/lib/data/databases/rows";
import type { listDatabaseAppLinks } from "@/lib/data/database-links";
import type { EnvironmentOption } from "./environment-combobox";

export function DatabaseOverview({
  db,
  serverName,
  serverHost,
  canReveal,
  canConfigure,
  canExposePorts,
  canViewBackups,
  backups,
  dataStat,
  environmentLabel,
  environments,
  appLinks,
}: {
  db: DatabaseDTO;
  appLinks: Awaited<ReturnType<typeof listDatabaseAppLinks>>;
  serverName: string;
  serverHost: string;
  environmentLabel?: string | null;
  environments?: EnvironmentOption[];
  canReveal: boolean;
  canConfigure: boolean;
  canExposePorts: boolean;
  canViewBackups: boolean;
  backups: DatabaseBackupSummary;
  dataStat: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <DatabaseConnectionCard
        db={db}
        serverHost={serverHost}
        serverName={serverName}
        canReveal={canReveal}
        canConfigure={canConfigure}
        canExposePorts={canExposePorts}
        environmentLabel={environmentLabel}
        environments={environments ?? []}
      />

      {appLinks && (
        <DatabaseConnectedApps
          databaseId={db.id}
          databaseName={db.name}
          databaseType={db.type}
          links={appLinks.links}
          apps={appLinks.apps}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <DatabaseHealthStat id={db.id} status={db.status} />
        {dataStat}
        <BackupsStat
          summary={backups}
          href={
            canViewBackups ? `/storage/databases/${db.id}/backups` : undefined
          }
        />
      </div>
    </div>
  );
}
