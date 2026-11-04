import * as React from "react";
import { Activity, Archive, HardDrive } from "lucide-react";
import { Bone } from "@/components/ui/skeleton";
import {
  DatabaseConnectionCard,
  DatabaseConnectionCardSkeleton,
} from "@/components/storage/database-connection-card";
import {
  DatabaseConnectedApps,
  DatabaseConnectedAppsSkeleton,
} from "@/components/storage/database-connected-apps";
import { DatabaseHealthStat } from "@/components/storage/database-health-stat";
import { BackupsStat, StatCard } from "@/components/storage/database-stats";
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
    <OverviewStack>
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

      <StatsRow>
        <DatabaseHealthStat id={db.id} status={db.status} />
        {dataStat}
        <BackupsStat
          summary={backups}
          href={
            canViewBackups ? `/storage/databases/${db.id}/backups` : undefined
          }
        />
      </StatsRow>
    </OverviewStack>
  );
}

function OverviewStack({ children }: { children: React.ReactNode }) {
  return <div className="space-y-5">{children}</div>;
}

function StatsRow({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-3">{children}</div>;
}

export function DatabaseOverviewSkeleton({ id }: { id: string }) {
  return (
    <OverviewStack>
      <DatabaseConnectionCardSkeleton />
      <DatabaseConnectedAppsSkeleton />
      <StatsRow>
        <StatCard
          icon={Activity}
          label="Health"
          value={
            <span className="flex items-center gap-1.5">
              <Bone>Healthy</Bone>
            </span>
          }
          sub={
            <p>
              <Bone>No restarts</Bone>
            </p>
          }
        />
        <StatCard
          icon={HardDrive}
          label="Data"
          value={<Bone>120 MB</Bone>}
          sub={<p>on disk</p>}
          href={`/storage/databases/${id}/monitoring`}
        />
        <StatCard
          icon={Archive}
          label="Backups"
          value={<Bone>21h ago</Bone>}
          sub={<Bone>Daily, 03:00</Bone>}
          href={`/storage/databases/${id}/backups`}
        />
      </StatsRow>
    </OverviewStack>
  );
}
