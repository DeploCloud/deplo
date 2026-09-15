import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { hasAppCapability } from "@/lib/data/node-access";
import { hasCapability } from "@/lib/membership";
import { listBackupRuns } from "@/lib/data/backups/run-listing";
import { listBackups } from "@/lib/data/backups/schedules";
import { ensureDefaultDestination } from "@/lib/data/destinations/create";
import { listDestinationOptions } from "@/lib/data/destinations/listing";
import { BackupsPanel } from "@/components/storage/backups-panel/backups-panel";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata = { title: "Backups" };

export default async function AppBackupsPage(
  props: PageProps<"/[team]/apps/[slug]/backups">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  if (!(await hasAppCapability(project.id, "manage_backups"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to backups"
        docs="roles.floorCeiling"
        description="You don't have permission to manage this app's backups. Ask a team admin for the “Manage backups” permission."
      />
    );
  }

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
    listBackupRuns({ appId: project.id }),
    listDestinationOptions(),
    hasAppCapability(project.id, "restore_backups"),
    hasAppCapability(project.id, "delete_backups"),
    hasCapability("manage_backup_destinations"),
  ]);

  const schedules = allBackups.filter(
    (b) => b.targetKind === "app" && b.appId === project.id,
  );

  return (
    <BackupsPanel
      target={{
        kind: "app",
        id: project.id,
        name: project.name,
        serverId: project.serverId ?? null,
      }}
      schedules={schedules}
      runs={runs}
      destinations={destinations}
      canManage
      canRestore={canRestore}
      canDelete={canDelete}
      canTestDestinations={canTestDestinations}
    />
  );
}
