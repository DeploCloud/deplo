import { Database } from "lucide-react";
import { listDatabases } from "@/lib/data/databases/rows";
import { ensureDefaultDestination } from "@/lib/data/destinations/create";
import {
  destinationWhere,
  toDestinationOption,
} from "@/lib/data/destinations/dto";
import { listDestinations } from "@/lib/data/destinations/listing";
import { listBackups } from "@/lib/data/backups/schedules";
import { listServersForCurrentTeam } from "@/lib/data/servers/roster";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "@/lib/deploy/domains";
import { listApps } from "@/lib/data/apps/listing";
import { listAllEnvironmentsForTeam } from "@/lib/data/environments";
import {
  canExposePorts,
  hasCapability,
  isInstanceAdmin,
  reachesWholeTeam,
} from "@/lib/membership";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import {
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { StorageTabs } from "@/components/storage/storage-tabs";
import { Badge } from "@/components/ui/badge";
import { CreateDatabase } from "@/components/storage/create-database";
import { DatabaseGraphic } from "@/components/storage/database-graphic";
import { DestinationGraphic } from "@/components/storage/destination-graphic";
import { BackupScheduleGraphic } from "@/components/storage/backup-schedule-graphic";
import { DatabasesGrid } from "@/components/storage/databases-grid";
import { CreateDestination } from "@/components/storage/create-destination";
import { DestinationsView } from "@/components/storage/destinations-view";
import { CreateBackup } from "@/components/storage/create-backup";
import { BackupsView } from "@/components/storage/backups-view";
import {
  PendingCreateProvider,
  PendingList,
} from "@/components/shared/pending-create";

export const metadata = { title: "Storage" };

export default async function StoragePage(props: PageProps<"/[team]/storage">) {
  const { new: newParam } = await props.searchParams;
  const newKind = Array.isArray(newParam) ? newParam[0] : newParam;
  const wantsDestination = newKind === "destination" || newKind === "s3";
  const autoOpenDatabase = newKind === "database";
  const autoOpenBackup = newKind === "backup";
  const initialTab = wantsDestination
    ? "destinations"
    : newKind === "backup"
      ? "backups"
      : "databases";

  if (!(await reachesWholeTeam()))
    return (
      <div className="space-y-6">
        <PageHeader
          docs="databases.overview"
          title="Storage"
          description="Databases, backup destinations and backups."
        />
        <EmptyState
          icon={Database}
          title="Outside your access"
          docs="roles.floorCeiling"
          description="Your role reaches part of this team. Databases and destinations belong to the whole of it."
        />
      </div>
    );

  await ensureDefaultDestination();

  const [
    databases,
    destinations,
    backups,
    servers,
    services,
    mayExposePorts,
    canManageDatabases,
    canControlDatabases,
    canDeleteDatabases,
    canCreateDatabase,
    canManageDestinations,
    canManageBackups,
    canRestoreBackups,
    mayUseCustomPath,
  ] = await Promise.all([
    listDatabases(),
    listDestinations(),
    listBackups(),
    listServersForCurrentTeam(),
    listApps(),
    canExposePorts(),
    hasCapability("configure_databases"),
    hasCapability("control_databases"),
    hasCapability("delete_databases"),
    hasCapability("create_databases"),
    hasCapability("manage_backup_destinations"),
    hasCapability("manage_backups"),
    hasCapability("restore_backups"),
    isInstanceAdmin(),
  ]);

  const selfAddrs = deploHostSelfAddresses();
  const dbServers = servers
    .filter(
      (s) =>
        Boolean(s.agent?.certFingerprint) && !s.storageOnly && !s.importOnly,
    )
    .map((s) => ({
      id: s.id,
      name: s.name,
      isDeploHost: isDeploHostServer(s, selfAddrs),
    }));
  const dbEnvironments = (await listAllEnvironmentsForTeam()).map((e) => ({
    id: e.id,
    name: e.name,
    projectId: e.projectId,
    projectName: e.projectName,
    projectColor: e.projectColor,
  }));
  const serverNames = Object.fromEntries(servers.map((s) => [s.id, s.name]));
  const destinationServers = servers
    .filter((s) => Boolean(s.agent?.certFingerprint) && !s.importOnly)
    .map((s) => ({
      id: s.id,
      name: s.name,
      storageOnly: s.storageOnly,
      isDeploHost: isDeploHostServer(s, selfAddrs),
    }));

  const createBackupProps = {
    databases: databases.map((d) => ({
      id: d.id,
      name: d.name,
      detail: d.type,
      type: d.type,
      logo: d.logo,
      serverId: d.serverId,
    })),
    services: services.map((p) => ({
      id: p.id,
      name: p.name,
      detail: p.slug,
      logo: p.logo,
      serverId: p.serverId,
    })),
    destinations: destinations.map(toDestinationOption),
    canCreate: canManageBackups,
    canTestDestinations: canManageDestinations,
    autoOpen: autoOpenBackup,
  };

  return (
    <div className="space-y-3">
      <PageHeader
        docs="databases.overview"
        title="Storage"
        description="Managed databases, backup destinations and scheduled backups."
      />

      <StorageTabs defaultTab={initialTab}>
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="databases">
            Databases
            <Badge variant="muted" className="ml-2">
              {databases.length}
            </Badge>
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="destinations">
            Destinations
            <Badge variant="muted" className="ml-2">
              {destinations.length}
            </Badge>
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="backups">
            Backups
            <Badge variant="muted" className="ml-2">
              {backups.length}
            </Badge>
          </UnderlineTabsTrigger>
        </UnderlineTabsList>

        <TabsContent value="databases" className="space-y-4">
          <PendingCreateProvider count={databases.length}>
            <PendingList
              empty={databases.length === 0}
              emptyState={
                <EmptyState
                  graphic={<DatabaseGraphic />}
                  title="No databases yet"
                  docs="databases.overview"
                  description={
                    canCreateDatabase
                      ? "Create a managed database to connect to your apps."
                      : "You don't have permission to create databases. Ask a team admin for the “Create databases” permission."
                  }
                  action={
                    canCreateDatabase ? (
                      <CreateDatabase
                        servers={dbServers}
                        environments={dbEnvironments}
                        canCreate={canCreateDatabase}
                        canExposePorts={mayExposePorts}
                        autoOpen={autoOpenDatabase}
                        size="sm"
                      />
                    ) : undefined
                  }
                />
              }
            >
              <DatabasesGrid
                key={[...databases.map((d) => d.id)].sort().join(",")}
                databases={databases}
                serverNames={serverNames}
                environments={dbEnvironments}
                canConfigure={canManageDatabases}
                canReorder={canManageDatabases}
                canReveal={canManageDatabases}
                canControl={canControlDatabases}
                canDelete={canDeleteDatabases}
                createButton={
                  <CreateDatabase
                    servers={dbServers}
                    environments={dbEnvironments}
                    canCreate={canCreateDatabase}
                    canExposePorts={mayExposePorts}
                    autoOpen={autoOpenDatabase}
                  />
                }
              />
            </PendingList>
          </PendingCreateProvider>
        </TabsContent>

        <TabsContent value="destinations" className="space-y-4">
          <PendingCreateProvider count={destinations.length}>
            <PendingList
              empty={destinations.length === 0}
              emptyState={
                <EmptyState
                  graphic={<DestinationGraphic />}
                  title="No backup destinations"
                  docs="backups.destinations"
                  description={
                    canManageDestinations
                      ? "Pick a server to keep backups on, or connect an S3 bucket."
                      : "You don't have permission to add backup destinations. Ask a team admin for the “Manage backup destinations” permission."
                  }
                  action={
                    canManageDestinations ? (
                      <CreateDestination
                        canCreate={canManageDestinations}
                        servers={destinationServers}
                        isInstanceAdmin={mayUseCustomPath}
                        autoOpen={wantsDestination}
                        size="sm"
                      />
                    ) : undefined
                  }
                />
              }
            >
              <DestinationsView
                destinations={destinations.map((dest) => ({
                  ...dest,
                  where: destinationWhere(dest),
                  freeBytes: dest.lastFreeBytes,
                  totalBytes: dest.lastTotalBytes,
                  encrypted: Boolean(dest.ageRecipient),
                }))}
                canManage={canManageDestinations}
                createButton={
                  <CreateDestination
                    canCreate={canManageDestinations}
                    servers={destinationServers}
                    isInstanceAdmin={mayUseCustomPath}
                    autoOpen={wantsDestination}
                  />
                }
              />
            </PendingList>
          </PendingCreateProvider>
        </TabsContent>

        <TabsContent value="backups" className="space-y-4">
          {backups.length === 0 ? (
            <EmptyState
              graphic={<BackupScheduleGraphic />}
              title="No backups scheduled"
              docs="backups.schedule"
              description={
                canManageBackups
                  ? "Schedule automatic backups of your databases and apps."
                  : "You don't have permission to schedule backups. Ask a team admin for the “Manage backups” permission."
              }
              action={
                canManageBackups ? (
                  <CreateBackup {...createBackupProps} size="sm" />
                ) : undefined
              }
            />
          ) : (
            <BackupsView
              backups={backups}
              destinations={destinations.map(toDestinationOption)}
              canManage={canManageBackups}
              canRestore={canRestoreBackups}
              canTestDestinations={canManageDestinations}
              createButton={<CreateBackup {...createBackupProps} />}
            />
          )}
        </TabsContent>
      </StorageTabs>
    </div>
  );
}
