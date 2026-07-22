import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { hasCapability } from "@/lib/membership";
import { listBackups, listBackupRuns } from "@/lib/data/backups";
import { listS3 } from "@/lib/data/s3";
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

  // Backup/restore are infra ops (overwrite-in-place); gate on manage_infra. The
  // tab is hidden without it, but guard the page too against a direct link.
  if (!(await hasCapability("manage_infra"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to backups"
        description="You don't have permission to manage this app's backups. Ask a team admin for the “Manage infrastructure” permission."
      />
    );
  }

  const [allBackups, runs, destinations] = await Promise.all([
    listBackups(),
    listBackupRuns({ appId: project.id }),
    listS3(),
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
        destinations={destinations.map((d) => ({ id: d.id, name: d.name }))}
      />
    </PendingCreateProvider>
  );
}
