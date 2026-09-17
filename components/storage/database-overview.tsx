import * as React from "react";
import { DatabaseConnectionCard } from "@/components/storage/database-connection-card";
import { DatabaseHealthStat } from "@/components/storage/database-health-stat";
import { BackupsStat } from "@/components/storage/database-stats";
import type { DatabaseBackupSummary } from "@/lib/data/backups/run-listing";
import type { DatabaseDTO } from "@/lib/data/databases/rows";

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
}: {
  db: DatabaseDTO;
  serverName: string;
  serverHost: string;
  environmentLabel?: string | null;
  environments?: { id: string; label: string }[];
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
