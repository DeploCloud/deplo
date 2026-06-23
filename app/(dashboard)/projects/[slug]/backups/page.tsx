import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getProjectBySlug } from "@/lib/data/projects";
import { hasCapability } from "@/lib/membership";
import { listBackups, listBackupRuns } from "@/lib/data/backups";
import { listS3 } from "@/lib/data/s3";
import { ProjectBackups } from "@/components/projects/project-backups";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata = { title: "Backups" };

export default async function ProjectBackupsPage(
  props: PageProps<"/projects/[slug]/backups">
) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  // Backup/restore are infra ops (overwrite-in-place); gate on manage_infra. The
  // tab is hidden without it, but guard the page too against a direct link.
  if (!(await hasCapability("manage_infra"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to backups"
        description="You don't have permission to manage this project's backups. Ask a team admin for the “Manage infrastructure” permission."
      />
    );
  }

  const [allBackups, runs, destinations] = await Promise.all([
    listBackups(),
    listBackupRuns({ projectId: project.id }),
    listS3(),
  ]);

  // Only this project's schedules — listBackups returns the whole team's.
  const schedules = allBackups.filter(
    (b) => b.targetKind === "project" && b.projectId === project.id,
  );

  return (
    <ProjectBackups
      projectId={project.id}
      projectName={project.name}
      schedules={schedules}
      runs={runs}
      destinations={destinations.map((d) => ({ id: d.id, name: d.name }))}
    />
  );
}
