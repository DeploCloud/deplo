import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { hasAppCapability } from "@/lib/data/node-access";
import { hasCapability } from "@/lib/membership";
import { listBackups, listBackupRuns } from "@/lib/data/backups";
import {
  ensureDefaultDestination,
  listDestinationOptions,
} from "@/lib/data/destinations";
import { AppBackups } from "@/components/apps/app-backups";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata = { title: "Backups" };

export default async function AppBackupsPage(
  props: PageProps<"/apps/[slug]/backups">
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // Backup/restore are infra ops (overwrite-in-place); gate on manage_backups ON
  // THIS APP, which can be held here and nowhere else (ADR-0016). The tab is
  // hidden without it, but guard the page too against a direct link.
  if (!(await hasAppCapability(project.id, "manage_backups"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to backups"
        description="You don't have permission to manage this app's backups. Ask a team admin for the “Manage backups” permission."
      />
    );
  }

  // Same lazy default as the Storage page, because THIS is where someone most
  // often first wants a backup: arriving at an app's Backups tab and finding a
  // destination already there is the difference between one click and a detour.
  await ensureDefaultDestination();
  // `listDestinationOptions`, NOT `listDestinations`: the second is team-wide
  // only, and using it here meant a member scoped to one folder saw an empty
  // list - so every artifact read "Unknown destination", the download button
  // vanished, and the page claimed no destination was configured while
  // disabling the buttons that would have made one. They held `manage_backups`
  // on this app and had no way to use it.
  const [allBackups, runs, destinations, canTestDestinations] = await Promise.all([
    listBackups(),
    listBackupRuns({ appId: project.id }),
    listDestinationOptions(),
    hasCapability("manage_backup_destinations"),
  ]);

  // Only this app's schedules — listBackups returns the whole team's.
  const schedules = allBackups.filter(
    (b) => b.targetKind === "app" && b.appId === project.id,
  );

  return (
    // "Back up now" used to hold the dialog open for the WHOLE backup — minutes,
    // for a large volume. It now closes at once and the run appears here as the
    // real `running` row the executor records before the dump starts, which the
    // page re-reads on a timer until it settles.
    <AppBackups
      appId={project.id}
      serviceName={project.name}
      serverId={project.serverId ?? null}
      schedules={schedules}
      runs={runs}
      destinations={destinations}
      canTestDestinations={canTestDestinations}
    />
  );
}
