import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { hasAppCapability } from "@/lib/data/node-access";
import { reachesWholeTeam } from "@/lib/membership";
import { listBackups, listBackupRuns } from "@/lib/data/backups";
import { listS3, toDestinationOption } from "@/lib/data/s3";
import { AppBackups } from "@/components/apps/app-backups";
import { PendingCreateProvider } from "@/components/shared/pending-create";
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

  // The team's S3 destinations are a team-wide read: a member limited to part of
  // the team keeps their app's backups and loses the list of places to send them
  // to, which the empty state below says rather than throwing.
  const wholeTeam = await reachesWholeTeam();
  const [allBackups, runs, destinations] = await Promise.all([
    listBackups(),
    listBackupRuns({ appId: project.id }),
    wholeTeam ? listS3() : Promise.resolve([]),
  ]);

  // Only this app's schedules — listBackups returns the whole team's.
  const schedules = allBackups.filter(
    (b) => b.targetKind === "app" && b.appId === project.id,
  );

  return (
    // "Back up now" used to hold the dialog open for the WHOLE backup — minutes,
    // for a large volume. It now closes at once and the artifact takes its place
    // in the table as a pulsing row for as long as the dump really runs.
    <PendingCreateProvider count={runs.length}>
      <AppBackups
        appId={project.id}
        serviceName={project.name}
        schedules={schedules}
        runs={runs}
        destinations={destinations.map(toDestinationOption)}
      />
    </PendingCreateProvider>
  );
}
