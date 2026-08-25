import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getDatabase } from "@/lib/data/databases";
import { hasCapability } from "@/lib/membership";
import { listBackups, listBackupRuns } from "@/lib/data/backups";
import {
  ensureDefaultDestination,
  listDestinationOptions,
} from "@/lib/data/destinations";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { BackupsPanel } from "@/components/storage/backups-panel";

export const metadata = { title: "Backups" };

export default async function DatabaseBackupsPage(
  props: PageProps<"/storage/databases/[id]/backups">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  // Backup/restore are infra ops (overwrite-in-place); gate on manage_backups. The
  // tab is hidden without it, but guard the page too against a direct link.
  if (!(await hasCapability("manage_backups"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to backups"
        docs="roles.floorCeiling"
        description="You don't have permission to manage this database's backups. Ask a team admin for the “Manage backups” permission."
      />
    );
  }

  // Same lazy default as the Storage page: a database's Backups tab should not
  // be the place someone discovers they have nowhere to put a backup.
  await ensureDefaultDestination();
  const [
    allBackups,
    runs,
    destinations,
    canRestore,
    canDelete,
    canTestDestinations,
  ] = await Promise.all([
    listBackups(),
    listBackupRuns({ databaseId: db.id }),
    listDestinationOptions(),
    hasCapability("restore_backups"),
    hasCapability("delete_backups"),
    hasCapability("manage_backup_destinations"),
  ]);
  // Only this database's schedules — listBackups returns the whole team's.
  const schedules = allBackups.filter(
    (b) => b.targetKind === "database" && b.databaseId === db.id,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        docs="backups.overview"
        title="Backups"
        description="Scheduled backups of this database to a backup destination, and restore."
      />
      <BackupsPanel
        target={{
          kind: "database",
          id: db.id,
          name: db.name,
          serverId: db.serverId ?? null,
        }}
        schedules={schedules}
        runs={runs}
        destinations={destinations}
        canManage
        canRestore={canRestore}
        canDelete={canDelete}
        canTestDestinations={canTestDestinations}
      />
    </div>
  );
}
