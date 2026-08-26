import { Database } from "lucide-react";
import { listDatabases } from "@/lib/data/databases";
import {
  destinationWhere,
  ensureDefaultDestination,
  listDestinations,
  toDestinationOption,
} from "@/lib/data/destinations";
import { listBackups } from "@/lib/data/backups";
import { listServersForCurrentTeam } from "@/lib/data/servers";
import { listApps } from "@/lib/data/apps";
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

export default async function StoragePage(props: PageProps<"/storage">) {
  // "New ▸ …" actions (the global context menu / Overview) link here with ?
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

  // Every section of this page is team-level: a database belongs to the team and to
  // no project, and so do the backup destinations and the fleet.
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

  // A team with no destination at all gets one pointing at a server it can reach.
  // Backups are the one feature where "first go sign up for a bucket" turns a
  // five-second decision into a project, and the fleet already has a disk.
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
    // Gates the "Expose publicly" toggle: only a user with the publish-ports
    // grant may open a database to the internet (same grant as an app's
    // compose `ports:`). Server-enforced too - this only hides the affordance.
    canExposePorts(),
    // Gates drag-to-reorder of the databases grid (persisted team-wide) - the
    // same capability every database mutation is gated on.
    hasCapability("configure_databases"),
    // The two bulk lifecycle actions on a multi-selection, each gated on exactly
    // the capability its mutation requires (the same one the card's own menu
    // uses) - without them the button is simply not on the selection bar.
    hasCapability("control_databases"),
    hasCapability("delete_databases"),
    // The three create surfaces of this page, each gated on exactly the capability its
    // mutation requires.
    hasCapability("create_databases"),
    hasCapability("manage_backup_destinations"),
    hasCapability("manage_backups"),
    hasCapability("restore_backups"),
    // A custom backup folder is an arbitrary absolute path on a shared host, so
    // it is an instance-level decision. Everyone else gets the managed folder,
    // which is what almost everyone wants anyway.
    isInstanceAdmin(),
  ]);

  // Only provisioned servers can host a database (provisioning routes through a live
  // agent). A storage-only host runs nothing, so it can never provision a database;
  // nor can a migration source, which is another platform's machine.
  const dbServers = servers
    .filter(
      (s) =>
        Boolean(s.agent?.certFingerprint) && !s.storageOnly && !s.importOnly,
    )
    .map((s) => ({ id: s.id, name: s.name }));
  // serverId → name, so a card can show which host each database runs on.
  const serverNames = Object.fromEntries(servers.map((s) => [s.id, s.name]));
  // A backup destination can live on ANY server the team reaches, including a
  // storage-only box that hosts nothing, which is exactly the point of one.
  const destinationServers = servers
    .filter((s) => Boolean(s.agent?.certFingerprint) && !s.importOnly)
    .map((s) => ({ id: s.id, name: s.name, storageOnly: s.storageOnly }));

  // Named once: the schedule dialog appears both in the toolbar and in the empty
  // state, and only one of the two is ever on screen.
  const createBackupProps = {
    databases: databases.map((d) => ({
      id: d.id,
      name: d.name,
      // The engine under the name, and the second thing the picker's search
      // matches on.
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
    <div className="space-y-6">
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

        {/* Databases */}
        <TabsContent value="databases" className="space-y-4">
          {/**
           * Creating a database closes the dialog at once and shows the card pulsing in the
           * grid while the host port is probed and the row is written; the real card then
           * takes over and reports provisioning live.
           */}
          <PendingCreateProvider count={databases.length}>
            <PendingList
              empty={databases.length === 0}
              emptyState={
                <EmptyState
                  graphic={<DatabaseGraphic />}
                  title="No databases yet"
                  docs="databases.overview"
                  // The toolbar that carries Create database is hidden while the
                  // list is empty, so the button lives here instead - exactly one
                  // at any moment. When the actor cannot create one, say which
                  // permission is missing rather than leaving them guessing.
                  description={
                    canCreateDatabase
                      ? "Create a managed database to connect to your apps."
                      : "You don't have permission to create databases. Ask a team admin for the “Create databases” permission."
                  }
                  action={
                    canCreateDatabase ? (
                      <CreateDatabase
                        servers={dbServers}
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
                // Remount only when the SET of databases changes (create/delete),
                // so a reorder, same set, never remounts and its optimistic
                // order survives the drop (mirrors the Overview grid's gridKey).
                key={[...databases.map((d) => d.id)].sort().join(",")}
                databases={databases}
                serverNames={serverNames}
                canReorder={canManageDatabases}
                // Same capability the reveal mutation is gated on: without it a
                // card shows the masked string and no reveal/copy affordance.
                canReveal={canManageDatabases}
                canControl={canControlDatabases}
                canDelete={canDeleteDatabases}
                createButton={
                  <CreateDatabase
                    servers={dbServers}
                    canCreate={canCreateDatabase}
                    canExposePorts={mayExposePorts}
                    autoOpen={autoOpenDatabase}
                  />
                }
              />
            </PendingList>
          </PendingCreateProvider>
        </TabsContent>

        {/* Destinations */}
        <TabsContent value="destinations" className="space-y-4">
          {/* Adding a destination closes the dialog at once and shows it pulsing
              in the grid while it is verified. Its own provider, so a pending
              database never leaks into this grid. */}
          <PendingCreateProvider count={destinations.length}>
            <PendingList
              empty={destinations.length === 0}
              emptyState={
                <EmptyState
                  graphic={<DestinationGraphic />}
                  title="No backup destinations"
                  docs="backups.destinations"
                  // The toolbar that carries Add destination is hidden while the
                  // list is empty, so the button lives here instead.
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

        {/* Backups */}
        <TabsContent value="backups" className="space-y-4">
          {backups.length === 0 ? (
            <EmptyState
              graphic={<BackupScheduleGraphic />}
              title="No backups scheduled"
              docs="backups.schedule"
              // The toolbar that carries Schedule backup is hidden while the list
              // is empty, so the button lives here instead.
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
