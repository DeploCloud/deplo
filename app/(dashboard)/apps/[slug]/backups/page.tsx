import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getServiceBySlug } from "@/lib/data/services";
import { hasCapability } from "@/lib/membership";
import { listBackups, listBackupRuns } from "@/lib/data/backups";
import { listS3 } from "@/lib/data/s3";
import { ServiceBackups } from "@/components/services/service-backups";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata = { title: "Backups" };

export default async function ServiceBackupsPage(
  props: PageProps<"/services/[slug]/backups">
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();

  // Backup/restore are infra ops (overwrite-in-place); gate on manage_infra. The
  // tab is hidden without it, but guard the page too against a direct link.
  if (!(await hasCapability("manage_infra"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to backups"
        description="You don't have permission to manage this service's backups. Ask a team admin for the “Manage infrastructure” permission."
      />
    );
  }

  const [allBackups, runs, destinations] = await Promise.all([
    listBackups(),
    listBackupRuns({ serviceId: project.id }),
    listS3(),
  ]);

  // Only this service's schedules — listBackups returns the whole team's.
  const schedules = allBackups.filter(
    (b) => b.targetKind === "service" && b.serviceId === project.id,
  );

  return (
    <ServiceBackups
      serviceId={project.id}
      serviceName={project.name}
      schedules={schedules}
      runs={runs}
      destinations={destinations.map((d) => ({ id: d.id, name: d.name }))}
    />
  );
}
