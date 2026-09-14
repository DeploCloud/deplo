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

  // Gate on manage_backups ON THIS APP (ADR-0016); the hidden tab is not the guard, a direct link needs this.
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
  // listDestinationOptions, NOT listDestinations: the team-wide one showed an empty list to a folder-scoped member.
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
    // On THIS app (ADR-0016), the same way the page's own gate is asked.
    hasAppCapability(project.id, "restore_backups"),
    hasAppCapability(project.id, "delete_backups"),
    hasCapability("manage_backup_destinations"),
  ]);

  // Only this app's schedules - listBackups returns the whole team's.
  const schedules = allBackups.filter(
    (b) => b.targetKind === "app" && b.appId === project.id,
  );

  return (
    // BackupsPanel renders the header too, shared with a database's Backups tab.
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
